use crate::catalog::{
    card_from_row, database_mutation_guard, is_unlimited_basic, open_pool, CatalogCard,
    ORACLE_OWNED_SQL,
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::SystemTime,
};
use tauri::AppHandle;

const APP_DECK_FOLDER: &str = "Eternal League";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSummary {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub main_count: i64,
    pub sideboard_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckEntry {
    pub card: CatalogCard,
    pub section: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDetail {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub cards: Vec<DeckEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftCard {
    pub card_id: String,
    pub section: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDraft {
    pub id: Option<String>,
    pub name: String,
    pub cards: Vec<DraftCard>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckValidation {
    pub warnings: Vec<String>,
    pub main_count: i64,
    pub sideboard_count: i64,
    pub can_export: bool,
}

#[derive(Debug, Serialize)]
pub struct DeckExport {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct SavedDeck {
    pub deck: DeckDetail,
    pub export: DeckExport,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckFileMigration {
    pub moved: u64,
    pub archived: u64,
    pub deduplicated: u64,
    pub missing: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
struct DeckRestrictions {
    minimum_main_deck: i64,
    maximum_sideboard: i64,
    normal_copy_limit: i64,
}

impl Default for DeckRestrictions {
    fn default() -> Self {
        Self {
            minimum_main_deck: 60,
            maximum_sideboard: 15,
            normal_copy_limit: 4,
        }
    }
}

async fn restrictions_pool(pool: &SqlitePool) -> Result<DeckRestrictions, String> {
    #[cfg(not(test))]
    {
        let _ = pool;
        let rules = crate::league_rules::builtin_rules()?;
        return Ok(DeckRestrictions {
            minimum_main_deck: rules.deck_restrictions.minimum_main_deck,
            maximum_sideboard: rules.deck_restrictions.maximum_sideboard,
            normal_copy_limit: rules.deck_restrictions.normal_copy_limit,
        });
    }
    #[cfg(test)]
    {
        let fixture_override: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='test.allow-league-settings'")
                .fetch_optional(pool)
                .await
                .map_err(|error| error.to_string())?;
        if fixture_override.as_deref() != Some("1") {
            let rules = crate::league_rules::builtin_rules()?;
            return Ok(DeckRestrictions {
                minimum_main_deck: rules.deck_restrictions.minimum_main_deck,
                maximum_sideboard: rules.deck_restrictions.maximum_sideboard,
                normal_copy_limit: rules.deck_restrictions.normal_copy_limit,
            });
        }
        let saved: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='app'")
                .fetch_optional(pool)
                .await
                .map_err(|error| error.to_string())?;
        let restrictions = if let Some(saved) = saved {
            let value: serde_json::Value = serde_json::from_str(&saved)
                .map_err(|error| format!("Cannot read deck-building settings: {error}"))?;
            match value
                .get("league")
                .and_then(|league| league.get("deckRestrictions"))
            {
                Some(value) => serde_json::from_value(value.clone())
                    .map_err(|error| format!("Cannot read deck-building restrictions: {error}"))?,
                None => DeckRestrictions::default(),
            }
        } else {
            DeckRestrictions::default()
        };
        if !(1..=250).contains(&restrictions.minimum_main_deck)
            || !(0..=100).contains(&restrictions.maximum_sideboard)
            || !(1..=100).contains(&restrictions.normal_copy_limit)
        {
            return Err("Deck restrictions must use a minimum main deck between 1 and 250, a maximum sideboard between 0 and 100, and a normal copy limit between 1 and 100.".into());
        }
        Ok(restrictions)
    }
}

fn validated_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err("Use a deck name between 1 and 100 characters.".into());
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '[' | ']' | '|'))
    {
        return Err(
            "Deck names cannot contain line breaks, control characters, brackets, or pipes.".into(),
        );
    }
    Ok(name.to_owned())
}

fn normalize_entries(cards: &[DraftCard]) -> Result<Vec<DraftCard>, String> {
    if cards.len() > 2000 {
        return Err("A deck cannot contain more than 2,000 printing entries.".into());
    }
    let mut combined = BTreeMap::<(String, String), i64>::new();
    for card in cards {
        if !matches!(card.section.as_str(), "main" | "sideboard") {
            return Err("Choose either the main deck or sideboard for every card.".into());
        }
        if card.card_id.is_empty() || card.quantity < 1 || card.quantity > 100_000 {
            return Err("Card quantities must be whole numbers between 1 and 100,000.".into());
        }
        let quantity = combined
            .entry((card.card_id.clone(), card.section.clone()))
            .or_default();
        *quantity = quantity
            .checked_add(card.quantity)
            .filter(|value| *value <= 100_000)
            .ok_or("A single printing cannot have more than 100,000 copies in a section.")?;
    }
    Ok(combined
        .into_iter()
        .map(|((card_id, section), quantity)| DraftCard {
            card_id,
            section,
            quantity,
        })
        .collect())
}

pub async fn list_pool(pool: &SqlitePool) -> Result<Vec<DeckSummary>, String> {
    let rows = sqlx::query("SELECT d.*, COALESCE(SUM(CASE WHEN dc.section='main' THEN dc.quantity ELSE 0 END),0) AS main_count, COALESCE(SUM(CASE WHEN dc.section='sideboard' THEN dc.quantity ELSE 0 END),0) AS sideboard_count FROM decks d LEFT JOIN deck_cards dc ON dc.deck_id=d.id GROUP BY d.id ORDER BY d.updated_at DESC,d.name COLLATE NOCASE")
        .fetch_all(pool).await.map_err(|e| format!("Cannot list decks: {e}"))?;
    Ok(rows
        .iter()
        .map(|row| DeckSummary {
            id: row.get("id"),
            name: row.get("name"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            main_count: row.get("main_count"),
            sideboard_count: row.get("sideboard_count"),
        })
        .collect())
}

pub async fn load_pool(pool: &SqlitePool, id: &str) -> Result<DeckDetail, String> {
    let row = sqlx::query("SELECT * FROM decks WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Cannot read deck: {e}"))?
        .ok_or("This deck no longer exists.")?;
    let cards = sqlx::query(&format!("SELECT c.*, COALESCE(o.quantity,0) AS owned, {ORACLE_OWNED_SQL} AS oracle_owned, dc.section, dc.quantity AS deck_quantity FROM deck_cards dc JOIN cards c ON c.id=dc.card_id LEFT JOIN collection o ON o.card_id=c.id WHERE dc.deck_id=? ORDER BY dc.section,c.cmc,c.name COLLATE NOCASE,c.set_code,c.collector_number"))
        .bind(id).fetch_all(pool).await.map_err(|e| format!("Cannot load deck cards: {e}"))?;
    Ok(DeckDetail {
        id: row.get("id"),
        name: row.get("name"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        cards: cards
            .iter()
            .map(|row| {
                Ok(DeckEntry {
                    card: card_from_row(row)?,
                    section: row.get("section"),
                    quantity: row.get("deck_quantity"),
                })
            })
            .collect::<Result<_, String>>()?,
    })
}

async fn save_rows(
    connection: &mut SqliteConnection,
    deck: &DeckDraft,
    name: &str,
    cards: Vec<DraftCard>,
) -> Result<String, String> {
    let id = if let Some(id) = deck.id.clone() {
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks WHERE id=?")
            .bind(&id)
            .fetch_one(&mut *connection)
            .await
            .map_err(|e| e.to_string())?;
        if exists != 1 {
            return Err("This deck no longer exists. Create a new deck instead.".into());
        }
        sqlx::query(
            "UPDATE decks SET name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        )
        .bind(name)
        .bind(&id)
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
        id
    } else {
        let id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
            .fetch_one(&mut *connection)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO decks(id,name,created_at,updated_at) VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
            .bind(&id).bind(name).execute(&mut *connection).await.map_err(|e| e.to_string())?;
        id
    };
    sqlx::query("DELETE FROM deck_cards WHERE deck_id=?")
        .bind(&id)
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
    for card in cards {
        sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES(?,?,?,?)")
            .bind(&id)
            .bind(&card.card_id)
            .bind(&card.section)
            .bind(card.quantity)
            .execute(&mut *connection)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[cfg(test)]
pub async fn save_pool(pool: &SqlitePool, deck: DeckDraft) -> Result<DeckDetail, String> {
    let name = validated_name(&deck.name)?;
    let cards = normalize_entries(&deck.cards)?;
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| error.to_string())?;
    let entries = draft_entries(&mut transaction, &deck).await?;
    let ownership_errors = ownership_warnings(&entries);
    if !ownership_errors.is_empty() {
        return Err(ownership_errors.join(" "));
    }
    let id = save_rows(&mut transaction, &deck, &name, cards).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Cannot save deck: {error}"))?;
    load_pool(pool, &id).await
}

#[tauri::command]
pub async fn list_decks(app: AppHandle) -> Result<Vec<DeckSummary>, String> {
    list_pool(&open_pool(&app).await?).await
}

#[tauri::command]
pub async fn load_deck(app: AppHandle, id: String) -> Result<DeckDetail, String> {
    load_pool(&open_pool(&app).await?, &id).await
}

#[tauri::command]
pub async fn save_deck(app: AppHandle, deck: DeckDraft) -> Result<DeckDetail, String> {
    let _operation = database_mutation_guard()?;
    Ok(save_synced(&open_pool(&app).await?, deck).await?.deck)
}

#[tauri::command]
pub async fn save_deck_to_forge(app: AppHandle, deck: DeckDraft) -> Result<SavedDeck, String> {
    let _operation = database_mutation_guard()?;
    save_synced(&open_pool(&app).await?, deck).await
}

#[tauri::command]
pub async fn duplicate_deck(app: AppHandle, id: String) -> Result<DeckDetail, String> {
    let _operation = database_mutation_guard()?;
    let pool = open_pool(&app).await?;
    let source = load_pool(&pool, &id).await?;
    Ok(save_synced(&pool, copied_draft(source)).await?.deck)
}

fn copied_draft(source: DeckDetail) -> DeckDraft {
    DeckDraft {
        id: None,
        name: format!(
            "{} (copy)",
            source.name.chars().take(90).collect::<String>()
        ),
        cards: source
            .cards
            .into_iter()
            .map(|entry| DraftCard {
                card_id: entry.card.id,
                section: entry.section,
                quantity: entry.quantity,
            })
            .collect(),
    }
}

#[cfg(test)]
async fn duplicate_pool(pool: &SqlitePool, id: &str) -> Result<DeckDetail, String> {
    let source = load_pool(pool, id).await?;
    save_pool(pool, copied_draft(source)).await
}

async fn saved_forge_paths(pool: &SqlitePool) -> Result<crate::forge::ForgePaths, String> {
    let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='app'")
        .fetch_optional(pool)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Configure your Forge folders in Settings before saving a deck.")?;
    forge_paths_from_json(&value)
}

fn forge_paths_from_json(value: &str) -> Result<crate::forge::ForgePaths, String> {
    let value: serde_json::Value =
        serde_json::from_str(value).map_err(|error| error.to_string())?;
    let mut paths: crate::forge::ForgePaths = serde_json::from_value(
        value
            .get("forge")
            .cloned()
            .ok_or("Forge folders are not configured.")?,
    )
    .map_err(|error| format!("Cannot read Forge folders: {error}"))?;
    if paths
        .install_dir
        .as_deref()
        .is_none_or(|path| path.trim().is_empty())
    {
        paths.install_dir = crate::forge::detect_forge_paths().install_dir;
    }
    let install = paths
        .install_dir
        .as_deref()
        .ok_or("Forge installation was not detected. Select it in Settings.")?;
    let install = Path::new(install);
    if !install.is_absolute()
        || !install.join("res").join("editions").is_dir()
        || !install.join("res").join("cardsfolder").is_dir()
    {
        return Err("The selected Forge installation folder is unavailable. Correct it in Settings before saving.".into());
    }
    Ok(paths)
}

async fn check_saved_forge_paths(
    connection: &mut SqliteConnection,
    expected: Option<&crate::forge::ForgePaths>,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='app'")
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    let current = forge_paths_from_json(&value)?;
    if current.install_dir != expected.install_dir
        || current.deck_dir != expected.deck_dir
        || current.image_cache_dir != expected.image_cache_dir
    {
        return Err("Forge folders changed while this operation was preparing. Try again with the newly saved folders.".into());
    }
    Ok(())
}

async fn save_synced(pool: &SqlitePool, deck: DeckDraft) -> Result<SavedDeck, String> {
    let paths = saved_forge_paths(pool).await?;
    let install = paths.install_dir.clone();
    let index = tauri::async_runtime::spawn_blocking(move || forge_index(install.as_deref()))
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Forge card resources could not be loaded.")?;
    save_synced_checked(pool, deck, &paths.deck_dir, &index, Some(&paths)).await
}

#[cfg(test)]
async fn save_synced_with_index(
    pool: &SqlitePool,
    deck: DeckDraft,
    directory: &str,
    index: &ForgeIndex,
) -> Result<SavedDeck, String> {
    save_synced_checked(pool, deck, directory, index, None).await
}

async fn save_synced_checked(
    pool: &SqlitePool,
    deck: DeckDraft,
    directory: &str,
    index: &ForgeIndex,
    expected: Option<&crate::forge::ForgePaths>,
) -> Result<SavedDeck, String> {
    let name = validated_name(&deck.name)?;
    let cards = normalize_entries(&deck.cards)?;
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| error.to_string())?;
    check_saved_forge_paths(&mut transaction, expected).await?;
    let entries = draft_entries(&mut transaction, &deck).await?;
    let errors = ownership_warnings(&entries);
    if !errors.is_empty() {
        return Err(errors.join(" "));
    }
    // Forge can store incomplete decks for further editing. Exact supported
    // printings and owned quantities are still required for every save.
    for entry in &entries {
        let printing = index.printing(&entry.card.name, &entry.card.set_code, &entry.card.set_name, &entry.card.collector_number)
            .ok_or_else(|| format!("Forge does not contain the exact printing {} ({} #{}). Update Forge or choose another printing before saving.", entry.card.name, entry.card.set_code.to_uppercase(), entry.card.collector_number))?;
        if !index.supported.contains(&printing.name.to_lowercase()) {
            return Err(format!(
                "{} is unavailable in this Forge installation. Update Forge before saving it.",
                entry.card.name
            ));
        }
    }
    let content = serialize_deck(&name, &entries, index)?;
    let id = save_rows(&mut transaction, &deck, &name, cards).await?;
    let key = format!("forge_export:{id}");
    let previous: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
        .bind(&key)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    let paths = tracked_paths(previous)?;
    let root = managed_deck_directory(directory)?;
    let mut migration = FileJournal::default();
    let mut report = DeckFileMigration::default();
    let mut paths = migrate_deck_paths(&id, &paths, &root, &mut migration, &mut report)
        .map_err(|error| migration_error(error, &mut migration))?;
    let root_text = root
        .to_str()
        .ok_or("The Forge deck folder has an unsupported path encoding.")?;
    let change = ManagedExport::write(root_text, &id, &name, &content, &paths)
        .map_err(|error| migration_error(error, &mut migration))?;
    let path = change.path.to_string_lossy().into_owned();
    if !paths.contains(&path) {
        paths.push(path.clone());
    }
    let result = async {
        sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(key).bind(serde_json::to_string(&paths).map_err(|error| error.to_string())?)
            .execute(&mut *transaction).await.map_err(|error| error.to_string())?;
        transaction.commit().await.map_err(|error| format!("Cannot save the deck database: {error}"))
    }.await;
    if let Err(error) = result {
        let error = match change.rollback() {
            Ok(()) => error,
            Err(rollback) => {
                format!("{error} The previous Forge file could not be restored: {rollback}")
            }
        };
        return Err(migration_error(error, &mut migration));
    }
    change.finish();
    migration.finish();
    Ok(SavedDeck {
        deck: load_pool(pool, &id).await?,
        export: DeckExport { path, content },
    })
}

fn managed_deck_directory(directory: &str) -> Result<PathBuf, String> {
    let selected = PathBuf::from(directory.trim());
    if !selected.is_absolute() || !selected.is_dir() || selected.parent().is_none() {
        return Err(
            "The constructed-deck folder is unavailable. Correct it in Settings before saving."
                .into(),
        );
    }
    let root = selected.canonicalize().map_err(|error| error.to_string())?;
    let managed = root.join(APP_DECK_FOLDER);
    match fs::create_dir(&managed) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => {
            return Err(format!(
                "Cannot create Eternal League's Forge deck folder: {error}"
            ))
        }
    }
    let metadata = fs::symlink_metadata(&managed).map_err(|error| error.to_string())?;
    let canonical = managed.canonicalize().map_err(|error| error.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || canonical.parent() != Some(root.as_path())
        || !canonical
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(APP_DECK_FOLDER))
    {
        return Err("Eternal League's Forge deck folder must be a real subfolder of the configured constructed-deck folder.".into());
    }
    Ok(canonical)
}

fn tracked_paths(value: Option<String>) -> Result<Vec<String>, String> {
    value
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| format!("Cannot read this deck's tracked Forge files: {error}"))
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

fn valid_deck_identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn verified_tracked_file(value: &str, id: &str) -> Result<Option<PathBuf>, String> {
    let path = PathBuf::from(value);
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .ok_or("A tracked Forge file has no filename.")?;
    let marker = format!(" - {id}.dck");
    let owned_name = filename.starts_with("Eternal League - ")
        && (filename.ends_with(&marker)
            || filename
                .rsplit_once(".archive-")
                .is_some_and(|(base, token)| {
                    base.ends_with(&marker)
                        && token.len() == 16
                        && token.chars().all(|character| character.is_ascii_hexdigit())
                }));
    if !valid_deck_identifier(id) || !path.is_absolute() || !owned_name {
        return Err("A tracked Forge deck file could not be verified as belonging to this deck. It was left untouched.".into());
    }
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect a tracked Forge file: {error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(
            "A tracked Forge deck path is not a regular file. It was left untouched.".into(),
        );
    }
    Ok(Some(
        path.canonicalize().map_err(|error| error.to_string())?,
    ))
}

struct StagedFile {
    source: PathBuf,
    staged: PathBuf,
    created: Option<PathBuf>,
}

#[derive(Default)]
struct FileJournal {
    files: Vec<StagedFile>,
    finished: bool,
}

impl FileJournal {
    fn stage(
        &mut self,
        source: &Path,
        created: Option<PathBuf>,
        expected: Option<&[u8]>,
    ) -> Result<(), String> {
        let parent = source
            .parent()
            .ok_or("The tracked Forge file has no parent folder.")?;
        let staged = match tempfile::Builder::new()
            .prefix(".eternal-league-")
            .suffix(".pending")
            .tempfile_in(parent)
            .map(|file| file.into_temp_path())
            .and_then(|path| path.keep().map_err(|error| error.error))
        {
            Ok(path) => path,
            Err(error) => {
                if let Some(created) = &created {
                    let _ = fs::remove_file(created);
                }
                return Err(format!("Cannot stage the tracked Forge file: {error}"));
            }
        };
        if let Err(error) = fs::rename(source, &staged) {
            let _ = fs::remove_file(&staged);
            if let Some(created) = &created {
                let _ = fs::remove_file(created);
            }
            return Err(format!("Cannot move the tracked Forge file: {error}"));
        }
        self.files.push(StagedFile {
            source: source.to_path_buf(),
            staged: staged.clone(),
            created,
        });
        let metadata = fs::symlink_metadata(&staged).map_err(|error| error.to_string())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || expected
                .is_some_and(|expected| fs::read(&staged).map_or(true, |actual| actual != expected))
        {
            return Err("A tracked Forge file changed while it was being moved. The operation was stopped to preserve its contents.".into());
        }
        Ok(())
    }

    fn relocate(
        &mut self,
        source: &Path,
        target: PathBuf,
        bytes: &[u8],
    ) -> Result<PathBuf, String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("Cannot create the migrated Forge file: {error}"))?;
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&target);
            return Err(format!("Cannot write the migrated Forge file: {error}"));
        }
        drop(file);
        self.stage(source, Some(target.clone()), Some(bytes))?;
        Ok(target)
    }

    fn finish(mut self) {
        self.finished = true;
        for file in &self.files {
            let _ = fs::remove_file(&file.staged);
        }
    }

    fn rollback(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        for file in self.files.iter().rev() {
            if file.source.exists() {
                failures.push(format!(
                    "{} is occupied; the previous contents are retained at {}",
                    file.source.display(),
                    file.staged.display()
                ));
                continue;
            }
            match fs::rename(&file.staged, &file.source) {
                Ok(()) => {
                    if let Some(created) = &file.created {
                        if let Err(error) = fs::remove_file(created) {
                            if error.kind() != std::io::ErrorKind::NotFound {
                                failures.push(format!(
                                    "an extra migrated copy remains at {}: {error}",
                                    created.display()
                                ));
                            }
                        }
                    }
                }
                Err(error) => failures.push(format!(
                    "could not restore {}: {error}; retained recovery file: {}",
                    file.source.display(),
                    file.staged.display()
                )),
            }
        }
        self.finished = true;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join(" "))
        }
    }
}

