use crate::catalog::open_pool;
use chrono::Utc;
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection, SqlitePool};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager};

// Catalog imports hold a read guard for their complete staging/commit cycle.
// Restore holds a write guard to prevent a later stale catalog merge.
pub(crate) static DATABASE_OPERATION: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
static MAINTENANCE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const TABLES: &[&str] = &[
    "cards",
    "settings",
    "wildcards",
    "decks",
    "collection",
    "deck_cards",
    "booster_history",
    "league_state",
    "progression_operations",
    "set_booster_balances",
    "expansion_reward_claims",
    "booster_pack_queue",
    "game_issue_reports",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    database_path: String,
    cache_path: String,
    size_bytes: u64,
}

#[derive(Serialize)]
pub struct BackupResult {
    path: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    restart_required: bool,
    reload_required: bool,
    backup_path: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheResult {
    files_removed: u64,
    bytes_removed: u64,
}

#[derive(Clone, PartialEq)]
struct MigrationRecord {
    version: i64,
    description: String,
    checksum: Vec<u8>,
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("eternal-league.db"))
}

fn new_backup_path(directory: &Path, reason: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Cannot create the recovery-backup folder: {error}"))?;
    Ok(directory.join(format!(
        "eternal-league-{reason}-{}-{:08x}.sqlite",
        Utc::now().format("%Y%m%d-%H%M%S"),
        rand::random::<u32>()
    )))
}

fn destination_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("Choose an absolute backup filename using the file dialog.".into());
    }
    let parent = path.parent().ok_or("Choose a backup folder.")?;
    if !parent.is_dir() {
        return Err("The selected backup folder does not exist.".into());
    }
    if path.exists() {
        return Err("A file already exists at that backup path. Choose a new filename.".into());
    }
    Ok(path)
}

async fn open_readonly(path: &Path) -> Result<SqliteConnection, String> {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(30)),
    )
    .await
    .map_err(|error| format!("Cannot read the SQLite backup: {error}"))
}

async fn integrity(connection: &mut SqliteConnection) -> Result<(), String> {
    let checks: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| format!("The backup is not a readable SQLite database: {error}"))?;
    if checks.len() != 1 || checks[0] != "ok" {
        return Err(
            "SQLite reported corruption in this backup. Choose a valid backup file.".into(),
        );
    }
    if sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("The backup contains invalid card or deck references.".into());
    }
    Ok(())
}

async fn migration_records(
    connection: &mut SqliteConnection,
) -> Result<Vec<MigrationRecord>, String> {
    let rows = sqlx::query(
        "SELECT version,description,checksum,success FROM _sqlx_migrations ORDER BY version",
    )
    .fetch_all(connection)
    .await
    .map_err(|_| "This file does not contain Arcane Fold migration metadata.".to_string())?;
    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        if !row.get::<bool, _>("success") {
            return Err("The backup contains an incomplete database migration.".into());
        }
        records.push(MigrationRecord {
            version: row.get("version"),
            description: row.get("description"),
            checksum: row.get("checksum"),
        });
    }
    Ok(records)
}

async fn reject_unexpected_schema(connection: &mut SqliteConnection) -> Result<(), String> {
    let rows = sqlx::query("SELECT name,type FROM sqlite_schema")
        .fetch_all(connection)
        .await
        .map_err(|error| error.to_string())?;
    for row in rows {
        let name: &str = row.get("name");
        let kind: &str = row.get("type");
        if kind == "trigger"
            || kind == "view"
            || (kind == "table"
                && name != "_sqlx_migrations"
                && !name.starts_with("sqlite_")
                && !TABLES.contains(&name))
        {
            return Err("The selected file has an unexpected database schema. Choose an Arcane Fold backup.".into());
        }
    }
    Ok(())
}

fn migration_sql(version: i64) -> Result<&'static str, String> {
    match version {
        1 => Ok(include_str!("../migrations/001_initial.sql")),
        2 => Ok(include_str!("../migrations/002_catalog.sql")),
        3 => Ok(include_str!("../migrations/003_progression.sql")),
        4 => Ok(include_str!("../migrations/004_land_policy.sql")),
        5 => Ok(include_str!("../migrations/005_expansion_rewards.sql")),
        6 => Ok(include_str!("../migrations/006_catalog_eligibility.sql")),
        7 => Ok(include_str!("../migrations/007_pack_queue.sql")),
        8 => Ok(include_str!("../migrations/008_discovery_wildcards.sql")),
        9 => Ok(include_str!("../migrations/009_game_issue_reports.sql")),
        _ => {
            Err("This backup requires a database migration unavailable in this app version.".into())
        }
    }
}

