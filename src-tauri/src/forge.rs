use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgePaths {
    pub data_dir: String,
    pub deck_dir: String,
    pub image_cache_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationReport {
    pub install_dir_exists: bool,
    pub data_dir_exists: bool,
    pub deck_dir_exists: bool,
    pub image_cache_dir_exists: bool,
    pub sample_image_path: Option<String>,
    pub sample_deck_path: Option<String>,
    pub warnings: Vec<String>,
    pub forge_version: Option<String>,
    pub forge_install_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub content: String,
}

/// Detect conventional Forge paths without creating or changing any Forge files.
#[tauri::command]
pub fn detect_forge_paths() -> ForgePaths {
    let profile = if cfg!(windows) {
        env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))
    } else {
        env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"))
    }
    .map(PathBuf::from)
    .unwrap_or_default();
    let (data, cache) = default_forge_directories(
        env::consts::OS,
        &profile,
        env::var_os("APPDATA").map(PathBuf::from),
        env::var_os("LOCALAPPDATA").map(PathBuf::from),
    );
    let installation = detected_installation(None);
    ForgePaths {
        deck_dir: display_path(&data.join("decks").join("constructed")),
        data_dir: display_path(&data),
        image_cache_dir: display_path(&cache.join("pics").join("cards")),
        install_dir: installation.map(|(path, _)| display_path(&path)),
    }
}

fn default_forge_directories(
    os: &str,
    profile: &Path,
    roaming: Option<PathBuf>,
    local: Option<PathBuf>,
) -> (PathBuf, PathBuf) {
    match os {
        "windows" => {
            let roaming = roaming.unwrap_or_else(|| profile.join("AppData").join("Roaming"));
            let local = local.unwrap_or_else(|| profile.join("AppData").join("Local"));
            (roaming.join("Forge"), local.join("Forge").join("Cache"))
        }
        "macos" => (
            profile
                .join("Library")
                .join("Application Support")
                .join("Forge"),
            profile.join("Library").join("Caches").join("Forge"),
        ),
        _ => (profile.join(".forge"), profile.join(".cache").join("forge")),
    }
}

fn same_default_directory(selected: &str, standard: &str, windows: bool) -> bool {
    let normalize = |value: &str| {
        if windows {
            value
                .trim()
                .trim_end_matches(['/', '\\'])
                .replace('/', "\\")
                .to_lowercase()
        } else {
            value.trim().trim_end_matches('/').to_owned()
        }
    };
    normalize(selected) == normalize(standard)
}

#[tauri::command]
pub async fn test_forge_integration(paths: ForgePaths) -> Result<IntegrationReport, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_forge(&paths))
        .await
        .map_err(|e| format!("Forge folder check could not finish: {e}"))?
}

fn inspect_forge(paths: &ForgePaths) -> Result<IntegrationReport, String> {
    inspect_forge_with_defaults(paths, &detect_forge_paths())
}