impl Drop for FileJournal {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let _ = self.rollback();
    }
}

fn migration_error(error: String, journal: &mut FileJournal) -> String {
    match journal.rollback() {
        Ok(()) => error,
        Err(recovery) => format!("{error} Some Forge files require recovery: {recovery}"),
    }
}

fn collision_safe_target(
    root: &Path,
    filename: &str,
    id: &str,
    archived: bool,
) -> Result<PathBuf, String> {
    let suffix = format!(" - {id}.dck");
    let stem = filename
        .strip_suffix(&suffix)
        .ok_or("The tracked Forge filename is invalid.")?;
    for index in 0..1000 {
        let target = if archived {
            root.join(format!("{filename}.archive-{:016x}", rand::random::<u64>()))
        } else if index == 0 {
            root.join(filename)
        } else {
            root.join(format!("{stem} (migrated {index}){suffix}"))
        };
        if !target.exists() {
            return Ok(target);
        }
    }
    Err(
        "Too many files collide with this deck's migration path. Existing files were preserved."
            .into(),
    )
}

fn archive_directory(root: &Path) -> Result<PathBuf, String> {
    let archive = root.join("Archive");
    match fs::create_dir(&archive) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.to_string()),
    }
    let metadata = fs::symlink_metadata(&archive).map_err(|error| error.to_string())?;
    let canonical = archive.canonicalize().map_err(|error| error.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || canonical.parent() != Some(root)
        || !canonical
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Archive"))
    {
        return Err(
            "The Eternal League archive must be a real subfolder of its Forge deck folder.".into(),
        );
    }
    Ok(canonical)
}

fn migrate_deck_paths(
    id: &str,
    values: &[String],
    root: &Path,
    journal: &mut FileJournal,
    report: &mut DeckFileMigration,
) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut active = Vec::new();
    let mut archives = Vec::new();
    for value in values {
        let Some(path) = verified_tracked_file(value, id)? else {
            report.missing += 1;
            continue;
        };
        if !seen.insert(path.clone()) {
            continue;
        }
        if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dck"))
        {
            active.push(path);
        } else {
            archives.push(path);
        }
    }
    active.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let mut migrated = Vec::new();
    let mut primary_bytes = None;
    if let Some(primary) = active.pop() {
        let bytes = fs::read(&primary).map_err(|error| error.to_string())?;
        let target = if primary.parent() == Some(root) {
            primary
        } else {
            let filename = primary
                .file_name()
                .ok_or("The Forge deck filename is missing.")?
                .to_string_lossy();
            let target = collision_safe_target(root, &filename, id, false)?;
            report.moved += 1;
            journal.relocate(&primary, target, &bytes)?
        };
        migrated.push(target.to_string_lossy().into_owned());
        primary_bytes = Some(bytes);
    }
    for old in active {
        let bytes = fs::read(&old).map_err(|error| error.to_string())?;
        if primary_bytes.as_ref() == Some(&bytes) {
            journal.stage(&old, None, Some(&bytes))?;
            report.deduplicated += 1;
        } else {
            let archive = archive_directory(root)?;
            let filename = old
                .file_name()
                .ok_or("The Forge deck filename is missing.")?
                .to_string_lossy();
            let target = collision_safe_target(&archive, &filename, id, true)?;
            let target = journal.relocate(&old, target, &bytes)?;
            migrated.push(target.to_string_lossy().into_owned());
            report.archived += 1;
        }
    }
    for old in archives {
        let archive = archive_directory(root)?;
        let target = if old.parent() == Some(archive.as_path()) {
            old
        } else {
            let filename = old
                .file_name()
                .ok_or("The archived Forge filename is missing.")?
                .to_string_lossy();
            let base = filename
                .rsplit_once(".archive-")
                .ok_or("The archived Forge filename is invalid.")?
                .0;
            let target = collision_safe_target(&archive, base, id, true)?;
            let bytes = fs::read(&old).map_err(|error| error.to_string())?;
            report.archived += 1;
            journal.relocate(&old, target, &bytes)?
        };
        migrated.push(target.to_string_lossy().into_owned());
    }
    Ok(migrated)
}

#[tauri::command]
pub async fn migrate_forge_decks(app: AppHandle) -> Result<DeckFileMigration, String> {
    let _operation = database_mutation_guard()?;
    let pool = open_pool(&app).await?;
    let paths = saved_forge_paths(&pool).await?;
    migrate_export_folder_checked(&pool, &paths.deck_dir, Some(&paths)).await
}