async fn write_snapshot(
    connection: &mut SqliteConnection,
    destination: &Path,
) -> Result<BackupResult, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Cannot create the backup file: {error}"))?;
    let result = async {
        sqlx::query("VACUUM main INTO ?")
            .bind(destination.to_string_lossy().as_ref())
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Cannot create a consistent database snapshot: {error}"))?;
        let mut snapshot = open_readonly(destination).await?;
        let checked = integrity(&mut snapshot).await;
        snapshot.close().await.map_err(|error| error.to_string())?;
        checked?;
        Ok(BackupResult {
            path: destination.to_string_lossy().into_owned(),
            bytes: fs::metadata(destination)
                .map_err(|error| error.to_string())?
                .len(),
        })
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

pub async fn backup_pool(pool: &SqlitePool, destination: &Path) -> Result<BackupResult, String> {
    if destination.exists() {
        return Err("Choose a new backup filename.".into());
    }
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    write_snapshot(&mut connection, destination).await
}

async fn upgraded_snapshot(
    pool: &SqlitePool,
    source: &Path,
    cache: &Path,
) -> Result<tempfile::TempPath, String> {
    let mut current = pool.acquire().await.map_err(|error| error.to_string())?;
    let expected = migration_records(&mut current).await?;
    drop(current);
    let mut source_connection = open_readonly(source).await?;
    let prepared: Result<(tempfile::TempPath, usize, Vec<MigrationRecord>), String> = async {
        integrity(&mut source_connection).await?;
        reject_unexpected_schema(&mut source_connection).await?;
        let found = migration_records(&mut source_connection).await?;
        if found.is_empty() || found.len() > expected.len() || !expected.starts_with(&found) {
            return Err(
                "The backup was created by an incompatible Arcane Fold database version.".into(),
            );
        }
        fs::create_dir_all(cache).map_err(|error| error.to_string())?;
        let temporary = tempfile::Builder::new()
            .prefix("restore-")
            .suffix(".sqlite")
            .tempfile_in(cache)
            .map_err(|error| error.to_string())?
            .into_temp_path();
        // VACUUM accepts the empty file reserved by tempfile.
        sqlx::query("VACUUM main INTO ?")
            .bind(temporary.to_string_lossy().as_ref())
            .execute(&mut source_connection)
            .await
            .map_err(|error| format!("Cannot prepare the restore snapshot: {error}"))?;
        Ok((temporary, found.len(), expected))
    }
    .await;
    source_connection
        .close()
        .await
        .map_err(|error| error.to_string())?;
    let (temporary, first_missing, expected) = prepared?;
    let mut prepared_connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&temporary)
            .foreign_keys(true),
    )
    .await
    .map_err(|error| error.to_string())?;
    let upgraded = async {
        let mut transaction = prepared_connection.begin().await.map_err(|error| error.to_string())?;
        for migration in expected.iter().skip(first_missing) {
            sqlx::raw_sql(migration_sql(migration.version)?).execute(&mut *transaction).await.map_err(|error| format!("Cannot upgrade this backup: {error}"))?;
            sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,1,?,0)")
                .bind(migration.version).bind(&migration.description).bind(&migration.checksum).execute(&mut *transaction).await.map_err(|error| error.to_string())?;
        }
        transaction.commit().await.map_err(|error| error.to_string())?;
        integrity(&mut prepared_connection).await?;
        reject_unexpected_schema(&mut prepared_connection).await
    }.await;
    prepared_connection
        .close()
        .await
        .map_err(|error| error.to_string())?;
    upgraded?;
    Ok(temporary)
}

type Column = (String, String, i64, Option<String>, i64);

async fn columns(
    connection: &mut SqliteConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<Column>, String> {
    let rows = sqlx::query(&format!("PRAGMA {schema}.table_info(\"{table}\")"))
        .fetch_all(connection)
        .await
        .map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.get("name"),
                row.get("type"),
                row.get("notnull"),
                row.get("dflt_value"),
                row.get("pk"),
            )
        })
        .collect())
}