fn inspect_forge_with_defaults(
    paths: &ForgePaths,
    defaults: &ForgePaths,
) -> Result<IntegrationReport, String> {
    // Legacy parent path is retained for older saved settings, but connection
    // setup is determined by the three explicit installation/deck/image paths.
    let data = PathBuf::from(paths.data_dir.trim());
    let decks = absolute_path(&paths.deck_dir, "Deck export folder")?;
    let images = absolute_path(&paths.image_cache_dir, "Image cache folder")?;
    let installation = match paths
        .install_dir
        .as_deref()
        .filter(|hint| !hint.trim().is_empty())
    {
        Some(hint) => {
            let install = absolute_path(hint, "Forge installation folder")?;
            (install.join("res").join("editions").is_dir()
                && install.join("res").join("cardsfolder").is_dir())
            .then(|| {
                let version = installation_version(&install);
                (install, version)
            })
        }
        None => detected_installation(None),
    };
    if installation.is_some() {
        prepare_default_directories(paths, defaults)?;
    }
    let mut warnings = Vec::new();
    let data_dir_exists = data.is_absolute() && data.is_dir();
    let deck_dir_exists = decks.is_dir();
    let image_cache_dir_exists = images.is_dir();
    if installation.is_none() {
        warnings.push(
            "Forge installation was not found. Select its installation folder in Settings."
                .to_string(),
        );
    }
    if !deck_dir_exists {
        warnings
            .push("Deck folder was not found. Select an existing folder in Settings.".to_string());
    }
    if !image_cache_dir_exists {
        warnings.push(
            "Forge image cache was not found. Select its pics/cards folder in Settings."
                .to_string(),
        );
    }

    let sample_image_path = if image_cache_dir_exists {
        find_sample(&images, 3, is_image_extension).map(|p| display_path(&p))
    } else {
        None
    };
    let sample_deck_path = if deck_dir_exists {
        find_sample(&decks, 1, |p| extension(p) == "dck").map(|p| display_path(&p))
    } else {
        None
    };

    Ok(IntegrationReport {
        install_dir_exists: installation.is_some(),
        data_dir_exists,
        deck_dir_exists,
        image_cache_dir_exists,
        sample_image_path,
        sample_deck_path,
        warnings,
        forge_version: installation
            .as_ref()
            .and_then(|(_, version)| version.clone()),
        forge_install_dir: installation.map(|(path, _)| display_path(&path)),
    })
}

fn detected_installation(hint: Option<&str>) -> Option<(PathBuf, Option<String>)> {
    let mut installations: Vec<_> = crate::decks::resource_candidates(hint)
        .into_iter()
        .filter_map(|resource| {
            if !resource.join("editions").is_dir() || !resource.join("cardsfolder").is_dir() {
                return None;
            }
            let install = resource.parent()?.to_path_buf();
            let version = installation_version(&install);
            Some((install, version))
        })
        .collect();
    installations.sort_by_key(|(path, version)| {
        let numeric: Vec<u64> = version
            .as_deref()
            .unwrap_or_default()
            .split('-')
            .next()
            .unwrap_or_default()
            .split('.')
            .filter_map(|part| part.parse().ok())
            .collect();
        let modified = fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok();
        (numeric, modified)
    });
    installations.pop()
}

pub(crate) fn prepare_standard_directories(paths: &ForgePaths) -> Result<(), String> {
    prepare_default_directories(paths, &detect_forge_paths())
}

fn prepare_default_directories(paths: &ForgePaths, defaults: &ForgePaths) -> Result<(), String> {
    for (selected, standard) in [
        (&paths.deck_dir, &defaults.deck_dir),
        (&paths.image_cache_dir, &defaults.image_cache_dir),
    ] {
        if same_default_directory(selected, standard, cfg!(windows)) {
            fs::create_dir_all(selected.trim()).map_err(|error| {
                format!("Cannot prepare Forge's standard folder {selected}: {error}")
            })?;
        }
    }
    Ok(())
}

fn jar_version(filename: &str) -> Option<String> {
    let version = filename
        .strip_prefix("forge-gui-desktop-")?
        .strip_suffix("-jar-with-dependencies.jar")?;
    let numeric = version.split('-').next()?;
    let parts: Vec<_> = numeric.split('.').collect();
    if parts.len() < 3
        || !parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return None;
    }
    Some(version.to_string())
}

fn installation_version(install: &Path) -> Option<String> {
    let mut jars: Vec<_> = fs::read_dir(install)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("forge-gui-desktop")
        })
        .take(100)
        .collect();
    jars.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    for entry in jars.into_iter().rev() {
        if let Some(version) = jar_version(&entry.file_name().to_string_lossy()) {
            return Some(version);
        }
        let Ok(file) = fs::File::open(entry.path()) else {
            continue;
        };
        let Ok(mut archive) = zip::ZipArchive::new(file) else {
            continue;
        };
        let Ok(mut manifest) = archive.by_name("META-INF/MANIFEST.MF") else {
            continue;
        };
        if manifest.size() > 64 * 1024 {
            continue;
        }
        let mut text = String::new();
        if manifest.read_to_string(&mut text).is_err() {
            continue;
        }
        if let Some(version) = text
            .lines()
            .find_map(|line| {
                line.strip_prefix("Implementation-Version: ")
                    .or_else(|| line.strip_prefix("Bundle-Version: "))
            })
            .map(str::trim)
            .filter(|version| !version.is_empty() && version.len() <= 80)
        {
            return Some(version.to_string());
        }
    }
    None
}

