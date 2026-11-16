use crate::catalog::{http_client, is_scryfall_url, open_pool};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use sqlx::Row;
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
static IMAGE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);
static LAST_REQUEST: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

#[tauri::command]
pub async fn resolve_card_image(
    app: AppHandle,
    card_id: String,
    image_cache_dir: String,
    face: String,
) -> Result<String, String> {
    if face != "front" && face != "back" {
        return Err("Choose a front or back card face.".into());
    }
    if card_id.is_empty()
        || card_id.len() > 100
        || !card_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid printing identifier.".into());
    }
    let pool = open_pool(&app).await?;
    let row=sqlx::query("SELECT c.name,c.set_code,c.set_name,c.collector_number,c.metadata_json,c.image_uri,c.back_image_uri,(SELECT COUNT(*) FROM cards p WHERE p.name=c.name AND p.set_code=c.set_code) AS print_count FROM cards c WHERE c.id=?")
        .bind(&card_id).fetch_optional(&pool).await.map_err(|e|e.to_string())?.ok_or("Card printing is not in the local catalog.")?;
    let image_uri: Option<String> = row.get(if face == "back" {
        "back_image_uri"
    } else {
        "image_uri"
    });
    let name: String = row.get("name");
    let set_code: String = row.get("set_code");
    let set_name: String = row.get("set_name");
    let collector: String = row.get("collector_number");
    let metadata: String = row.get("metadata_json");
    let count: i64 = row.get("print_count");
    let settings: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key='app'")
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?;
    let install_hint = settings
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|s| {
            s.get("forge")
                .and_then(|f| f.get("installDir"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let local = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("card-images")
        .join(&card_id)
        .join(format!("{face}.img"));
    let _slot = IMAGE_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        // Collector numbers resolve through the installed Forge edition
        // catalog. Code2 and art indexes can differ from Scryfall's values.
        let face_name = face_name(&name, &metadata, &face);
        let mapping = crate::decks::resolve_printing_with_hint(
            &name,
            &set_code,
            &set_name,
            &collector,
            install_hint.as_deref(),
        );
        let cache_name = mws_name(if face == "front" {
            mapping
                .as_ref()
                .map(|p| p.cache_name.as_str())
                .unwrap_or(&face_name)
        } else {
            &face_name
        });
        let shared_target = mapping.as_ref().and_then(|printing| {
            find_forge_image(
                Path::new(&image_cache_dir),
                &printing.cache_folder,
                &cache_name,
                printing.art_index,
            )
            .or_else(|| {
                find_forge_image(
                    Path::new(&image_cache_dir),
                    &printing.set_code,
                    &cache_name,
                    printing.art_index,
                )
            })
        });
        if let Some(path) = shared_target {
            if let Ok(data) = read_data_url(&path) {
                return Ok(data);
            }
        }
        if mapping.is_none() && count == 1 {
            if let Some(path) =
                find_forge_image(Path::new(&image_cache_dir), &set_code, &face_name, 1)
            {
                if let Ok(data) = read_data_url(&path) {
                    return Ok(data);
                }
            }
        }
        if local.is_file() {
            if let Ok(bytes) = read_image_bytes(&local) {
                if let Ok(data) = bytes_data_url(&bytes) {
                    if let Some(printing) = &mapping {
                        let _ = share_with_forge(
                            Path::new(&image_cache_dir),
                            printing,
                            &cache_name,
                            &bytes,
                        );
                    }
                    return Ok(data);
                }
            }
        }
        let image_uri = image_uri.ok_or("Scryfall has no image for this card face.")?;
        let url = reqwest::Url::parse(&image_uri).map_err(|e| e.to_string())?;
        if !is_scryfall_url(&url) || url.host_str() != Some("cards.scryfall.io") {
            return Err("The catalog contains an unsupported card-image host.".into());
        }
        {
            let mut last = LAST_REQUEST
                .lock()
                .map_err(|_| "Image request limiter is unavailable.")?;
            if let Some(start) = *last {
                let elapsed = start.elapsed();
                if elapsed < Duration::from_millis(120) {
                    std::thread::sleep(Duration::from_millis(120) - elapsed);
                }
            }
            *last = Some(Instant::now());
        }
        let response = http_client()?
            .get(url)
            .header(
                reqwest::header::ACCEPT,
                "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.8",
            )
            .timeout(Duration::from_secs(30))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Image is not cached and could not be downloaded: {e}"))?;
        if response
            .content_length()
            .is_some_and(|n| n > MAX_IMAGE_BYTES)
        {
            return Err("Card image exceeds 10 MB.".into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let data = bytes_data_url(&bytes)?;
        let directory = local.parent().ok_or("Cannot locate card image cache.")?;
        fs::create_dir_all(directory)
            .map_err(|e| format!("Cannot create local image cache: {e}"))?;
        let temp = directory.join(format!(
            "{face}-{}.part",
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = File::create(&temp).map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            if local.is_file() && read_data_url(&local).is_ok() {
                let _ = fs::remove_file(&temp);
            } else {
                if local.is_file() {
                    fs::remove_file(&local).map_err(|e| e.to_string())?;
                }
                fs::rename(&temp, &local).map_err(|e| e.to_string())?;
            }
            Ok::<_, String>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
        if let Some(printing) = &mapping {
            let _ = share_with_forge(Path::new(&image_cache_dir), printing, &cache_name, &bytes);
        }
        Ok(data)
    })
    .await
    .map_err(|e| format!("Image loading could not finish: {e}"))?
}

fn face_name(name: &str, metadata: &str, face: &str) -> String {
    let parsed = serde_json::from_str::<Value>(metadata).unwrap_or(Value::Null);
    if let Some(faces) = parsed.get("card_faces").and_then(Value::as_array) {
        if let Some(face) = faces.get(if face == "back" { 1 } else { 0 }) {
            if let Some(name) = face.get("name").and_then(Value::as_str) {
                return name.to_owned();
            }
        }
    }
    name.split(" // ").next().unwrap_or(name).to_string()
}

fn safe_component(value: &str) -> Option<String> {
    if value.is_empty() || value.contains(['/', '\\', '\0']) || value == "." || value == ".." {
        return None;
    }
    Some(value.replace(':', ""))
}

fn mws_name(value: &str) -> String {
    value
        .nfd()
        .filter(|c| !is_combining_mark(*c) && !matches!(c, '"' | '/' | ':' | '?'))
        .collect()
}

/// Sharing is best-effort and only uses an exact installed-edition mapping.
/// Existing Forge files are never overwritten, including corrupt files.
fn share_with_forge(
    root: &Path,
    printing: &crate::decks::ForgePrinting,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let extension = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "jpg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else {
        return Ok(());
    };
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let set = safe_component(&printing.cache_folder).ok_or("Unknown Forge cache folder.")?;
    let name = safe_component(name).ok_or("Unknown Forge image filename.")?;
    let directory = root.join(set);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let directory = directory.canonicalize().map_err(|e| e.to_string())?;
    if !directory.starts_with(&root) {
        return Err("Forge image folder is outside the chosen cache.".into());
    }
    let suffix = if printing.art_count > 1 {
        printing.art_index.to_string()
    } else {
        String::new()
    };
    let path = directory.join(format!("{name}{suffix}.fullborder.{extension}"));
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            if let Err(error) = file.write_all(bytes) {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(error.to_string());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn find_forge_image(root: &Path, set_code: &str, name: &str, art_index: u32) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let name = safe_component(name)?;
    let set = safe_component(&set_code.to_uppercase())?;
    let names = if art_index == 1 {
        vec![format!("{name}1"), name.clone()]
    } else {
        vec![format!("{name}{art_index}")]
    };
    for folder in [root.join(&set), root.join(set_code)] {
        for name in &names {
            for suffix in [
                ".fullborder.jpg",
                ".full.jpg",
                ".fullborder.png",
                ".full.png",
            ] {
                let path = folder.join(format!("{name}{suffix}"));
                if let Ok(canonical) = path.canonicalize() {
                    if canonical.starts_with(&root) && canonical.is_file() {
                        return Some(canonical);
                    }
                }
            }
        }
    }
    None
}

fn read_data_url(path: &Path) -> Result<String, String> {
    bytes_data_url(&read_image_bytes(path)?)
}

fn read_image_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_IMAGE_BYTES {
        return Err("Card image exceeds 10 MB.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn bytes_data_url(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("Card image exceeds 10 MB.".into());
    }
    let mime = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("Cached or downloaded card image is not a JPG, PNG, or WebP.".into());
    };
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Cannot inspect card image: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| format!("Card image is corrupt or exceeds supported dimensions: {e}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_lookup_is_set_specific_and_contained() {
        let cache = tempfile::tempdir().unwrap();
        let folder = cache.path().join("AER");
        fs::create_dir(&folder).unwrap();
        let image = folder.join("Aid from the Cowl.fullborder.jpg");
        fs::write(&image, [0xff, 0xd8, 0xff]).unwrap();
        assert_eq!(
            find_forge_image(cache.path(), "aer", "Aid from the Cowl", 1).unwrap(),
            image.canonicalize().unwrap()
        );
        assert!(find_forge_image(cache.path(), "other", "Aid from the Cowl", 1).is_none());
        assert!(find_forge_image(cache.path(), "../AER", "Aid from the Cowl", 1).is_none());
        assert!(find_forge_image(cache.path(), "AER", "../Aid from the Cowl", 1).is_none());
    }
    #[test]
    fn image_faces_and_data_are_validated() {
        assert_eq!(
            face_name(
                "Front // Back",
                r#"{"card_faces":[{"name":"Front"},{"name":"Back"}]}"#,
                "back"
            ),
            "Back"
        );
        assert!(bytes_data_url(b"<html>error</html>").is_err());
        assert!(bytes_data_url(b"\x89PNG\r\n\x1a\nmore").is_err());
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        assert!(bytes_data_url(png.get_ref())
            .unwrap()
            .starts_with("data:image/png;"));
    }
    #[test]
    fn exact_forge_sharing_does_not_overwrite() {
        let cache = tempfile::tempdir().unwrap();
        let printing = crate::decks::ForgePrinting {
            name: "Élf".into(),
            set_code: "TST".into(),
            collector_number: "2".into(),
            cache_folder: "TS".into(),
            art_index: 2,
            art_count: 2,
            cache_name: "Élf".into(),
        };
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        share_with_forge(
            cache.path(),
            &printing,
            &mws_name(&printing.cache_name),
            png.get_ref(),
        )
        .unwrap();
        let path = cache.path().join("TS").join("Elf2.fullborder.png");
        assert_eq!(fs::read(&path).unwrap(), png.into_inner());
        share_with_forge(
            cache.path(),
            &printing,
            "Elf",
            b"\x89PNG\r\n\x1a\nbad replacement",
        )
        .unwrap();
        assert!(read_data_url(&path).is_ok());
    }
}