pub async fn restore_pool(pool: &SqlitePool, source: &Path, cache: &Path) -> Result<(), String> {
    let snapshot = upgraded_snapshot(pool, source, cache).await?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    let source_uri = reqwest::Url::from_file_path(&snapshot)
        .map_err(|_| "Cannot resolve the restore snapshot path.")?;
    sqlx::query("ATTACH DATABASE ? AS restore_source")
        .bind(format!("{source_uri}?mode=ro"))
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("Cannot attach the restore snapshot: {error}"))?;
    let restored = async {
        let mut table_columns = Vec::new();
        for table in TABLES {
            let current = columns(&mut connection, "main", table).await?;
            let saved = columns(&mut connection, "restore_source", table).await?;
            if current.is_empty() || current != saved { return Err(format!("The backup's {table} table is incompatible with this app version.")); }
            table_columns.push((*table, current.iter().map(|column| format!("\"{}\"", column.0)).collect::<Vec<_>>().join(",")));
        }
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await.map_err(|error| error.to_string())?;
        sqlx::query("PRAGMA defer_foreign_keys=ON").execute(&mut *transaction).await.map_err(|error| error.to_string())?;
        for table in TABLES.iter().rev() {
            sqlx::query(&format!("DELETE FROM main.\"{table}\"")).execute(&mut *transaction).await.map_err(|error| error.to_string())?;
        }
        for (table, names) in table_columns {
            sqlx::query(&format!("INSERT INTO main.\"{table}\" ({names}) SELECT {names} FROM restore_source.\"{table}\""))
                .execute(&mut *transaction).await.map_err(|error| format!("Cannot restore {table}: {error}"))?;
        }
        // Eligibility is a derived cache. Older snapshots may have just gained
        // the cache column during upgrade, so rebuild it on the next browse.
        sqlx::query("DELETE FROM settings WHERE key='catalog_browse_policy'")
            .execute(&mut *transaction).await.map_err(|error| error.to_string())?;
        if sqlx::query("PRAGMA main.foreign_key_check").fetch_optional(&mut *transaction).await.map_err(|error| error.to_string())?.is_some() {
            return Err("The restored data contains invalid card or deck references.".into());
        }
        transaction.commit().await.map_err(|error| format!("The database restore could not commit: {error}"))
    }.await;
    // Always detach before returning this pooled connection or removing the file.
    let detached = sqlx::query("DETACH DATABASE restore_source")
        .execute(&mut *connection)
        .await;
    if let Err(error) = detached {
        connection
            .close()
            .await
            .map_err(|close| close.to_string())?;
        restored?;
        return Err(format!("Data restored, but the restore connection could not close cleanly: {error}. Reload the app."));
    }
    drop(connection);
    restored
}

fn cache_totals(directory: &Path, root: &Path, result: &mut CacheResult) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        let canonical = path.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(root) {
            return Err("The image cache contains a path outside the application cache.".into());
        }
        if kind.is_dir() {
            cache_totals(&path, root, result)?;
        } else if kind.is_file() {
            result.files_removed += 1;
            result.bytes_removed += entry.metadata().map_err(|error| error.to_string())?.len();
        }
    }
    Ok(())
}

fn clear_cache(cache: &Path) -> Result<CacheResult, String> {
    fs::create_dir_all(cache).map_err(|error| error.to_string())?;
    let parent = cache.canonicalize().map_err(|error| error.to_string())?;
    let directory = parent.join("card-images");
    if !directory.exists() {
        return Ok(CacheResult::default());
    }
    let target = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if target.parent() != Some(parent.as_path())
        || target.file_name().and_then(|name| name.to_str()) != Some("card-images")
    {
        return Err(
            "The downloaded image cache must be inside the application cache folder.".into(),
        );
    }
    let mut result = CacheResult::default();
    cache_totals(&target, &target, &mut result)?;
    let staged = parent.join(format!(
        "card-images-clearing-{:016x}",
        rand::random::<u64>()
    ));
    fs::rename(&target, &staged).map_err(|error| {
        format!("Cannot clear downloaded images while files are in use: {error}")
    })?;
    let staged = staged.canonicalize().map_err(|error| error.to_string())?;
    if staged.parent() != Some(parent.as_path()) {
        return Err("The image cache cleanup target is outside the application cache.".into());
    }
    fs::remove_dir_all(&staged)
        .map_err(|error| format!("Cannot finish removing downloaded images: {error}"))?;
    Ok(result)
}