/// A bounded scan skips symbolic links and never follows an entry outside the chosen cache.
fn find_sample(root: &Path, max_depth: usize, accepts: fn(&Path) -> bool) -> Option<PathBuf> {
    let mut remaining = MAX_SCAN_ENTRIES;
    fn visit(
        dir: &Path,
        depth: usize,
        remaining: &mut usize,
        accepts: fn(&Path) -> bool,
    ) -> Option<PathBuf> {
        if *remaining == 0 {
            return None;
        }
        let entries = fs::read_dir(dir).ok()?;
        let mut directories = Vec::new();
        for entry in entries {
            if *remaining == 0 {
                break;
            }
            *remaining -= 1;
            let Ok(entry) = entry else { continue };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_file() && accepts(&path) {
                return Some(path);
            }
            if kind.is_dir() && depth > 0 {
                directories.push(path);
            }
        }
        directories.sort();
        for directory in directories {
            if let Some(found) = visit(&directory, depth - 1, remaining, accepts) {
                return Some(found);
            }
        }
        None
    }
    visit(root, max_depth, &mut remaining, accepts)
}

#[tauri::command]
pub async fn read_cached_image(path: String, image_cache_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || image_data_url(&path, &image_cache_dir))
        .await
        .map_err(|e| format!("Card image could not be loaded: {e}"))?
}