#[cfg(test)]
async fn migrate_export_folder_pool(
    pool: &SqlitePool,
    directory: &str,
) -> Result<DeckFileMigration, String> {
    migrate_export_folder_checked(pool, directory, None).await
}

async fn migrate_export_folder_checked(
    pool: &SqlitePool,
    directory: &str,
    expected: Option<&crate::forge::ForgePaths>,
) -> Result<DeckFileMigration, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| error.to_string())?;
    check_saved_forge_paths(&mut transaction, expected).await?;
    let root = managed_deck_directory(directory)?;
    let rows = sqlx::query("SELECT s.key,s.value,d.id FROM settings s JOIN decks d ON s.key='forge_export:' || d.id ORDER BY d.id")
        .fetch_all(&mut *transaction).await.map_err(|error| error.to_string())?;
    let mut journal = FileJournal::default();
    let mut report = DeckFileMigration::default();
    let result = async {
        for row in rows {
            let key: String = row.get("key");
            let id: String = row.get("id");
            let previous = tracked_paths(Some(row.get("value")))?;
            let paths = migrate_deck_paths(&id, &previous, &root, &mut journal, &mut report)?;
            if paths != previous {
                sqlx::query("UPDATE settings SET value=? WHERE key=?")
                    .bind(serde_json::to_string(&paths).map_err(|error| error.to_string())?)
                    .bind(key)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction
            .commit()
            .await
            .map_err(|error| format!("Could not commit the Forge deck migration: {error}"))?;
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = result {
        return Err(migration_error(error, &mut journal));
    }
    journal.finish();
    Ok(report)
}

struct ManagedExport {
    path: PathBuf,
    backup: Option<PathBuf>,
}

impl ManagedExport {
    fn write(
        directory: &str,
        id: &str,
        name: &str,
        content: &str,
        owned_paths: &[String],
    ) -> Result<Self, String> {
        let selected = PathBuf::from(directory.trim());
        if !selected.is_absolute() || !selected.is_dir() || selected.parent().is_none() {
            return Err(
                "The constructed-deck folder is unavailable. Correct it in Settings before saving."
                    .into(),
            );
        }
        if id.is_empty()
            || id.len() > 128
            || !id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err("The saved deck has an invalid file identifier.".into());
        }
        let root = selected.canonicalize().map_err(|error| error.to_string())?;
        let suffix = format!(" - {id}.dck");
        let existing = owned_paths.iter().map(PathBuf::from).find(|path| {
            path.parent()
                .and_then(|parent| parent.canonicalize().ok())
                .as_ref()
                == Some(&root)
                && path.file_name().is_some_and(|file| {
                    file.to_string_lossy().starts_with("Eternal League - ")
                        && file.to_string_lossy().ends_with(&suffix)
                })
        });
        let managed = existing.is_some();
        let stem: String = name
            .chars()
            .take(70)
            .map(|character| {
                if matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                ) {
                    '_'
                } else {
                    character
                }
            })
            .collect();
        let path = existing.unwrap_or_else(|| {
            root.join(format!(
                "Eternal League - {}{suffix}",
                stem.trim_end_matches(['.', ' '])
            ))
        });
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if !managed {
                return Err("A different file already uses this deck's export path. Move it before saving; it was not overwritten.".into());
            }
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("The managed Forge deck path is not a regular file.".into());
            }
        }
        let token = rand::random::<u64>();
        let temporary = root.join(format!(".eternal-league-{id}-{token:016x}.tmp"));
        let backup = root.join(format!(".eternal-league-{id}-{token:016x}.backup"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Cannot prepare the Forge deck file: {error}"))?;
        if let Err(error) = file
            .write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(format!("Cannot write the Forge deck file: {error}"));
        }
        drop(file);
        let old = if path.exists() {
            if !managed {
                let _ = fs::remove_file(&temporary);
                return Err("A file appeared at this deck's export path. It was not overwritten; try saving again after moving it.".into());
            }
            if let Err(error) = fs::rename(&path, &backup) {
                let _ = fs::remove_file(&temporary);
                return Err(format!("Cannot update the Forge deck file: {error}"));
            }
            Some(backup)
        } else {
            None
        };
        if old.is_none() {
            let placed = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    let result = file
                        .write_all(content.as_bytes())
                        .and_then(|_| file.sync_all());
                    drop(file);
                    if result.is_err() {
                        let _ = fs::remove_file(&path);
                    }
                    result
                }
                Err(error) => Err(error),
            };
            let _ = fs::remove_file(&temporary);
            placed.map_err(|error| format!("Cannot create the Forge deck file without overwriting an existing file: {error}"))?;
            return Ok(Self { path, backup: None });
        }
        if let Err(error) = fs::rename(&temporary, &path) {
            if let Some(old) = &old {
                let _ = fs::rename(old, &path);
            }
            let _ = fs::remove_file(&temporary);
            return Err(format!("Cannot place the Forge deck file: {error}"));
        }
        Ok(Self { path, backup: old })
    }
    fn rollback(self) -> Result<(), String> {
        fs::remove_file(&self.path).map_err(|error| error.to_string())?;
        if let Some(backup) = self.backup {
            fs::rename(backup, self.path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    fn finish(self) {
        if let Some(backup) = self.backup {
            let _ = fs::remove_file(backup);
        }
    }
}

#[tauri::command]
pub async fn delete_deck(app: AppHandle, id: String) -> Result<(), String> {
    let _operation = database_mutation_guard()?;
    let pool = open_pool(&app).await?;
    delete_pool(&pool, &id).await
}

pub async fn delete_pool(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let key = format!("forge_export:{id}");
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
        .bind(&key)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    let paths = tracked_paths(value)?;
    let mut journal = FileJournal::default();
    let mut seen = HashSet::new();
    let result = async {
        for value in paths {
            if let Some(path) = verified_tracked_file(&value, id)? {
                if seen.insert(path.clone()) {
                    journal.stage(&path, None, None)?;
                }
            }
        }
        sqlx::query("DELETE FROM deck_cards WHERE deck_id=?")
            .bind(id)
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM decks WHERE id=?")
            .bind(id)
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM settings WHERE key=?")
            .bind(key)
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
        transaction
            .commit()
            .await
            .map_err(|e| format!("Cannot delete deck: {e}"))?;
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = result {
        return Err(migration_error(error, &mut journal));
    }
    journal.finish();
    Ok(())
}

async fn draft_entries(
    connection: &mut SqliteConnection,
    deck: &DeckDraft,
) -> Result<Vec<DeckEntry>, String> {
    validated_name(&deck.name)?;
    let unlocked = crate::progression::unlocked_sets_connection(connection).await?;
    let mut result = Vec::new();
    for entry in normalize_entries(&deck.cards)? {
        let row = sqlx::query(&format!("SELECT c.*,COALESCE(o.quantity,0) AS owned,{ORACLE_OWNED_SQL} AS oracle_owned FROM cards c LEFT JOIN collection o ON o.card_id=c.id WHERE c.id=?"))
            .bind(&entry.card_id).fetch_optional(&mut *connection).await.map_err(|e| e.to_string())?.ok_or("A deck printing is missing from the catalog.")?;
        let card = card_from_row(&row)?;
        let metadata = serde_json::from_str(row.get("metadata_json"))
            .map_err(|error| format!("Cannot read {} printing metadata: {error}", card.name))?;
        if !crate::card_policy::eligible(&metadata, &card) {
            return Err(format!(
                "{} ({} #{}) is not an eligible regular paper printing for this league.",
                card.name,
                card.set_code.to_uppercase(),
                card.collector_number
            ));
        }
        if !unlocked.contains(&card.set_code.to_lowercase()) {
            return Err(format!("{} ({} #{}) is locked until its global league unlock date. Choose an unlocked printing.", card.name, card.set_code.to_uppercase(), card.collector_number));
        }
        result.push(DeckEntry {
            card,
            section: entry.section,
            quantity: entry.quantity,
        });
    }
    let printing_errors = single_printing_warnings(&result);
    if !printing_errors.is_empty() {
        return Err(printing_errors.join(" "));
    }
    Ok(result)
}

fn single_printing_warnings(entries: &[DeckEntry]) -> Vec<String> {
    let mut identities = BTreeMap::<String, (&str, HashSet<&str>)>::new();
    for entry in entries {
        let identity = if entry.card.oracle_id.is_empty() {
            entry.card.name.to_lowercase()
        } else {
            entry.card.oracle_id.clone()
        };
        identities
            .entry(identity)
            .or_insert((&entry.card.name, HashSet::new()))
            .1
            .insert(&entry.card.id);
    }
    identities.values().filter(|(_,printings)|printings.len()>1).map(|(name,_)|format!("Choose one printing of {name} for the whole deck, including the sideboard. Apply the chosen artwork to all copies.")).collect()
}

fn ownership_warnings(entries: &[DeckEntry]) -> Vec<String> {
    let mut printing_counts: BTreeMap<&str, (&CatalogCard, i64)> = BTreeMap::new();
    for entry in entries {
        printing_counts
            .entry(&entry.card.oracle_id)
            .or_insert((&entry.card, 0))
            .1 += entry.quantity;
    }
    printing_counts
        .values()
        .filter(|(card, count)| !is_unlimited_basic(card) && *count > card.oracle_owned)
        .map(|(card, count)| {
            let noun = if *count == 1 { "copy" } else { "copies" };
            format!(
                "{} needs {count} {noun} across the main deck and sideboard, and you own {} across all printings.",
                card.name,
                card.oracle_owned,
            )
        })
        .collect()
}

fn copy_limit_with_restrictions(card: &CatalogCard, normal_copy_limit: i64) -> Option<i64> {
    let text = card.oracle_text.to_lowercase();
    if is_unlimited_basic(card) || text.contains("a deck can have any number of cards named") {
        return None;
    }
    if text.contains("a deck can have only one card named") {
        return Some(1);
    }
    let prefix = "a deck can have up to ";
    if let Some(rest) = text.split(prefix).nth(1) {
        let word = rest.split_whitespace().next().unwrap_or_default();
        let limit = match word {
            "one" => Some(1),
            "two" => Some(2),
            "three" => Some(3),
            "four" => Some(4),
            "five" => Some(5),
            "six" => Some(6),
            "seven" => Some(7),
            "eight" => Some(8),
            "nine" => Some(9),
            "ten" => Some(10),
            "eleven" => Some(11),
            "twelve" => Some(12),
            "thirteen" => Some(13),
            "fourteen" => Some(14),
            "fifteen" => Some(15),
            "sixteen" => Some(16),
            "seventeen" => Some(17),
            "eighteen" => Some(18),
            "nineteen" => Some(19),
            "twenty" => Some(20),
            _ => word.parse::<i64>().ok(),
        };
        if rest.contains("cards named") {
            return limit.filter(|limit| *limit > 0).or(Some(normal_copy_limit));
        }
    }
    Some(normal_copy_limit)
}

#[cfg(test)]
fn copy_limit(card: &CatalogCard) -> Option<i64> {
    copy_limit_with_restrictions(card, DeckRestrictions::default().normal_copy_limit)
}

#[cfg(test)]
fn validate_entries(entries: &[DeckEntry], index: Option<&ForgeIndex>) -> DeckValidation {
    validate_entries_with_restrictions(entries, index, &DeckRestrictions::default())
}

fn validate_entries_with_restrictions(
    entries: &[DeckEntry],
    index: Option<&ForgeIndex>,
    restrictions: &DeckRestrictions,
) -> DeckValidation {
    let mut warnings = ownership_warnings(entries);
    warnings.extend(single_printing_warnings(entries));
    let main_count = entries
        .iter()
        .filter(|e| e.section == "main")
        .map(|e| e.quantity)
        .sum();
    let sideboard_count = entries
        .iter()
        .filter(|e| e.section == "sideboard")
        .map(|e| e.quantity)
        .sum();
    let mut can_export = warnings.is_empty();
    if main_count < restrictions.minimum_main_deck {
        warnings.push(format!(
            "The main deck has {main_count} cards; your league requires at least {}.",
            restrictions.minimum_main_deck
        ));
        can_export = false;
    }
    if sideboard_count > restrictions.maximum_sideboard {
        warnings.push(format!(
            "The sideboard has {sideboard_count} cards; your league maximum is {}.",
            restrictions.maximum_sideboard
        ));
        can_export = false;
    }
    let mut oracle_counts: HashMap<String, (&CatalogCard, i64)> = HashMap::new();
    let mut printing_counts: HashMap<&str, (&CatalogCard, i64)> = HashMap::new();
    for entry in entries {
        let key = if entry.card.oracle_id.is_empty() {
            entry.card.name.to_lowercase()
        } else {
            entry.card.oracle_id.clone()
        };
        oracle_counts.entry(key).or_insert((&entry.card, 0)).1 += entry.quantity;
        printing_counts
            .entry(&entry.card.id)
            .or_insert((&entry.card, 0))
            .1 += entry.quantity;
    }
    for (card, count) in oracle_counts.values() {
        if let Some(limit) = copy_limit_with_restrictions(card, restrictions.normal_copy_limit) {
            if *count > limit {
                warnings.push(format!("{} has {count} copies across main deck and sideboard; its limit is {limit} across all printings.", card.name));
                can_export = false;
            }
        }
    }
    for (card, _) in printing_counts.values() {
        if let Some(index) = index {
            match index.printing(
                &card.name,
                &card.set_code,
                &card.set_name,
                &card.collector_number,
            ) {
                Some(printing) if index.supported.contains(&printing.name.to_lowercase()) => (),
                Some(_) => {
                    warnings.push(format!("{} is not present in the installed Forge card scripts. Update Forge before exporting it.", card.name));
                    can_export = false;
                }
                None => {
                    warnings.push(format!("Forge does not contain the exact printing {} ({} #{}). Choose an available printing or update Forge.", card.name, card.set_code.to_uppercase(), card.collector_number));
                    can_export = false;
                }
            }
        }
    }
    if index.is_none() {
        warnings.push("Forge's installed card resources were not found. Select the Forge installation folder in Settings to verify exact printings.".into());
        can_export = false;
    }
    warnings.sort();
    DeckValidation {
        warnings,
        main_count,
        sideboard_count,
        can_export,
    }
}

#[tauri::command]
pub async fn validate_deck(
    app: AppHandle,
    deck: DeckDraft,
    forge_data_dir: String,
) -> Result<DeckValidation, String> {
    let pool = open_pool(&app).await?;
    let restrictions = restrictions_pool(&pool).await?;
    let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;
    let entries = draft_entries(&mut transaction, &deck).await?;
    transaction.commit().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let index = forge_index(Some(&forge_data_dir));
        Ok(validate_entries_with_restrictions(
            &entries,
            index.as_deref(),
            &restrictions,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_deck(
    app: AppHandle,
    deck: DeckDraft,
    deck_dir: String,
    forge_data_dir: String,
) -> Result<DeckExport, String> {
    let _operation = database_mutation_guard()?;
    let pool = open_pool(&app).await?;
    let restrictions = restrictions_pool(&pool).await?;
    let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;
    let entries = draft_entries(&mut transaction, &deck).await?;
    transaction.commit().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let index = forge_index(Some(&forge_data_dir));
        let validation =
            validate_entries_with_restrictions(&entries, index.as_deref(), &restrictions);
        if !validation.can_export {
            return Err(format!(
                "Resolve deck validation warnings before exporting: {}",
                validation.warnings.join(" ")
            ));
        }
        let index = index.ok_or("Forge installation could not be found.")?;
        let content = serialize_deck(&deck.name, &entries, &index)?;
        write_export(&deck_dir, &deck.name, content)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn serialize_deck(name: &str, entries: &[DeckEntry], index: &ForgeIndex) -> Result<String, String> {
    let printing_errors = single_printing_warnings(entries);
    if !printing_errors.is_empty() {
        return Err(printing_errors.join(" "));
    }
    let name = validated_name(name)?;
    let mut content = format!("[metadata]\nName={name}\n[Main]\n");
    for section in ["main", "sideboard"] {
        if section == "sideboard" {
            content.push_str("[Sideboard]\n");
        }
        let mut rows = Vec::new();
        for entry in entries.iter().filter(|entry| entry.section == section) {
            let printing = index
                .printing(
                    &entry.card.name,
                    &entry.card.set_code,
                    &entry.card.set_name,
                    &entry.card.collector_number,
                )
                .ok_or_else(|| format!("No exact Forge printing for {}.", entry.card.name))?;
            if printing.name.chars().any(|c| c.is_control() || c == '|')
                || printing
                    .set_code
                    .chars()
                    .any(|c| c.is_control() || c == '|')
                || printing
                    .collector_number
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '[' | ']' | '|'))
            {
                return Err("The card catalog contains an invalid Forge card identifier.".into());
            }
            rows.push((
                printing.name.clone(),
                format!(
                    "{} {}|{}|[{}]\n",
                    entry.quantity, printing.name, printing.set_code, printing.collector_number
                ),
            ));
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, row) in rows {
            content.push_str(&row);
        }
    }
    Ok(content)
}

fn write_export(directory: &str, name: &str, content: String) -> Result<DeckExport, String> {
    let directory = PathBuf::from(directory.trim());
    if !directory.is_absolute() || !directory.is_dir() || directory.parent().is_none() {
        return Err("Choose an existing absolute constructed-deck folder in Settings.".into());
    }
    let stem: String = validated_name(name)?
        .chars()
        .take(80)
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim_end_matches(['.', ' ']);
    let stem = if stem.is_empty() { "Deck" } else { stem };
    for index in 1..=1000 {
        let file_name = if index == 1 {
            format!("Eternal League - {stem}.dck")
        } else {
            format!("Eternal League - {stem} ({index}).dck")
        };
        let path = directory.join(file_name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(content.as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(format!("Could not write deck: {error}"));
                }
                return Ok(DeckExport {
                    path: path.to_string_lossy().into_owned(),
                    content,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(format!("Cannot export deck: {error}")),
        }
    }
    Err("Too many exported decks have this name. Choose a different name.".into())
}

#[derive(Debug, Clone)]
pub struct ForgePrinting {
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub cache_folder: String,
    pub art_index: u32,
    pub art_count: u32,
    pub cache_name: String,
}

#[derive(Debug, Clone)]
struct Edition {
    code: String,
    code2: String,
    scryfall_code: String,
    name: String,
    cards: Vec<(String, String)>,
}

#[derive(Default)]
struct ForgeIndex {
    editions: Vec<Edition>,
    supported: HashSet<String>,
}

impl ForgeIndex {
    fn printing(
        &self,
        name: &str,
        set_code: &str,
        set_name: &str,
        collector: &str,
    ) -> Option<ForgePrinting> {
        for edition in self.editions.iter().filter(|edition| {
            edition.scryfall_code.eq_ignore_ascii_case(set_code)
                || edition.code.eq_ignore_ascii_case(set_code)
                || edition.name.eq_ignore_ascii_case(set_name)
        }) {
            let candidates: Vec<_> = edition
                .cards
                .iter()
                .filter(|(_, entry_name)| entry_name.eq_ignore_ascii_case(name))
                .collect();
            let mut candidates: Vec<_> = if candidates.is_empty() && name.contains(" // ") {
                edition
                    .cards
                    .iter()
                    .filter(|(_, entry_name)| {
                        entry_name.eq_ignore_ascii_case(name.split(" // ").next().unwrap_or(name))
                    })
                    .collect()
            } else {
                candidates
            };
            candidates.sort_by_key(|(number, _)| collector_sort_key(number));
            let Some((number, forge_name)) = candidates
                .iter()
                .find(|(number, _)| number.eq_ignore_ascii_case(collector))
                .copied()
            else {
                continue;
            };
            let art_index = candidates
                .iter()
                .position(|(n, _)| n.eq_ignore_ascii_case(number))?
                as u32
                + 1;
            let art_count = candidates.len() as u32;
            // Forge concatenates split-card names for MWS image names. A DFC uses its first face.
            let image_name = forge_name.replace(" // ", "");
            let cache_name = image_name
                .chars()
                .filter(|c| !matches!(c, '"' | '/' | ':' | '?'))
                .collect::<String>();
            return Some(ForgePrinting {
                name: forge_name.clone(),
                set_code: edition.code.clone(),
                collector_number: number.clone(),
                cache_folder: edition.code2.clone(),
                art_index,
                art_count,
                cache_name,
            });
        }
        None
    }
}

fn collector_sort_key(number: &str) -> String {
    let digits: String = number.chars().filter(char::is_ascii_digit).collect();
    let letters: String = number.chars().filter(|c| !c.is_ascii_digit()).collect();
    let numeric = digits.parse::<u64>().unwrap_or(0);
    if number.starts_with(&digits) && !digits.is_empty() {
        format!("{numeric:020}{letters}")
    } else {
        format!("{letters}{numeric:020}")
    }
}

fn edition_from_text(text: &str) -> Option<Edition> {
    let mut metadata = HashMap::new();
    let mut cards = Vec::new();
    let mut section = "";
    for line in text.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.starts_with('[') && line.ends_with(']') {
            section = &line[1..line.len() - 1];
            continue;
        }
        if section.eq_ignore_ascii_case("metadata") {
            if let Some((key, value)) = line.split_once('=') {
                metadata.insert(key.trim().to_lowercase(), value.trim().to_owned());
            }
        } else if is_card_entry_section(section) && !line.is_empty() && !line.starts_with('#') {
            let Some((number, rest)) = line.split_once(char::is_whitespace) else {
                continue;
            };
            let Some((rarity, rest)) = rest.trim_start().split_once(char::is_whitespace) else {
                continue;
            };
            let rest = rest.trim();
            if !number.is_empty()
                && number.chars().all(|character| {
                    !character.is_control()
                        && !character.is_whitespace()
                        && !matches!(character, '[' | ']' | '|' | '@' | '$' | '=')
                })
                && number
                    .chars()
                    .any(|character| character.is_ascii_alphanumeric())
                && matches!(rarity, "S" | "C" | "U" | "R" | "M" | "L")
                && !rest.is_empty()
            {
                let card_name = rest
                    .split(" @")
                    .next()
                    .unwrap_or(rest)
                    .split(" $")
                    .next()
                    .unwrap_or(rest)
                    .trim();
                if !card_name.is_empty() && !card_name.contains('|') {
                    cards.push((number.to_owned(), card_name.to_owned()));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    cards.retain(|(number, name)| seen.insert((number.to_lowercase(), name.to_lowercase())));
    let code = metadata.get("code")?.clone();
    Some(Edition {
        code2: metadata
            .get("code2")
            .cloned()
            .unwrap_or_else(|| code.clone()),
        scryfall_code: metadata
            .get("scryfallcode")
            .cloned()
            .unwrap_or_else(|| code.clone()),
        name: metadata.get("name").cloned().unwrap_or_default(),
        code,
        cards,
    })
}

fn is_card_entry_section(section: &str) -> bool {
    // Forge CardEdition.EditionSectionWithCollectorNumbers. Booster slot
    // definitions and custom print sheets have different grammars and must
    // not create fabricated exact-printing mappings.
    matches!(
        section.trim().to_lowercase().as_str(),
        "cards"
            | "special slot"
            | "precon product"
            | "borderless"
            | "etched"
            | "showcase"
            | "full art"
            | "extended art"
            | "alternate art"
            | "retro frame"
            | "buy a box"
            | "promo"
            | "prerelease promo"
            | "bundle"
            | "box topper"
            | "jumpstart"
            | "rebalanced"
            | "eternal"
            | "conjured"
            | "scheme"
            | "printsheets"
    )
}

pub(crate) fn resource_candidates(hint: Option<&str>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(hint) = hint.filter(|hint| !hint.trim().is_empty()) {
        let path = PathBuf::from(hint.trim());
        if path.is_absolute() {
            candidates.push(path.join("res"));
            candidates.push(path);
        }
    }
    if cfg!(windows) {
        for variable in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = env::var_os(variable) {
                let base = PathBuf::from(base);
                let base = if variable == "LOCALAPPDATA" {
                    base.join("Programs")
                } else {
                    base
                };
                if let Ok(entries) = fs::read_dir(base) {
                    let mut matches: Vec<_> = entries
                        .filter_map(Result::ok)
                        .filter(|entry| {
                            entry
                                .file_name()
                                .to_string_lossy()
                                .to_lowercase()
                                .starts_with("forge")
                        })
                        .map(|entry| entry.path().join("res"))
                        .collect();
                    matches.sort_by_key(|path| {
                        fs::metadata(path)
                            .and_then(|metadata| metadata.modified())
                            .unwrap_or(SystemTime::UNIX_EPOCH)
                    });
                    matches.reverse();
                    candidates.extend(matches);
                }
            }
        }
    } else {
        let profile = env::var_os("HOME").map(PathBuf::from);
        let mut roots = vec![
            PathBuf::from("/opt"),
            PathBuf::from("/usr/local/share"),
            PathBuf::from("/usr/share"),
        ];
        if let Some(profile) = profile {
            roots.extend([
                profile.join(".local/share"),
                profile.join("Applications"),
                profile.join("Games"),
                profile.join("games"),
                profile.join("Downloads"),
                profile,
            ]);
        }
        for root in roots {
            candidates.extend(forge_installations_under(&root));
        }
    }
    candidates
}

// Forge's Unix releases are user-extracted folders. Inspect a bounded single
// level in conventional locations; custom portable paths remain selectable.
fn forge_installations_under(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .take(10_000)
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            (name.starts_with("forge") || name.starts_with("mtg-forge"))
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
        })
        .map(|entry| entry.path().join("res"))
        .collect();
    paths.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    paths.reverse();
    paths
}

/// Read installed edition identities without loading Forge's card scripts.
pub(crate) fn catalog_editions(
    hint: Option<&str>,
) -> Result<BTreeMap<String, (String, Vec<(String, String)>)>, String> {
    let root = resource_candidates(hint)
        .into_iter()
        .find(|root| root.join("editions").is_dir() && root.join("cardsfolder").is_dir())
        .ok_or("Forge's installed edition files could not be found.")?;
    let mut editions: BTreeMap<String, (String, Vec<(String, String)>)> = BTreeMap::new();
    for entry in fs::read_dir(root.join("editions")).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().is_ok_and(|kind| kind.is_file())
            || !entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
        {
            continue;
        }
        let text = fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
        let Some(edition) = edition_from_text(&text) else {
            continue;
        };
        let mut hash = 0xcbf29ce484222325u64;
        for byte in text.bytes() {
            hash = (hash ^ byte as u64).wrapping_mul(0x100000001b3);
        }
        let code = edition.scryfall_code.to_lowercase();
        if code.is_empty()
            || !code
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        {
            continue;
        }
        if let Some((stamp, cards)) = editions.get_mut(&code) {
            let previous = u64::from_str_radix(stamp, 16).unwrap_or(0);
            *stamp = format!("{:016x}", previous.wrapping_add(hash));
            cards.extend(edition.cards);
        } else {
            editions.insert(code, (format!("{hash:016x}"), edition.cards));
        }
    }
    Ok(editions)
}

type CachedIndex = (PathBuf, Option<SystemTime>, Arc<ForgeIndex>);
static FORGE_INDEX: OnceLock<Mutex<Option<CachedIndex>>> = OnceLock::new();

fn forge_index(hint: Option<&str>) -> Option<Arc<ForgeIndex>> {
    let res = resource_candidates(hint)
        .into_iter()
        .find(|path| path.join("editions").is_dir() && path.join("cardsfolder").is_dir())?;
    let modified = fs::metadata(res.join("cardsfolder").join("cardsfolder.zip"))
        .and_then(|m| m.modified())
        .ok();
    let cache = FORGE_INDEX.get_or_init(|| Mutex::new(None));
    let mut cached = cache.lock().ok()?;
    if let Some((root, stamp, index)) = &*cached {
        if *root == res && *stamp == modified {
            return Some(index.clone());
        }
    }
    let mut index = ForgeIndex::default();
    for entry in fs::read_dir(res.join("editions")).ok()?.flatten() {
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
        {
            if let Ok(text) = fs::read_to_string(entry.path()) {
                if let Some(edition) = edition_from_text(&text) {
                    index.editions.push(edition);
                }
            }
        }
    }
    let zip_path = res.join("cardsfolder").join("cardsfolder.zip");
    if let Ok(file) = fs::File::open(zip_path) {
        if let Ok(mut archive) = zip::ZipArchive::new(file) {
            for i in 0..archive.len() {
                if let Ok(entry) = archive.by_index(i) {
                    if !entry.name().ends_with(".txt") || entry.size() > 1024 * 1024 {
                        continue;
                    }
                    let mut text = String::new();
                    if entry.take(1024 * 1024).read_to_string(&mut text).is_ok() {
                        add_script_names(&text, &mut index.supported);
                    }
                }
            }
        }
    }
    // Custom/snapshot Forge builds may have loose scripts alongside their archive.
    read_loose_scripts(&res.join("cardsfolder"), 2, &mut index.supported);
    let index = Arc::new(index);
    *cached = Some((res, modified, index.clone()));
    Some(index)
}

fn add_script_names(text: &str, names: &mut HashSet<String>) {
    let mut faces = Vec::new();
    for line in text.lines() {
        if let Some(name) = line.trim().strip_prefix("Name:") {
            let name = name.trim().to_lowercase();
            names.insert(name.clone());
            faces.push(name);
        }
    }
    if text
        .lines()
        .any(|line| line.trim() == "AlternateMode:Split")
        && faces.len() >= 2
    {
        names.insert(faces.join(" // "));
    }
}

fn read_loose_scripts(directory: &Path, depth: usize, names: &mut HashSet<String>) {
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() && depth > 0 {
                read_loose_scripts(&entry.path(), depth - 1, names);
            } else if kind.is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("txt"))
            {
                if let Ok(text) = fs::read_to_string(entry.path()) {
                    add_script_names(&text, names);
                }
            }
        }
    }
}

/// Exact collector-number mappings only; callers fall back to Scryfall when unavailable.
pub fn resolve_printing_with_hint(
    name: &str,
    set_code: &str,
    set_name: &str,
    collector_number: &str,
    install_hint: Option<&str>,
) -> Option<ForgePrinting> {
    forge_index(install_hint)?.printing(name, set_code, set_name, collector_number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    fn card(id: &str, oracle: &str, name: &str, number: &str) -> CatalogCard {
        CatalogCard {
            id: id.into(),
            oracle_id: oracle.into(),
            name: name.into(),
            set_code: "tst".into(),
            set_name: "Test Set".into(),
            collector_number: number.into(),
            rarity: "common".into(),
            mana_cost: "{G}".into(),
            cmc: 1.0,
            type_line: "Creature".into(),
            oracle_text: "".into(),
            colors: vec!["G".into()],
            image_uri: None,
            back_image_uri: None,
            owned: 100,
            oracle_owned: 100,
            forge_set_code: None,
        }
    }

    fn test_index() -> ForgeIndex {
        ForgeIndex { editions: vec![edition_from_text("[metadata]\nCode=TST\nCode2=TS\nScryfallCode=tst\nName=Test Set\n[cards]\n1 C Elf @Artist\n2 C Elf @Other Artist\n3 L Forest @Artist\n").unwrap()], supported: HashSet::from(["elf".into(), "forest".into()]) }
    }

    #[test]
    fn unix_installation_search_is_shallow_and_supports_extracted_forge_folders() {
        let root = tempfile::tempdir().unwrap();
        let forge = root.path().join("forge-gui-desktop-2.0.13");
        fs::create_dir_all(forge.join("res")).unwrap();
        fs::create_dir_all(
            root.path()
                .join("unrelated")
                .join("forge-nested")
                .join("res"),
        )
        .unwrap();
        fs::write(root.path().join("forge-not-a-directory"), "ignored").unwrap();
        let paths = forge_installations_under(root.path());
        assert_eq!(paths, vec![forge.join("res")]);
        assert!(
            resource_candidates(forge.to_str()).starts_with(&[forge.join("res"), forge.clone()])
        );
    }

    #[test]
    fn copy_limits_use_oracle_identity_and_exceptions() {
        let mut forest = card("f", "f", "Forest", "3");
        forest.type_line = "Basic Land — Forest".into();
        let mut entries = vec![
            DeckEntry {
                card: forest,
                section: "main".into(),
                quantity: 60,
            },
            DeckEntry {
                card: card("a", "oracle", "Elf", "1"),
                section: "main".into(),
                quantity: 3,
            },
            DeckEntry {
                card: card("b", "oracle", "Elf", "2"),
                section: "sideboard".into(),
                quantity: 2,
            },
        ];
        let report = validate_entries(&entries, Some(&test_index()));
        assert!(!report.can_export);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("5 copies")));
        entries[1].card.oracle_text = "A deck can have any number of cards named Elf.".into();
        entries[2].card.oracle_text = entries[1].card.oracle_text.clone();
        assert!(validate_entries(&entries, Some(&test_index()))
            .warnings
            .iter()
            .any(|warning| warning.contains("Choose one printing")));
        entries[2].card = entries[1].card.clone();
        assert!(validate_entries(&entries, Some(&test_index())).can_export);
        let mut dwarves = card("d", "d", "Seven Dwarves", "4");
        dwarves.oracle_text = "A deck can have up to seven cards named Seven Dwarves.".into();
        assert_eq!(copy_limit(&dwarves), Some(7));
        dwarves.oracle_text = "A deck can have only one card named Once More with Feeling.".into();
        assert_eq!(copy_limit(&dwarves), Some(1));
    }

    #[test]
    fn unowned_basic_lands_are_unlimited_but_exact_printings_still_matter() {
        let mut forest = card("f", "f", "Forest", "3");
        forest.type_line = "Basic Land — Forest".into();
        forest.owned = 0;
        let mut entries = vec![DeckEntry {
            card: forest,
            section: "main".into(),
            quantity: 60,
        }];
        let report = validate_entries(&entries, Some(&test_index()));
        assert!(report.can_export);
        assert!(report.warnings.is_empty());
        entries[0].card.collector_number = "missing".into();
        let report = validate_entries(&entries, Some(&test_index()));
        assert!(!report.can_export);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("exact printing")));
        assert!(!report
            .warnings
            .iter()
            .any(|warning| warning.contains("you own")));

        for (name, kind) in [
            ("Snow-Covered Forest", "Basic Snow Land — Forest"),
            ("Wastes", "Basic Land"),
        ] {
            let mut basic = card("basic", "basic", name, "1");
            basic.type_line = kind.into();
            basic.owned = 0;
            assert_eq!(copy_limit(&basic), None);
            assert!(!validate_entries(
                &[DeckEntry {
                    card: basic,
                    section: "main".into(),
                    quantity: 60
                }],
                None
            )
            .warnings
            .iter()
            .any(|warning| warning.contains("you own")));
        }
        let mut nonbasic = card("nonbasic", "nonbasic", "Command Tower", "1");
        nonbasic.type_line = "Land".into();
        nonbasic.owned = 0;
        nonbasic.oracle_owned = 0;
        assert_eq!(copy_limit(&nonbasic), Some(4));
        assert!(validate_entries(
            &[DeckEntry {
                card: nonbasic,
                section: "main".into(),
                quantity: 1
            }],
            None
        )
        .warnings
        .iter()
        .any(|warning| warning.contains("you own")));
    }

    #[test]
    fn configured_deck_restrictions_apply_without_removing_card_exceptions() {
        let mut forest = card("f", "f", "Forest", "3");
        forest.type_line = "Basic Land — Forest".into();
        forest.owned = 0;
        let mut elf = card("elf", "elf", "Elf", "1");
        elf.owned = 1;
        elf.oracle_owned = 1;
        let mut entries = vec![
            DeckEntry {
                card: forest,
                section: "main".into(),
                quantity: 8,
            },
            DeckEntry {
                card: elf,
                section: "main".into(),
                quantity: 2,
            },
        ];
        let mut restrictions = DeckRestrictions {
            minimum_main_deck: 10,
            maximum_sideboard: 2,
            normal_copy_limit: 2,
        };
        let report =
            validate_entries_with_restrictions(&entries, Some(&test_index()), &restrictions);
        assert!(!report.can_export);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("you own 1")));
        entries[1].card.owned = 2;
        entries[1].card.oracle_owned = 2;
        assert!(
            validate_entries_with_restrictions(&entries, Some(&test_index()), &restrictions)
                .can_export
        );
        restrictions.minimum_main_deck = 11;
        assert!(
            !validate_entries_with_restrictions(&entries, Some(&test_index()), &restrictions)
                .can_export
        );
        restrictions.minimum_main_deck = 10;
        entries.push(DeckEntry {
            card: entries[0].card.clone(),
            section: "sideboard".into(),
            quantity: 3,
        });
        assert!(
            !validate_entries_with_restrictions(&entries, Some(&test_index()), &restrictions)
                .can_export
        );
        entries.pop();
        restrictions.normal_copy_limit = 1;
        assert!(
            !validate_entries_with_restrictions(&entries, Some(&test_index()), &restrictions)
                .can_export
        );
        entries[1].card.oracle_text = "A deck can have any number of cards named Elf.".into();
        assert!(
            validate_entries_with_restrictions(&entries, Some(&test_index()), &restrictions)
                .can_export
        );
        entries[1].card.oracle_text = "A deck can have up to seven cards named Elf.".into();
        assert!(
            validate_entries_with_restrictions(&entries, Some(&test_index()), &restrictions)
                .can_export
        );
    }

    #[test]
    fn deck_restriction_settings_keep_defaults_and_reject_invalid_values() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(SqliteConnectOptions::new().in_memory(true))
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(
                restrictions_pool(&pool).await.unwrap(),
                DeckRestrictions::default()
            );
            let custom = serde_json::json!({"league":{"deckRestrictions":{"minimumMainDeck":40,"maximumSideboard":0,"normalCopyLimit":1,"requireOwnedCards":true}}});
            sqlx::query("INSERT INTO settings(key,value) VALUES('test.allow-league-settings','1')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings(key,value) VALUES('app',?)")
                .bind(custom.to_string())
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(
                restrictions_pool(&pool).await.unwrap(),
                DeckRestrictions {
                    minimum_main_deck: 40,
                    maximum_sideboard: 0,
                    normal_copy_limit: 1,
                }
            );
            for invalid in [
                serde_json::json!({"minimumMainDeck":0}),
                serde_json::json!({"maximumSideboard":101}),
                serde_json::json!({"normalCopyLimit":0}),
                serde_json::json!({"normalCopyLimit":"four"}),
            ] {
                sqlx::query("UPDATE settings SET value=? WHERE key='app'")
                    .bind(serde_json::json!({"league":{"deckRestrictions":invalid}}).to_string())
                    .execute(&pool)
                    .await
                    .unwrap();
                assert!(restrictions_pool(&pool).await.is_err());
            }
            pool.close().await;
        });
    }

    #[test]
    fn exact_printings_are_serialized_and_never_substituted() {
        let index = test_index();
        let entry = DeckEntry {
            card: card("a", "o", "Elf", "2"),
            section: "main".into(),
            quantity: 4,
        };
        assert_eq!(
            serialize_deck("Elves", &[entry], &index).unwrap(),
            "[metadata]\nName=Elves\n[Main]\n4 Elf|TST|[2]\n[Sideboard]\n"
        );
        let mapping = index.printing("Elf", "tst", "Test Set", "2").unwrap();
        assert_eq!(mapping.cache_folder, "TS");
        assert_eq!(mapping.art_index, 2);
        assert_eq!(mapping.art_count, 2);
        assert!(index.printing("Elf", "tst", "Test Set", "99").is_none());
        assert!(validated_name("Deck\n[Main]").is_err());
    }

    #[test]
    fn alternate_edition_sections_map_import_and_save_exact_printings() {
        const TEXT: &str = include_str!("../test-fixtures/forge-printing-sections.txt");
        let edition = edition_from_text(TEXT).unwrap();
        assert_eq!(edition.cards.len(), 6);
        let index = ForgeIndex {
            editions: vec![edition],
            supported: HashSet::from([
                "llanowar elves".into(),
                "forest".into(),
                "plains".into(),
                "another creature".into(),
            ]),
        };
        assert_eq!(
            index
                .printing("Forest", "tst", "Test Set", "290")
                .unwrap()
                .collector_number,
            "290"
        );
        assert_eq!(
            index
                .printing("Plains", "tst", "Test Set", "293")
                .unwrap()
                .collector_number,
            "293"
        );
        assert_eq!(
            index
                .printing("Llanowar Elves", "tst", "Test Set", "429")
                .unwrap()
                .art_index,
            2
        );
        assert_eq!(
            index
                .printing("Llanowar Elves", "tst", "Test Set", "439")
                .unwrap()
                .art_index,
            3
        );
        for number in ["440", "900", "901", "999"] {
            assert!(index.editions[0]
                .cards
                .iter()
                .all(|(candidate, _)| candidate != number));
        }
        let installation = tempfile::tempdir().unwrap();
        let res = installation.path().join("res");
        fs::create_dir_all(res.join("editions")).unwrap();
        fs::create_dir_all(res.join("cardsfolder")).unwrap();
        fs::write(res.join("editions").join("Test.txt"), TEXT).unwrap();
        let catalog = catalog_editions(installation.path().to_str()).unwrap();
        let numbers: HashSet<_> = catalog["tst"]
            .1
            .iter()
            .map(|(number, _)| number.as_str())
            .collect();
        assert!(numbers.contains("290") && numbers.contains("429") && numbers.contains("439"));
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            sqlx::query("UPDATE collection SET quantity=4 WHERE card_id='elf'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,metadata_json) VALUES('elf227','elf','Llanowar Elves','tst','Test Set','227','common','Creature — Elf Druid','{}'),('elf429','elf','Llanowar Elves','tst','Test Set','429','mythic','Creature — Elf Druid','{}'),('forest290','forest','Forest','tst','Test Set','290','common','Basic Land — Forest','{}')").execute(&pool).await.unwrap();
            let cards = [("elf429", 4), ("forest290", 56)]
                .into_iter()
                .map(|(id, quantity)| DraftCard {
                    card_id: id.into(),
                    section: "main".into(),
                    quantity,
                })
                .collect();
            let directory = tempfile::tempdir().unwrap();
            let saved = save_synced_with_index(
                &pool,
                DeckDraft {
                    id: None,
                    name: "Chosen showcase artwork".into(),
                    cards,
                },
                directory.path().to_str().unwrap(),
                &index,
            )
            .await
            .unwrap();
            assert!(saved.export.content.contains("4 Llanowar Elves|TST|[429]"));
            assert!(saved.export.content.contains("56 Forest|TST|[290]"));
            assert_eq!(
                saved
                    .deck
                    .cards
                    .iter()
                    .map(|entry| entry.quantity)
                    .sum::<i64>(),
                60
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='elf'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                4
            );
            pool.close().await;
        });
    }

    #[test]
    fn double_faced_cards_use_the_forge_front_name() {
        let index = ForgeIndex { editions: vec![edition_from_text("[metadata]\nCode=ISD\nScryfallCode=isd\nName=Innistrad\n[cards]\n51 C Delver of Secrets @Nils Hamm\n").unwrap()], supported: HashSet::from(["delver of secrets".into()]) };
        let mut delver = card(
            "delver",
            "delver",
            "Delver of Secrets // Insectile Aberration",
            "51",
        );
        delver.set_code = "isd".into();
        delver.set_name = "Innistrad".into();
        let content = serialize_deck(
            "Delver",
            &[DeckEntry {
                card: delver,
                section: "main".into(),
                quantity: 4,
            }],
            &index,
        )
        .unwrap();
        assert!(content.contains("4 Delver of Secrets|ISD|[51]"));
        assert!(!content.contains("Insectile Aberration"));
    }

    #[test]
    fn split_card_scripts_include_the_combined_lookup_name() {
        let mut names = HashSet::new();
        add_script_names(
            "Name:Fire\nAlternateMode:Split\nALTERNATE\nName:Ice\n",
            &mut names,
        );
        assert!(names.contains("fire // ice"));
        assert!(names.contains("fire"));
    }

    #[test]
    fn exports_cannot_escape_or_overwrite() {
        let folder = tempfile::tempdir().unwrap();
        let first = write_export(
            folder.path().to_str().unwrap(),
            "../My:Deck",
            "first".into(),
        )
        .unwrap();
        let second = write_export(
            folder.path().to_str().unwrap(),
            "../My:Deck",
            "second".into(),
        )
        .unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(Path::new(&first.path).parent().unwrap(), folder.path());
        assert_eq!(fs::read_to_string(first.path).unwrap(), "first");
    }

    #[test]
    fn automatic_saves_update_one_forge_file_and_roll_back_failures() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    SqliteConnectOptions::new()
                        .in_memory(true)
                        .foreign_keys(true),
                )
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/002_catalog.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings(key,value) VALUES('test.unlocked-sets','[\"tst\"]')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,metadata_json) VALUES('elf','elf','Elf','tst','Test Set','1','common','Creature','{}')").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('elf',2)")
                .execute(&pool)
                .await
                .unwrap();
            let folder = tempfile::tempdir().unwrap();
            let directory = folder.path().to_str().unwrap();
            let draft = |id, name: &str, quantity| DeckDraft {
                id,
                name: name.into(),
                cards: vec![DraftCard {
                    card_id: "elf".into(),
                    section: "main".into(),
                    quantity,
                }],
            };
            // Incomplete owned drafts are immediately available in Forge's editor.
            let first =
                save_synced_with_index(&pool, draft(None, "First", 1), directory, &test_index())
                    .await
                    .unwrap();
            let path = first.export.path.clone();
            assert!(fs::read_to_string(&path).unwrap().contains("1 Elf|TST|[1]"));
            let second = save_synced_with_index(
                &pool,
                draft(Some(first.deck.id.clone()), "Renamed", 2),
                directory,
                &test_index(),
            )
            .await
            .unwrap();
            assert_eq!(path, second.export.path);
            assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
            let expected = fs::read_to_string(&path).unwrap();
            assert!(expected.contains("Name=Renamed"));
            assert!(expected.contains("2 Elf|TST|[1]"));
            assert!(save_synced_with_index(
                &pool,
                draft(Some(first.deck.id.clone()), "Unowned", 3),
                directory,
                &test_index()
            )
            .await
            .is_err());
            assert!(save_synced_with_index(
                &pool,
                draft(Some(first.deck.id.clone()), "Missing folder", 1),
                folder.path().join("missing").to_str().unwrap(),
                &test_index()
            )
            .await
            .is_err());
            assert_eq!(
                load_pool(&pool, &first.deck.id).await.unwrap().name,
                "Renamed"
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), expected);
            // A database failure after replacing the Forge file restores both sides.
            sqlx::raw_sql("CREATE TRIGGER fail_export_mapping BEFORE UPDATE ON settings WHEN NEW.key LIKE 'forge_export:%' BEGIN SELECT RAISE(ABORT,'test mapping failure'); END;").execute(&pool).await.unwrap();
            assert!(save_synced_with_index(
                &pool,
                draft(Some(first.deck.id.clone()), "Rollback", 1),
                directory,
                &test_index()
            )
            .await
            .is_err());
            assert_eq!(
                load_pool(&pool, &first.deck.id).await.unwrap().name,
                "Renamed"
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), expected);
            assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='elf'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                2
            );
            pool.close().await;
        });
    }

    #[test]
    fn managed_exports_do_not_overwrite_other_files_and_can_undo_new_files() {
        let folder = tempfile::tempdir().unwrap();
        let directory = folder.path().to_str().unwrap();
        let collision = folder.path().join("Eternal League - Mine - abc.dck");
        fs::write(&collision, "user file").unwrap();
        assert!(ManagedExport::write(directory, "abc", "Mine", "replacement", &[]).is_err());
        assert_eq!(fs::read_to_string(&collision).unwrap(), "user file");
        let added = ManagedExport::write(directory, "new", "New", "new file", &[]).unwrap();
        let path = added.path.clone();
        assert!(path.is_file());
        added.rollback().unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }

    async fn managed_file_fixture() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .in_memory(true)
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../migrations/002_catalog.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('test.unlocked-sets','[\"tst\"]')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json) VALUES('elf','elf','Elf','tst','1','common','{}'),('unowned','other','Unowned','tst','2','rare','{}')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('elf',2)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO decks(id,name) VALUES('deck','Stored deck'),('invalid','Invalid unsynced deck')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('deck','elf','main',2),('invalid','unowned','main',1)").execute(&pool).await.unwrap();
        pool
    }

    #[test]
    fn mixed_oracle_printings_are_rejected_but_legacy_decks_remain_readable() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,metadata_json) VALUES('alternate','elf','Elf','tst','Test Set','2','common','Creature','{}')").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO decks(id,name) VALUES('legacy-mixed','Legacy mixed artwork')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('legacy-mixed','elf','main',1),('legacy-mixed','alternate','sideboard',1)").execute(&pool).await.unwrap();
            let legacy = load_pool(&pool, "legacy-mixed").await.unwrap();
            assert_eq!(legacy.cards.len(), 2);
            assert!(legacy.cards.iter().any(|entry| entry.card.id == "elf"));
            assert!(legacy
                .cards
                .iter()
                .any(|entry| entry.card.id == "alternate"));
            assert!(validate_entries(&legacy.cards, Some(&test_index()))
                .warnings
                .iter()
                .any(|warning| warning.contains("Choose one printing")));
            assert!(serialize_deck(&legacy.name, &legacy.cards, &test_index())
                .unwrap_err()
                .contains("Choose one printing"));
            assert!(duplicate_pool(&pool, &legacy.id)
                .await
                .unwrap_err()
                .contains("Choose one printing"));
            let mixed = DeckDraft {
                id: Some(legacy.id.clone()),
                name: "Uncorrected artwork".into(),
                cards: legacy
                    .cards
                    .iter()
                    .map(|entry| DraftCard {
                        card_id: entry.card.id.clone(),
                        section: entry.section.clone(),
                        quantity: entry.quantity,
                    })
                    .collect(),
            };
            assert!(save_pool(&pool, mixed.clone())
                .await
                .unwrap_err()
                .contains("Choose one printing"));
            let directory = tempfile::tempdir().unwrap();
            assert!(save_synced_with_index(
                &pool,
                mixed,
                directory.path().to_str().unwrap(),
                &test_index()
            )
            .await
            .unwrap_err()
            .contains("Choose one printing"));
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
            assert_eq!(
                load_pool(&pool, &legacy.id).await.unwrap().name,
                "Legacy mixed artwork"
            );
            assert_eq!(load_pool(&pool, &legacy.id).await.unwrap().cards.len(), 2);
            let corrected = save_pool(
                &pool,
                DeckDraft {
                    id: Some(legacy.id.clone()),
                    name: "Chosen artwork".into(),
                    cards: vec![
                        DraftCard {
                            card_id: "alternate".into(),
                            section: "main".into(),
                            quantity: 1,
                        },
                        DraftCard {
                            card_id: "alternate".into(),
                            section: "sideboard".into(),
                            quantity: 1,
                        },
                    ],
                },
            )
            .await
            .unwrap();
            assert!(corrected
                .cards
                .iter()
                .all(|entry| entry.card.id == "alternate"));
            assert!(serialize_deck(&corrected.name, &corrected.cards, &test_index()).is_ok());
            assert!(duplicate_pool(&pool, &corrected.id).await.is_ok());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='elf'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                2
            );
            pool.close().await;
        });
    }

    #[test]
    fn pooled_unlocked_printings_share_budget_and_locked_or_novelty_entries_cannot_be_saved() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,metadata_json,type_line) VALUES('alternate','elf','Elf','tst','Test Set','2','common','{}','Creature'),('locked-basic','forest','Forest','future','Future','3','common','{}','Basic Land — Forest'),('gold','elf','Elf','tst','Test Set','1','common','{\"border_color\":\"gold\"}','Creature')").execute(&pool).await.unwrap();
            let entry = |id: &str, section: &str, quantity| DraftCard {
                card_id: id.into(),
                section: section.into(),
                quantity,
            };
            let draft = |name: &str, cards| DeckDraft {
                id: None,
                name: name.into(),
                cards,
            };
            let saved = save_pool(
                &pool,
                draft(
                    "Alternate artwork",
                    vec![
                        entry("alternate", "main", 1),
                        entry("alternate", "sideboard", 1),
                    ],
                ),
            )
            .await
            .unwrap();
            assert_eq!(
                saved.cards.iter().map(|entry| entry.quantity).sum::<i64>(),
                2
            );
            assert!(saved.cards.iter().any(|entry| entry.card.id == "alternate"
                && entry.card.owned == 0
                && entry.card.oracle_owned == 2));
            assert!(duplicate_pool(&pool, &saved.id).await.is_ok());
            assert!(save_pool(
                &pool,
                draft(
                    "Over pooled budget",
                    vec![
                        entry("alternate", "main", 2),
                        entry("alternate", "sideboard", 1)
                    ]
                )
            )
            .await
            .unwrap_err()
            .contains("needs 3 copies"));
            for (id, message) in [("locked-basic", "locked"), ("gold", "not an eligible")] {
                let invalid = draft("Unavailable printing", vec![entry(id, "main", 60)]);
                assert!(save_pool(&pool, invalid.clone())
                    .await
                    .unwrap_err()
                    .contains(message));
                let folder = tempfile::tempdir().unwrap();
                assert!(save_synced_with_index(
                    &pool,
                    invalid,
                    folder.path().to_str().unwrap(),
                    &test_index()
                )
                .await
                .unwrap_err()
                .contains(message));
                assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 0);
            }
            sqlx::query("INSERT INTO decks(id,name) VALUES('legacy-locked','Old deck')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('legacy-locked','locked-basic','main',60)").execute(&pool).await.unwrap();
            assert_eq!(
                load_pool(&pool, "legacy-locked").await.unwrap().cards[0].quantity,
                60
            );
            assert!(duplicate_pool(&pool, "legacy-locked")
                .await
                .unwrap_err()
                .contains("locked"));
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='elf'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                2
            );
            pool.close().await;
        });
    }

    #[test]
    fn globally_unlocked_artwork_uses_pooled_ownership_without_collecting_each_expansion() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            sqlx::query(
                "UPDATE settings SET value='[\"tst\",\"nxt\"]' WHERE key='test.unlocked-sets'",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,metadata_json) VALUES('next-owned','elf','Elf','nxt','Next Set','1','common','Creature','{}'),('next-art','elf','Elf','nxt','Next Set','2','common','Creature','{}'),('next-land','forest','Forest','nxt','Next Set','3','common','Basic Land — Forest','{}'),('locked-art','elf','Elf','future','Future Set','2','common','Creature','{}')").execute(&pool).await.unwrap();
            let entry = |id: &str, section: &str, quantity| DraftCard {
                card_id: id.into(),
                section: section.into(),
                quantity,
            };
            let draft = |name: &str, cards| DeckDraft {
                id: None,
                name: name.into(),
                cards,
            };
            let uncollected = draft(
                "Uncollected expansion artwork",
                vec![entry("next-art", "main", 2)],
            );
            let selected = save_pool(&pool, uncollected.clone()).await.unwrap();
            assert_eq!(selected.cards[0].card.set_code, "nxt");
            assert_eq!(selected.cards[0].card.owned, 0);
            assert_eq!(selected.cards[0].card.oracle_owned, 2);
            sqlx::query("INSERT INTO decks(id,name) VALUES('legacy-next','Legacy next')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('legacy-next','next-art','main',2)").execute(&pool).await.unwrap();
            assert!(duplicate_pool(&pool, "legacy-next").await.is_ok());
            let mut index = test_index();
            index.editions.push(edition_from_text("[metadata]\nCode=NXT\nScryfallCode=nxt\nName=Next Set\n[cards]\n1 C Elf @Artist\n[showcase]\n2 C Elf @Other Artist\n[full art]\n3 L Forest @Artist\n").unwrap());
            let directory = tempfile::tempdir().unwrap();
            let exported = save_synced_with_index(
                &pool,
                uncollected,
                directory.path().to_str().unwrap(),
                &index,
            )
            .await
            .unwrap();
            assert!(exported.export.content.contains("2 Elf|NXT|[2]"));
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
            let locked = draft(
                "Still globally locked",
                vec![entry("locked-art", "main", 1)],
            );
            assert!(save_pool(&pool, locked.clone())
                .await
                .unwrap_err()
                .contains("locked until its global league unlock date"));
            assert!(save_synced_with_index(
                &pool,
                locked,
                directory.path().to_str().unwrap(),
                &index
            )
            .await
            .unwrap_err()
            .contains("locked until its global league unlock date"));
            assert_eq!(
                fs::read_to_string(&exported.export.path).unwrap(),
                exported.export.content
            );
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
            sqlx::query("INSERT INTO decks(id,name) VALUES('legacy-future','Legacy future')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('legacy-future','locked-art','main',1)").execute(&pool).await.unwrap();
            assert!(duplicate_pool(&pool, "legacy-future")
                .await
                .unwrap_err()
                .contains("locked until its global league unlock date"));
            let basic = save_pool(
                &pool,
                draft("Free new-set basics", vec![entry("next-land", "main", 60)]),
            )
            .await
            .unwrap();
            assert_eq!(basic.cards[0].quantity, 60);
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('next-owned',1)")
                .execute(&pool)
                .await
                .unwrap();
            let saved = save_synced_with_index(
                &pool,
                draft(
                    "Collected expansion artwork",
                    vec![entry("next-art", "main", 3), entry("next-land", "main", 57)],
                ),
                directory.path().to_str().unwrap(),
                &index,
            )
            .await
            .unwrap();
            assert!(saved.export.content.contains("3 Elf|NXT|[2]"));
            assert!(saved
                .deck
                .cards
                .iter()
                .any(|entry| entry.card.id == "next-art"
                    && entry.card.owned == 0
                    && entry.card.oracle_owned == 3));
            assert!(duplicate_pool(&pool, "legacy-next").await.is_ok());
            assert!(save_pool(
                &pool,
                draft(
                    "Still pooled across sets",
                    vec![
                        entry("next-art", "main", 2),
                        entry("next-art", "sideboard", 2)
                    ]
                )
            )
            .await
            .unwrap_err()
            .contains("needs 4 copies"));
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT SUM(quantity) FROM collection")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                3
            );
            pool.close().await;
        });
    }

    async fn track_test_files(pool: &SqlitePool, id: &str, paths: &[PathBuf]) {
        let values: Vec<_> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(format!("forge_export:{id}")).bind(serde_json::to_string(&values).unwrap()).execute(pool).await.unwrap();
    }

    async fn test_tracked_files(pool: &SqlitePool, id: &str) -> Vec<PathBuf> {
        let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
            .bind(format!("forge_export:{id}"))
            .fetch_optional(pool)
            .await
            .unwrap();
        tracked_paths(value)
            .unwrap()
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }

    #[test]
    fn tracked_exports_migrate_without_reexporting_decks_and_are_idempotent() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            let folder = tempfile::tempdir().unwrap();
            let original = folder.path().join("Eternal League - Legacy - deck.dck");
            let user_file = folder.path().join("My own deck.dck");
            let content = "[metadata]\nName=Legacy contents\n[Main]\n2 Elf|TST|[1]\n";
            fs::write(&original, content).unwrap();
            fs::write(&user_file, "user contents").unwrap();
            track_test_files(&pool, "deck", &[original.clone()]).await;
            let first = migrate_export_folder_pool(&pool, folder.path().to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(first.moved, 1);
            assert!(!original.exists());
            let tracked = test_tracked_files(&pool, "deck").await;
            assert_eq!(tracked.len(), 1);
            let managed = managed_deck_directory(folder.path().to_str().unwrap()).unwrap();
            assert_eq!(tracked[0].parent(), Some(managed.as_path()));
            assert_eq!(fs::read_to_string(&tracked[0]).unwrap(), content);
            assert_eq!(fs::read_to_string(&user_file).unwrap(), "user contents");
            assert_eq!(fs::read_dir(&managed).unwrap().count(), 1);
            assert!(test_tracked_files(&pool, "invalid").await.is_empty());
            let second = migrate_export_folder_pool(&pool, folder.path().to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(
                (second.moved, second.archived, second.deduplicated),
                (0, 0, 0)
            );
            assert_eq!(test_tracked_files(&pool, "deck").await, tracked);
            assert_eq!(load_pool(&pool, "deck").await.unwrap().name, "Stored deck");
            assert_eq!(
                load_pool(&pool, "invalid").await.unwrap().cards[0]
                    .card
                    .owned,
                0
            );
            pool.close().await;
        });
    }

    #[test]
    fn migration_keeps_one_active_file_and_archives_distinct_previous_contents() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            let current = tempfile::tempdir().unwrap();
            let old = [
                tempfile::tempdir().unwrap(),
                tempfile::tempdir().unwrap(),
                tempfile::tempdir().unwrap(),
            ];
            let paths: Vec<_> = old
                .iter()
                .map(|folder| folder.path().join("Eternal League - Deck - deck.dck"))
                .collect();
            for (index, path) in paths.iter().enumerate() {
                fs::write(
                    path,
                    if index == 0 {
                        "superseded contents"
                    } else {
                        "current contents"
                    },
                )
                .unwrap();
                fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .unwrap()
                    .set_modified(
                        SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(100 + index as u64),
                    )
                    .unwrap();
            }
            track_test_files(&pool, "deck", &paths).await;
            let report = migrate_export_folder_pool(&pool, current.path().to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(
                (report.moved, report.archived, report.deduplicated),
                (1, 1, 1)
            );
            assert!(paths.iter().all(|path| !path.exists()));
            let tracked = test_tracked_files(&pool, "deck").await;
            assert_eq!(tracked.len(), 2);
            let active: Vec<_> = tracked
                .iter()
                .filter(|path| path.extension().is_some_and(|extension| extension == "dck"))
                .collect();
            assert_eq!(active.len(), 1);
            assert_eq!(fs::read_to_string(active[0]).unwrap(), "current contents");
            let archived = tracked
                .iter()
                .find(|path| path.extension().is_none_or(|extension| extension != "dck"))
                .unwrap();
            assert_eq!(fs::read_to_string(archived).unwrap(), "superseded contents");
            let second = migrate_export_folder_pool(&pool, current.path().to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(
                (second.moved, second.archived, second.deduplicated),
                (0, 0, 0)
            );
            assert_eq!(test_tracked_files(&pool, "deck").await, tracked);
            pool.close().await;
        });
    }

    #[test]
    fn migration_collisions_and_database_failure_preserve_original_files() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("Eternal League - Deck - deck.dck");
            fs::write(&source, "owned contents").unwrap();
            let managed = managed_deck_directory(root.path().to_str().unwrap()).unwrap();
            let collision = managed.join(source.file_name().unwrap());
            fs::write(&collision, "untracked user file").unwrap();
            track_test_files(&pool, "deck", &[source.clone()]).await;
            sqlx::raw_sql("CREATE TRIGGER fail_migration BEFORE UPDATE ON settings WHEN NEW.key='forge_export:deck' BEGIN SELECT RAISE(ABORT,'test migration failure'); END;").execute(&pool).await.unwrap();
            assert!(
                migrate_export_folder_pool(&pool, root.path().to_str().unwrap())
                    .await
                    .is_err()
            );
            assert_eq!(fs::read_to_string(&source).unwrap(), "owned contents");
            assert_eq!(
                fs::read_to_string(&collision).unwrap(),
                "untracked user file"
            );
            assert_eq!(fs::read_dir(&managed).unwrap().count(), 1);
            assert_eq!(
                test_tracked_files(&pool, "deck").await,
                vec![source.clone()]
            );
            sqlx::query("DROP TRIGGER fail_migration")
                .execute(&pool)
                .await
                .unwrap();
            migrate_export_folder_pool(&pool, root.path().to_str().unwrap())
                .await
                .unwrap();
            let tracked = test_tracked_files(&pool, "deck").await;
            assert_ne!(tracked[0], collision);
            assert_eq!(fs::read_to_string(&tracked[0]).unwrap(), "owned contents");
            assert_eq!(
                fs::read_to_string(&collision).unwrap(),
                "untracked user file"
            );
            pool.close().await;
        });
    }

    #[test]
    fn deletion_cleans_all_tracked_files_and_rolls_back_when_database_rejects_it() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            let current = tempfile::tempdir().unwrap();
            let previous = tempfile::tempdir().unwrap();
            let managed = managed_deck_directory(current.path().to_str().unwrap()).unwrap();
            let archive = archive_directory(&managed).unwrap();
            let active = managed.join("Eternal League - Deck - deck.dck");
            let archived =
                archive.join("Eternal League - Older - deck.dck.archive-0123456789abcdef");
            let old = previous.path().join("Eternal League - Previous - deck.dck");
            let user_file = managed.join("Personal.dck");
            for (path, contents) in [
                (&active, "active"),
                (&archived, "archive"),
                (&old, "previous"),
                (&user_file, "user"),
            ] {
                fs::write(path, contents).unwrap();
            }
            track_test_files(
                &pool,
                "deck",
                &[
                    active.clone(),
                    archived.clone(),
                    old.clone(),
                    active.clone(),
                ],
            )
            .await;
            sqlx::raw_sql("CREATE TRIGGER fail_deletion BEFORE DELETE ON decks WHEN OLD.id='deck' BEGIN SELECT RAISE(ABORT,'test deletion failure'); END;").execute(&pool).await.unwrap();
            assert!(delete_pool(&pool, "deck").await.is_err());
            assert_eq!(fs::read_to_string(&active).unwrap(), "active");
            assert_eq!(fs::read_to_string(&archived).unwrap(), "archive");
            assert_eq!(fs::read_to_string(&old).unwrap(), "previous");
            assert_eq!(load_pool(&pool, "deck").await.unwrap().cards[0].quantity, 2);
            assert_eq!(test_tracked_files(&pool, "deck").await.len(), 4);
            sqlx::query("DROP TRIGGER fail_deletion")
                .execute(&pool)
                .await
                .unwrap();
            delete_pool(&pool, "deck").await.unwrap();
            assert!(!active.exists() && !archived.exists() && !old.exists());
            assert_eq!(fs::read_to_string(&user_file).unwrap(), "user");
            assert!(test_tracked_files(&pool, "deck").await.is_empty());
            assert!(load_pool(&pool, "deck").await.is_err());
            assert!(load_pool(&pool, "invalid").await.is_ok());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='elf'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                2
            );
            pool.close().await;
        });
    }

    #[test]
    fn unverified_paths_and_staging_failures_leave_user_files_untouched() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            let root = tempfile::tempdir().unwrap();
            let owned = root.path().join("Eternal League - Deck - deck.dck");
            let user = root.path().join("Personal.dck");
            fs::write(&owned, "owned").unwrap();
            fs::write(&user, "user").unwrap();
            track_test_files(&pool, "deck", &[owned.clone(), user.clone()]).await;
            assert!(delete_pool(&pool, "deck").await.is_err());
            assert_eq!(fs::read_to_string(&owned).unwrap(), "owned");
            assert_eq!(fs::read_to_string(&user).unwrap(), "user");
            assert!(load_pool(&pool, "deck").await.is_ok());
            let failed_target = root.path().join("temporary migrated file");
            let mut journal = FileJournal::default();
            assert!(journal
                .relocate(
                    &root.path().join("missing-parent").join("source.dck"),
                    failed_target.clone(),
                    b"copy"
                )
                .is_err());
            assert!(!failed_target.exists());
            pool.close().await;
        });
    }

    #[test]
    fn failed_file_restoration_reports_where_the_previous_contents_are_retained() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("Eternal League - Deck - deck.dck");
        fs::write(&source, "previous contents").unwrap();
        let mut journal = FileJournal::default();
        journal.stage(&source, None, None).unwrap();
        let recovery = journal.files[0].staged.clone();
        fs::write(&source, "new user contents").unwrap();
        let error = journal.rollback().unwrap_err();
        assert!(error.contains("retained"));
        assert!(error.contains(recovery.to_string_lossy().as_ref()));
        assert_eq!(fs::read_to_string(&source).unwrap(), "new user contents");
        assert_eq!(fs::read_to_string(&recovery).unwrap(), "previous contents");
    }

    #[test]
    fn stale_saved_forge_paths_cannot_move_exports_back_to_previous_folders() {
        tauri::async_runtime::block_on(async {
            let pool = managed_file_fixture().await;
            let root = tempfile::tempdir().unwrap();
            let install = root.path().join("forge");
            fs::create_dir_all(install.join("res").join("editions")).unwrap();
            fs::create_dir_all(install.join("res").join("cardsfolder")).unwrap();
            let old_directory = root.path().join("previous");
            let new_directory = root.path().join("current");
            fs::create_dir(&old_directory).unwrap();
            fs::create_dir(&new_directory).unwrap();
            let expected = crate::forge::ForgePaths {
                data_dir: root.path().to_string_lossy().into_owned(),
                deck_dir: old_directory.to_string_lossy().into_owned(),
                image_cache_dir: root.path().join("images").to_string_lossy().into_owned(),
                install_dir: Some(install.to_string_lossy().into_owned()),
            };
            let mut current = expected.clone();
            current.deck_dir = new_directory.to_string_lossy().into_owned();
            sqlx::query("INSERT INTO settings(key,value) VALUES('app',?)")
                .bind(serde_json::json!({"forge": current}).to_string())
                .execute(&pool)
                .await
                .unwrap();
            let tracked = old_directory.join("Eternal League - Deck - deck.dck");
            fs::write(&tracked, "original export").unwrap();
            track_test_files(&pool, "deck", &[tracked.clone()]).await;
            let draft = DeckDraft {
                id: Some("deck".into()),
                name: "Rejected stale save".into(),
                cards: vec![DraftCard {
                    card_id: "elf".into(),
                    section: "main".into(),
                    quantity: 1,
                }],
            };
            assert!(save_synced_checked(
                &pool,
                draft,
                &expected.deck_dir,
                &test_index(),
                Some(&expected)
            )
            .await
            .unwrap_err()
            .contains("Forge folders changed"));
            assert!(
                migrate_export_folder_checked(&pool, &expected.deck_dir, Some(&expected))
                    .await
                    .unwrap_err()
                    .contains("Forge folders changed")
            );
            assert_eq!(fs::read_to_string(&tracked).unwrap(), "original export");
            assert!(!old_directory.join(APP_DECK_FOLDER).exists());
            assert!(!new_directory.join(APP_DECK_FOLDER).exists());
            assert_eq!(load_pool(&pool, "deck").await.unwrap().name, "Stored deck");
            pool.close().await;
        });
    }

    #[test]
    fn built_in_deck_rules_ignore_saved_user_overrides() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings(key,value) VALUES('app',?)")
                .bind(serde_json::json!({"league":{"deckRestrictions":{"minimumMainDeck":1,"maximumSideboard":100,"normalCopyLimit":100}}}).to_string())
                .execute(&pool).await.unwrap();
            assert_eq!(
                restrictions_pool(&pool).await.unwrap(),
                DeckRestrictions::default()
            );
            pool.close().await;
        });
    }

    #[test]
    fn deck_ownership_is_required_across_sections_and_legacy_settings() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    SqliteConnectOptions::new()
                        .in_memory(true)
                        .foreign_keys(true),
                )
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/002_catalog.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings(key,value) VALUES('test.unlocked-sets','[\"tst\"]')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,metadata_json) VALUES('owned','elf','Elf','tst','Test Set','1','common','Creature','{}'),('unowned','elf','Elf','tst','Test Set','2','common','Creature','{}'),('basic','forest','Forest','tst','Test Set','3','common','Basic Land — Forest','{}')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('owned',2)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings(key,value) VALUES('test.allow-league-settings','1')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings(key,value) VALUES('app',?)")
                .bind(serde_json::json!({"league":{"deckRestrictions":{"minimumMainDeck":1,"requireOwnedCards":false}}}).to_string())
                .execute(&pool)
                .await
                .unwrap();
            let entry = |card_id: &str, section: &str, quantity: i64| DraftCard {
                card_id: card_id.into(),
                section: section.into(),
                quantity,
            };
            let draft = |name: &str, cards| DeckDraft {
                id: None,
                name: name.into(),
                cards,
            };

            let unowned = draft("Unowned printing", vec![entry("unowned", "main", 1)]);
            let mut transaction = pool.begin().await.unwrap();
            let entries = draft_entries(&mut transaction, &unowned).await.unwrap();
            transaction.commit().await.unwrap();
            assert!(ownership_warnings(&entries).is_empty());
            assert!(
                validate_entries_with_restrictions(
                    &entries,
                    Some(&test_index()),
                    &restrictions_pool(&pool).await.unwrap()
                )
                .can_export
            );
            assert!(save_pool(
                &pool,
                draft(
                    "Too many across sections",
                    vec![
                        entry("unowned", "main", 2),
                        entry("unowned", "sideboard", 1)
                    ]
                )
            )
            .await
            .unwrap_err()
            .contains("needs 3 copies"));
            assert!(list_pool(&pool).await.unwrap().is_empty());

            let saved = save_pool(&pool, draft("Owned", vec![entry("unowned", "main", 2)]))
                .await
                .unwrap();
            let duplicate = duplicate_pool(&pool, &saved.id).await.unwrap();
            assert_ne!(saved.id, duplicate.id);
            assert_eq!(duplicate.cards[0].quantity, 2);
            sqlx::query("UPDATE collection SET quantity=1 WHERE card_id='owned'")
                .execute(&pool)
                .await
                .unwrap();
            assert!(duplicate_pool(&pool, &saved.id).await.is_err());
            assert_eq!(list_pool(&pool).await.unwrap().len(), 2);
            assert_eq!(
                load_pool(&pool, &saved.id).await.unwrap().cards[0].quantity,
                2
            );
            assert!(save_pool(
                &pool,
                DeckDraft {
                    id: Some(saved.id.clone()),
                    name: "Rejected update".into(),
                    cards: vec![entry("owned", "main", 1), entry("owned", "sideboard", 1)]
                }
            )
            .await
            .is_err());
            assert_eq!(load_pool(&pool, &saved.id).await.unwrap().name, "Owned");

            let corrected = save_pool(
                &pool,
                DeckDraft {
                    id: Some(saved.id.clone()),
                    name: "Corrected".into(),
                    cards: vec![
                        entry("owned", "main", 1),
                        entry("basic", "main", 60),
                        entry("basic", "sideboard", 15),
                    ],
                },
            )
            .await
            .unwrap();
            assert!(validate_entries(&corrected.cards, Some(&test_index())).can_export);
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM collection WHERE card_id='owned'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM collection WHERE card_id='basic'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                0
            );
            pool.close().await;
        });
    }

    #[test]
    fn deck_saves_are_atomic_and_do_not_consume_collection() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    SqliteConnectOptions::new()
                        .in_memory(true)
                        .foreign_keys(true),
                )
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/002_catalog.sql"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings(key,value) VALUES('test.unlocked-sets','[\"tst\"]')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json) VALUES('card','oracle','Elf','tst','1','common','{}')").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('card',4)")
                .execute(&pool)
                .await
                .unwrap();
            let deck = save_pool(
                &pool,
                DeckDraft {
                    id: None,
                    name: "First".into(),
                    cards: vec![DraftCard {
                        card_id: "card".into(),
                        section: "main".into(),
                        quantity: 4,
                    }],
                },
            )
            .await
            .unwrap();
            let invalid = save_pool(
                &pool,
                DeckDraft {
                    id: Some(deck.id.clone()),
                    name: "Broken".into(),
                    cards: vec![DraftCard {
                        card_id: "missing".into(),
                        section: "main".into(),
                        quantity: 4,
                    }],
                },
            )
            .await;
            assert!(invalid.is_err());
            let reloaded = load_pool(&pool, &deck.id).await.unwrap();
            assert_eq!(reloaded.name, "First");
            assert_eq!(reloaded.cards[0].quantity, 4);
            let owned: i64 =
                sqlx::query_scalar("SELECT quantity FROM collection WHERE card_id='card'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(owned, 4);
            delete_pool(&pool, &deck.id).await.unwrap();
            assert!(list_pool(&pool).await.unwrap().is_empty());
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM collection WHERE card_id='card'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                4
            );
        });
    }
}