#[tauri::command]
pub async fn database_info(app: AppHandle) -> Result<DatabaseInfo, String> {
    let path = database_path(&app)?;
    let mut size_bytes = fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    size_bytes += fs::metadata(format!("{}-wal", path.to_string_lossy()))
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(DatabaseInfo {
        database_path: path.to_string_lossy().into_owned(),
        cache_path: app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?
            .join("card-images")
            .to_string_lossy()
            .into_owned(),
        size_bytes,
    })
}

#[tauri::command]
pub async fn save_app_settings(app: AppHandle, settings_json: String) -> Result<(), String> {
    let _operation = DATABASE_OPERATION
        .try_read()
        .map_err(|_| "Database maintenance is running. Try saving after it finishes.")?;
    let mut settings: serde_json::Value = serde_json::from_str(&settings_json)
        .map_err(|error| format!("Settings contain invalid JSON: {error}"))?;
    if !settings
        .get("forge")
        .is_some_and(serde_json::Value::is_object)
    {
        return Err("Settings must include Forge folder configuration.".into());
    }
    settings["league"] = serde_json::to_value(crate::league_rules::builtin_rules()?)
        .map_err(|error| error.to_string())?;
    settings["appearance"] = serde_json::json!({ "theme": "light", "fontSize": "large" });
    if let Some(forge) = settings
        .get_mut("forge")
        .and_then(serde_json::Value::as_object_mut)
    {
        forge.remove("autoExportOnSave");
    }
    settings
        .as_object_mut()
        .ok_or("Settings must be an object.")?
        .remove("application");
    let json = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    sqlx::query("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(json)
        .execute(&open_pool(&app).await?)
        .await
        .map_err(|error| format!("Settings could not be saved: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn backup_database(app: AppHandle, destination: String) -> Result<BackupResult, String> {
    let _maintenance = MAINTENANCE
        .try_lock()
        .map_err(|_| "A maintenance operation is already running.")?;
    let destination = destination_path(&destination)?;
    backup_pool(&open_pool(&app).await?, &destination).await
}

#[tauri::command]
pub async fn restore_database(app: AppHandle, source: String) -> Result<RestoreResult, String> {
    let _maintenance = MAINTENANCE
        .try_lock()
        .map_err(|_| "A maintenance operation is already running.")?;
    let _operation = DATABASE_OPERATION
        .try_write()
        .map_err(|_| "Wait for current database operations to finish before restoring data.")?;
    let source = PathBuf::from(source.trim());
    if !source.is_absolute() || !source.is_file() {
        return Err("Choose an existing SQLite backup file.".into());
    }
    if source.canonicalize().map_err(|error| error.to_string())?
        == database_path(&app)?
            .canonicalize()
            .map_err(|error| error.to_string())?
    {
        return Err("Choose a separate backup file to restore.".into());
    }
    let pool = open_pool(&app).await?;
    let backup = new_backup_path(
        &app.path()
            .app_config_dir()
            .map_err(|error| error.to_string())?
            .join("backups"),
        "before-restore",
    )?;
    let backup = backup_pool(&pool, &backup).await?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(restore_pool(&pool, &source, &cache))
    })
    .await
    .map_err(|error| format!("Database restore could not finish: {error}"))??;
    Ok(RestoreResult {
        restart_required: false,
        reload_required: true,
        backup_path: backup.path,
    })
}

#[tauri::command]
pub async fn clear_image_cache(
    app: AppHandle,
    confirmation: String,
) -> Result<CacheResult, String> {
    if confirmation != "CLEAR IMAGE CACHE" {
        return Err("Confirm clearing downloaded card images.".into());
    }
    let _maintenance = MAINTENANCE
        .try_lock()
        .map_err(|_| "A maintenance operation is already running.")?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || clear_cache(&cache))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fixture(path: &Path, version: i64) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(3)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true)
                    .foreign_keys(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TEXT DEFAULT CURRENT_TIMESTAMP,success BOOLEAN NOT NULL,checksum BLOB NOT NULL,execution_time BIGINT NOT NULL)").execute(&pool).await.unwrap();
        for migration in 1..=version {
            sqlx::raw_sql(migration_sql(migration).unwrap())
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,1,?,0)").bind(migration).bind(format!("migration-{migration}")).bind(vec![migration as u8]).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn seed(pool: &SqlitePool) {
        sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json) VALUES('card','oracle','Test card','tst','1','common','{}')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO collection VALUES('card',4)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO decks(id,name) VALUES('deck','Saved deck')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO deck_cards VALUES('deck','card','main',4)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE wildcards SET quantity=3 WHERE rarity='rare'")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO league_state VALUES(1,100,12,0)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings VALUES('app','{\"league\":{\"weeklyPacks\":4}}')")
            .execute(pool)
            .await
            .unwrap();
        let bonus_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='set_booster_balances'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        if bonus_tables != 0 {
            sqlx::query("INSERT INTO set_booster_balances VALUES('blb',8)")
                .execute(pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO expansion_reward_claims VALUES('blb',4,8,'2026-12-14T04:39:57Z')",
            )
            .execute(pool)
            .await
            .unwrap();
        }
    }

    #[test]
    fn discovery_migration_preserves_existing_game_tables_and_balances() {
        tauri::async_runtime::block_on(async {
            let directory = tempfile::tempdir().unwrap();
            let pool = fixture(&directory.path().join("upgrade.sqlite"), 7).await;
            seed(&pool).await;
            sqlx::query("UPDATE wildcards SET quantity=CASE rarity WHEN 'common' THEN 7 WHEN 'uncommon' THEN 4 WHEN 'rare' THEN 2 ELSE 1 END")
                .execute(&pool).await.unwrap();
            // Fingerprint every existing game table, including settings, receipts,
            // queues and saved deck allocations, before applying the new schema.
            let mut snapshots = Vec::new();
            let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'")
                .fetch_all(&pool).await.unwrap();
            for table in tables {
                let columns: Vec<String> = sqlx::query(&format!("PRAGMA table_info({table})"))
                    .fetch_all(&pool)
                    .await
                    .unwrap()
                    .iter()
                    .map(|row| format!("quote(\"{}\")", row.get::<String, _>("name")))
                    .collect();
                let query = format!("SELECT group_concat(snapshot, char(10)) FROM (SELECT {} AS snapshot FROM {table} ORDER BY snapshot)", columns.join(" || '|' || "));
                let before: Option<String> =
                    sqlx::query_scalar(&query).fetch_one(&pool).await.unwrap();
                snapshots.push((table, query, before));
            }
            let mut transaction = pool.begin().await.unwrap();
            sqlx::raw_sql(migration_sql(8).unwrap())
                .execute(&mut *transaction)
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            for (table, query, before) in snapshots {
                // The sole new row is the empty Discovery balance. All old rows
                // and all unrelated tables must match their exact prior values.
                let query = if table == "wildcards" {
                    query.replace(
                        "FROM wildcards ORDER",
                        "FROM wildcards WHERE rarity <> 'discovery' ORDER",
                    )
                } else {
                    query
                };
                let after: Option<String> =
                    sqlx::query_scalar(&query).fetch_one(&pool).await.unwrap();
                assert_eq!(after, before, "Migration changed {table}");
            }
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM wildcards WHERE rarity='discovery'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "ok"
            );
            assert!(
                sqlx::query("UPDATE wildcards SET quantity=-1 WHERE rarity='discovery'")
                    .execute(&pool)
                    .await
                    .is_err()
            );
            pool.close().await;
        });
    }

    #[test]
    fn snapshots_include_wal_and_restore_all_data_without_replacing_connections() {
        tauri::async_runtime::block_on(async {
            let directory = tempfile::tempdir().unwrap();
            let pool = fixture(&directory.path().join("live.sqlite"), 9).await;
            seed(&pool).await;
            let backup = directory.path().join("backup.sqlite");
            let saved = backup_pool(&pool, &backup).await.unwrap();
            assert!(saved.bytes > 0);
            sqlx::raw_sql("DELETE FROM deck_cards; DELETE FROM decks; DELETE FROM collection; DELETE FROM league_state; UPDATE wildcards SET quantity=0")
                .execute(&pool).await.unwrap();
            sqlx::raw_sql("DELETE FROM set_booster_balances; DELETE FROM expansion_reward_claims")
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collection")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );
            restore_pool(
                &pool,
                &backup,
                &directory.path().join("restore cache with spaces"),
            )
            .await
            .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM collection WHERE card_id='card'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                4
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT available_packs FROM league_state")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                12
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM wildcards WHERE rarity='rare'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                3
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM deck_cards")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                1
            );
            assert!(backup_pool(&pool, &backup).await.is_err());
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM set_booster_balances WHERE set_code='blb'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                8
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM expansion_reward_claims")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                1
            );
            pool.close().await;
        });
    }

    #[test]
    fn invalid_and_incompatible_backups_preserve_the_live_database() {
        tauri::async_runtime::block_on(async {
            let directory = tempfile::tempdir().unwrap();
            let pool = fixture(&directory.path().join("live.sqlite"), 9).await;
            seed(&pool).await;
            let corrupt = directory.path().join("bad.sqlite");
            fs::write(&corrupt, b"not a sqlite backup").unwrap();
            assert!(restore_pool(&pool, &corrupt, directory.path())
                .await
                .is_err());
            let backup = directory.path().join("wrong.sqlite");
            backup_pool(&pool, &backup).await.unwrap();
            let mut connection =
                SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&backup))
                    .await
                    .unwrap();
            sqlx::query("UPDATE _sqlx_migrations SET checksum=X'9999' WHERE version=1")
                .execute(&mut connection)
                .await
                .unwrap();
            connection.close().await.unwrap();
            assert!(restore_pool(&pool, &backup, directory.path())
                .await
                .is_err());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                4
            );
            pool.close().await;
        });
    }

    #[test]
    fn older_backups_upgrade_before_restore_and_preserve_saved_data() {
        tauri::async_runtime::block_on(async {
            let directory = tempfile::tempdir().unwrap();
            let old = fixture(&directory.path().join("old.sqlite"), 3).await;
            seed(&old).await;
            let backup = directory.path().join("old-backup.sqlite");
            backup_pool(&old, &backup).await.unwrap();
            old.close().await;
            let pool = fixture(&directory.path().join("live.sqlite"), 9).await;
            restore_pool(&pool, &backup, directory.path())
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cards")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                4
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM settings")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COALESCE(SUM(quantity),0) FROM wildcards")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                3
            );
            pool.close().await;
        });
    }

    #[test]
    fn a_restore_insert_failure_rolls_back_every_live_table() {
        tauri::async_runtime::block_on(async {
            let directory = tempfile::tempdir().unwrap();
            let pool = fixture(&directory.path().join("live.sqlite"), 9).await;
            seed(&pool).await;
            let backup = directory.path().join("invalid-data.sqlite");
            backup_pool(&pool, &backup).await.unwrap();
            let mut source =
                SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&backup))
                    .await
                    .unwrap();
            sqlx::raw_sql("ALTER TABLE collection RENAME TO previous_collection;
                CREATE TABLE collection (card_id TEXT PRIMARY KEY NOT NULL REFERENCES cards(id), quantity INTEGER NOT NULL DEFAULT 0);
                INSERT INTO collection VALUES('card',-1);
                DROP TABLE previous_collection;
                UPDATE decks SET name='Changed backup deck';")
                .execute(&mut source).await.unwrap();
            source.close().await.unwrap();
            let error = restore_pool(&pool, &backup, directory.path())
                .await
                .unwrap_err();
            assert!(error.contains("restore collection"), "{error}");
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                4
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT name FROM decks")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "Saved deck"
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT available_packs FROM league_state")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                12
            );
            pool.close().await;
        });
    }

    #[test]
    fn clearing_images_only_removes_the_app_image_directory() {
        let directory = tempfile::tempdir().unwrap();
        let images = directory.path().join("card-images").join("printing");
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("front.img"), b"image").unwrap();
        fs::write(directory.path().join("keep.sqlite"), b"database").unwrap();
        let result = clear_cache(directory.path()).unwrap();
        assert_eq!(result.files_removed, 1);
        assert_eq!(result.bytes_removed, 5);
        assert!(directory.path().join("keep.sqlite").is_file());
        assert!(!directory.path().join("card-images").exists());
    }
}