fn image_data_url(path: &str, cache: &str) -> Result<String, String> {
    let root = absolute_path(cache, "Image cache folder")?
        .canonicalize()
        .map_err(|e| format!("Cannot open image cache folder: {e}"))?;
    let image = absolute_path(path, "Card image")?
        .canonicalize()
        .map_err(|e| format!("Cannot find cached image: {e}"))?;
    if !image.starts_with(&root) || !is_image_extension(&image) {
        return Err(
            "Choose a JPG or PNG image inside the configured Forge image cache.".to_string(),
        );
    }
    let file = fs::File::open(&image).map_err(|e| format!("Cannot read cached image: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Cannot inspect cached image: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err("The cached image must be a file smaller than 10 MB.".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read cached image: {e}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("The cached image exceeds 10 MB.".to_string());
    }
    let mime = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else {
        return Err("The selected file does not contain a supported JPG or PNG image.".to_string());
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn export_test_deck(deck_dir: String, name: String) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || write_test_deck(&deck_dir, &name))
        .await
        .map_err(|e| format!("Test deck export could not finish: {e}"))?
}

fn write_test_deck(deck_dir: &str, name: &str) -> Result<ExportResult, String> {
    let directory = absolute_path(deck_dir, "Deck export folder")?;
    if directory.parent().is_none() {
        return Err("Select a deck folder rather than the root of a drive.".to_string());
    }
    let content = serialize_test_deck(name)?;
    fs::create_dir_all(&directory).map_err(|e| format!("Cannot create deck export folder: {e}"))?;
    let stem = safe_filename(name);
    for index in 1..=1000 {
        let filename = if index == 1 {
            format!("Eternal League - {stem}.dck")
        } else {
            format!("Eternal League - {stem} ({index}).dck")
        };
        let path = directory.join(filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(content.as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(format!("Cannot write test deck: {error}"));
                }
                return Ok(ExportResult {
                    path: display_path(&path),
                    content,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Cannot export test deck: {error}")),
        }
    }
    Err("Too many test deck files have the same name. Choose another name.".to_string())
}

fn serialize_test_deck(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err("Use a deck name between 1 and 100 characters.".to_string());
    }
    if name.chars().any(|c| c.is_control() || c == '[' || c == ']') {
        return Err(
            "Deck names cannot contain line breaks, control characters, or brackets.".to_string(),
        );
    }
    // A basic-land deck verifies Forge's reader without relying on set/printing availability.
    Ok(format!(
        "[metadata]\nName={name}\n[Main]\n60 Forest\n[Sideboard]\n15 Forest\n"
    ))
}

fn safe_filename(name: &str) -> String {
    let sanitized: String = name
        .trim()
        .chars()
        .take(80)
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let sanitized = sanitized.trim_end_matches(['.', ' ']);
    if sanitized.is_empty() {
        "Test Deck".to_string()
    } else {
        sanitized.to_string()
    }
}

fn absolute_path(value: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return Err(format!(
            "{label} must be a full path. Use Browse to select it."
        ));
    }
    Ok(path)
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_image_extension(path: &Path) -> bool {
    matches!(extension(path).as_str(), "jpg" | "jpeg" | "png")
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_defaults_follow_platform_paths_without_creating_data() {
        let profile = Path::new("/example/home");
        let (data, cache) = default_forge_directories(
            "linux",
            profile,
            Some("ignored-roaming".into()),
            Some("ignored-local".into()),
        );
        assert_eq!(data, profile.join(".forge"));
        assert_eq!(cache, profile.join(".cache").join("forge"));
        let (data, cache) = default_forge_directories(
            "windows",
            profile,
            Some("roaming".into()),
            Some("local".into()),
        );
        assert_eq!(data, PathBuf::from("roaming").join("Forge"));
        assert_eq!(cache, PathBuf::from("local").join("Forge").join("Cache"));
        assert!(!same_default_directory(
            "/home/player/.forge",
            "/home/player/.Forge",
            false
        ));
        assert!(same_default_directory(
            "/home/player/.forge/",
            "/home/player/.forge",
            false
        ));
        assert!(same_default_directory(
            "C:/Players/Forge/",
            "c:\\players\\forge",
            true
        ));
    }

    #[test]
    fn test_deck_uses_forge_sections_and_basic_lands() {
        let deck = serialize_test_deck("  Integration check  ").unwrap();
        assert_eq!(
            deck,
            "[metadata]\nName=Integration check\n[Main]\n60 Forest\n[Sideboard]\n15 Forest\n"
        );
    }

    #[test]
    fn rejects_metadata_injection() {
        assert!(serialize_test_deck("Test\n[Main]\n60 Island").is_err());
        assert!(serialize_test_deck("[Main]").is_err());
        assert!(serialize_test_deck("  ").is_err());
    }

    #[test]
    fn exported_files_do_not_overwrite_and_cannot_escape_directory() {
        let folder = tempfile::tempdir().unwrap();
        let first = write_test_deck(folder.path().to_str().unwrap(), "../First: deck").unwrap();
        let second = write_test_deck(folder.path().to_str().unwrap(), "../First: deck").unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(Path::new(&first.path).parent().unwrap(), folder.path());
        assert_eq!(fs::read_to_string(first.path).unwrap(), first.content);
        assert_eq!(fs::read_to_string(second.path).unwrap(), second.content);
    }

    #[test]
    fn cache_images_are_contained_and_validated() {
        let cache = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let image = cache.path().join("Forest.full.jpg");
        let other = outside.path().join("Forest.full.jpg");
        fs::write(&image, [0xff, 0xd8, 0xff, 0x00]).unwrap();
        fs::write(&other, [0xff, 0xd8, 0xff, 0x00]).unwrap();
        assert!(
            image_data_url(image.to_str().unwrap(), cache.path().to_str().unwrap())
                .unwrap()
                .starts_with("data:image/jpeg;base64,")
        );
        assert!(image_data_url(other.to_str().unwrap(), cache.path().to_str().unwrap()).is_err());
        fs::write(&image, "not an image").unwrap();
        assert!(image_data_url(image.to_str().unwrap(), cache.path().to_str().unwrap()).is_err());
    }

    #[test]
    fn missing_folders_have_actionable_warnings() {
        let folder = tempfile::tempdir().unwrap();
        let missing = display_path(&folder.path().join("missing"));
        let report = inspect_forge(&ForgePaths {
            data_dir: missing.clone(),
            deck_dir: missing.clone(),
            image_cache_dir: missing.clone(),
            install_dir: Some(missing),
        })
        .unwrap();
        assert!(!report.data_dir_exists);
        assert!(!report.deck_dir_exists);
        assert!(!report.image_cache_dir_exists);
        assert_eq!(report.warnings.len(), 3);
    }

    #[test]
    fn portable_installation_prepares_only_standard_first_run_folders() {
        let root = tempfile::tempdir().unwrap();
        let installation = root.path().join("portable-forge");
        fs::create_dir_all(installation.join("res").join("editions")).unwrap();
        fs::create_dir_all(installation.join("res").join("cardsfolder")).unwrap();
        let defaults = ForgePaths {
            data_dir: display_path(&root.path().join("standard-data")),
            deck_dir: display_path(
                &root
                    .path()
                    .join("standard-data")
                    .join("decks")
                    .join("constructed"),
            ),
            image_cache_dir: display_path(
                &root
                    .path()
                    .join("standard-images")
                    .join("pics")
                    .join("cards"),
            ),
            install_dir: None,
        };
        let mut selected = defaults.clone();
        selected.install_dir = Some(display_path(&installation));
        assert!(!Path::new(&selected.deck_dir).exists());
        assert!(!Path::new(&selected.image_cache_dir).exists());
        let ready = inspect_forge_with_defaults(&selected, &defaults).unwrap();
        assert!(ready.install_dir_exists);
        assert!(ready.deck_dir_exists);
        assert!(ready.image_cache_dir_exists);
        assert!(ready.warnings.is_empty());

        selected.deck_dir = display_path(&root.path().join("missing-custom-decks"));
        selected.image_cache_dir = display_path(&root.path().join("missing-custom-images"));
        let custom = inspect_forge_with_defaults(&selected, &defaults).unwrap();
        assert!(custom.install_dir_exists);
        assert!(!custom.deck_dir_exists);
        assert!(!custom.image_cache_dir_exists);
        assert!(!Path::new(&selected.deck_dir).exists());
        assert!(!Path::new(&selected.image_cache_dir).exists());

        let unconfirmed = ForgePaths {
            data_dir: display_path(&root.path().join("unconfirmed")),
            deck_dir: display_path(&root.path().join("unconfirmed").join("decks")),
            image_cache_dir: display_path(&root.path().join("unconfirmed").join("images")),
            install_dir: Some(display_path(&root.path().join("not-installed"))),
        };
        let missing = inspect_forge_with_defaults(&unconfirmed, &unconfirmed).unwrap();
        assert!(!missing.install_dir_exists);
        assert!(!Path::new(&unconfirmed.deck_dir).exists());
        assert!(!Path::new(&unconfirmed.image_cache_dir).exists());
    }

    #[test]
    fn forge_version_comes_from_the_desktop_release_filename() {
        assert_eq!(
            jar_version("forge-gui-desktop-2.0.13-jar-with-dependencies.jar").as_deref(),
            Some("2.0.13")
        );
        assert_eq!(
            jar_version("forge-gui-desktop-2.0.14-SNAPSHOT-jar-with-dependencies.jar").as_deref(),
            Some("2.0.14-SNAPSHOT")
        );
        assert!(jar_version("forge-gui-desktop-unknown-jar-with-dependencies.jar").is_none());
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory
                .path()
                .join("forge-gui-desktop-2.0.13-jar-with-dependencies.jar"),
            [],
        )
        .unwrap();
        assert_eq!(
            installation_version(directory.path()).as_deref(),
            Some("2.0.13")
        );
    }
}
