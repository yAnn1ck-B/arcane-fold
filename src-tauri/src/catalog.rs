use flate2::read::GzDecoder;
use reqwest::blocking::Client;
use serde::{
    de::{self, DeserializeSeed, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use serde_json::Value;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow},
    Acquire, QueryBuilder, Row, Sqlite, SqliteConnection, SqlitePool,
};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

static POOL: tokio::sync::OnceCell<SqlitePool> = tokio::sync::OnceCell::const_new();
static IMPORTING: AtomicBool = AtomicBool::new(false);
static CATALOG_SETUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub const USER_AGENT: &str = "EternalLeague/0.1 (Windows desktop MTG Forge companion)";

pub(crate) fn database_mutation_guard() -> Result<tokio::sync::RwLockReadGuard<'static, ()>, String>
{
    crate::maintenance::DATABASE_OPERATION
        .try_read()
        .map_err(|_| "Database maintenance is running. Try again after it finishes.".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCard {
    pub id: String,
    pub oracle_id: String,
    pub name: String,
    pub set_code: String,
    pub set_name: String,
    pub collector_number: String,
    pub rarity: String,
    pub mana_cost: String,
    pub cmc: f64,
    pub type_line: String,
    pub oracle_text: String,
    pub colors: Vec<String>,
    pub image_uri: Option<String>,
    pub back_image_uri: Option<String>,
    pub owned: i64,
    #[serde(default)]
    pub oracle_owned: i64,
    pub forge_set_code: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CardQuery {
    pub search: String,
    pub owned_only: bool,
    pub include_basic_lands: bool,
    pub color: String,
    pub rarity: String,
    pub set_code: String,
    pub type_line: String,
    pub mana_value: String,
    pub min_owned: i64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Serialize)]
pub struct CardPage {
    pub cards: Vec<CatalogCard>,
    pub total: i64,
}
#[derive(Serialize)]
pub struct CatalogSet {
    pub code: String,
    pub name: String,
    pub count: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    pub count: i64,
    pub updated_at: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct CatalogProgress {
    stage: String,
    processed: u64,
    total: Option<u64>,
    message: String,
}

pub async fn open_pool(app: &AppHandle) -> Result<SqlitePool, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("eternal-league.db");
    POOL.get_or_try_init(|| async {
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(20));
        SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(|e| format!("Cannot open card database: {e}"))
    })
    .await
    .cloned()
}

pub fn card_from_row(row: &SqliteRow) -> Result<CatalogCard, String> {
    let colors: String = row.try_get("colors_json").map_err(|e| e.to_string())?;
    Ok(CatalogCard {
        id: row.get("id"),
        oracle_id: row.get("oracle_id"),
        name: row.get("name"),
        set_code: row.get("set_code"),
        set_name: row.get("set_name"),
        collector_number: row.get("collector_number"),
        rarity: row.get("rarity"),
        mana_cost: row.get("mana_cost"),
        cmc: row.get("cmc"),
        type_line: row.get("type_line"),
        oracle_text: row.get("oracle_text"),
        colors: serde_json::from_str(&colors).unwrap_or_default(),
        image_uri: row.get("image_uri"),
        back_image_uri: row.get("back_image_uri"),
        owned: row.try_get("owned").unwrap_or(0),
        oracle_owned: row
            .try_get("oracle_owned")
            .unwrap_or_else(|_| row.try_get("owned").unwrap_or(0)),
        forge_set_code: None,
    })
}

/// Basic lands are freely available for deck construction. Ownership remains
/// recorded separately so existing collections and opening history are intact.
pub fn is_unlimited_basic(card: &CatalogCard) -> bool {
    let types = card.type_line.split('—').next().unwrap_or_default();
    let mut basic = false;
    let mut land = false;
    for token in types.split_whitespace() {
        basic |= token.eq_ignore_ascii_case("basic");
        land |= token.eq_ignore_ascii_case("land");
    }
    basic && land
}

// Check the type/supertype portion only, not the subtype or rules text.
const UNLIMITED_BASIC_SQL: &str = "(instr(' ' || lower(substr(c.type_line,1,instr(c.type_line || '—','—')-1)) || ' ', ' basic ')>0 AND instr(' ' || lower(substr(c.type_line,1,instr(c.type_line || '—','—')-1)) || ' ', ' land ')>0)";

/// Uses the cards_oracle_id and collection primary-key indexes to total copies
/// across every printing, independently of the current browser filters.
pub const ORACLE_OWNED_SQL: &str = "(SELECT COALESCE(SUM(oq.quantity),0) FROM cards oc JOIN collection oq ON oq.card_id=oc.id WHERE oc.oracle_id=c.oracle_id)";

fn filters<'a>(prefix: &str, query: &'a CardQuery) -> QueryBuilder<'a, Sqlite> {
    let mut sql = QueryBuilder::new(prefix.to_owned());
    sql.push(" FROM cards c LEFT JOIN collection o ON o.card_id=c.id WHERE 1=1");
    if !query.search.trim().is_empty() {
        sql.push(" AND c.name LIKE ")
            .push_bind(format!("%{}%", query.search.trim()));
    }
    if query.owned_only {
        sql.push(" AND (COALESCE(o.quantity,0)>0");
        if query.include_basic_lands {
            sql.push(" OR ").push(UNLIMITED_BASIC_SQL);
        }
        sql.push(")");
    }
    if query.min_owned > 0 {
        sql.push(" AND (COALESCE(o.quantity,0)>=")
            .push_bind(query.min_owned);
        if query.include_basic_lands {
            sql.push(" OR ").push(UNLIMITED_BASIC_SQL);
        }
        sql.push(")");
    }
    match query.color.to_uppercase().as_str() {
        "C" => {
            sql.push(" AND json_array_length(c.colors_json)=0");
        }
        "M" => {
            sql.push(" AND json_array_length(c.colors_json)>1");
        }
        "W" | "U" | "B" | "R" | "G" => {
            sql.push(" AND instr(c.colors_json,")
                .push_bind(format!("\"{}\"", query.color.to_uppercase()))
                .push(")>0");
        }
        _ => (),
    }
    if !query.rarity.is_empty() && query.rarity != "all" {
        sql.push(" AND c.rarity=")
            .push_bind(query.rarity.to_lowercase());
    }
    if !query.set_code.is_empty() && query.set_code != "all" {
        sql.push(" AND c.set_code=")
            .push_bind(query.set_code.to_lowercase());
    }
    if query.type_line.trim().eq_ignore_ascii_case("basic land") {
        sql.push(" AND ").push(UNLIMITED_BASIC_SQL);
    } else if !query.type_line.is_empty() && query.type_line != "all" {
        sql.push(" AND c.type_line LIKE ")
            .push_bind(format!("%{}%", query.type_line));
    }
    if let Ok(value) = query.mana_value.parse::<f64>() {
        sql.push(" AND c.cmc=").push_bind(value);
    }
    sql
}

pub async fn query_pool(pool: &SqlitePool, query: CardQuery) -> Result<CardPage, String> {
    let total: i64 = filters("SELECT COUNT(*)", &query)
        .build_query_scalar()
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let size = if query.page_size == 0 {
        30
    } else {
        query.page_size.clamp(1, 100)
    };
    let mut sql = filters(
        &format!("SELECT c.*, COALESCE(o.quantity,0) AS owned, {ORACLE_OWNED_SQL} AS oracle_owned"),
        &query,
    );
    sql.push(" ORDER BY c.name COLLATE NOCASE,c.set_code,c.collector_number,c.id LIMIT ")
        .push_bind(i64::from(size))
        .push(" OFFSET ")
        .push_bind(i64::from(query.page) * i64::from(size));
    let rows = sql
        .build()
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let cards = rows.iter().map(card_from_row).collect::<Result<_, _>>()?;
    Ok(CardPage { cards, total })
}

#[tauri::command]
pub async fn query_cards(app: AppHandle, query: CardQuery) -> Result<CardPage, String> {
    query_pool(&open_pool(&app).await?, query).await
}

pub async fn get_card_pool(pool: &SqlitePool, card_id: &str) -> Result<CatalogCard, String> {
    let row = sqlx::query(&format!("SELECT c.*,COALESCE(o.quantity,0) AS owned, {ORACLE_OWNED_SQL} AS oracle_owned FROM cards c LEFT JOIN collection o ON o.card_id=c.id WHERE c.id=?"))
        .bind(card_id).fetch_optional(pool).await.map_err(|e| e.to_string())?
        .ok_or("This printing is missing from the local catalog. Refresh the card catalog and try again.")?;
    card_from_row(&row)
}

#[tauri::command]
pub async fn get_card(app: AppHandle, card_id: String) -> Result<CatalogCard, String> {
    get_card_pool(&open_pool(&app).await?, &card_id).await
}

#[tauri::command]
pub async fn list_sets(app: AppHandle) -> Result<Vec<CatalogSet>, String> {
    let rows = sqlx::query("SELECT set_code,MAX(set_name) AS set_name,COUNT(*) AS count FROM cards GROUP BY set_code ORDER BY set_name COLLATE NOCASE")
        .fetch_all(&open_pool(&app).await?).await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|r| CatalogSet {
            code: r.get("set_code"),
            name: r.get("set_name"),
            count: r.get("count"),
        })
        .collect())
}

pub async fn status_pool(pool: &SqlitePool) -> Result<CatalogStatus, String> {
    let count = sqlx::query_scalar("SELECT COUNT(*) FROM cards")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let updated_at =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='catalog_updated_at'")
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(CatalogStatus { count, updated_at })
}

#[tauri::command]
pub async fn catalog_status(app: AppHandle) -> Result<CatalogStatus, String> {
    status_pool(&open_pool(&app).await?).await
}

#[cfg(test)]
async fn change_quantity(pool: &SqlitePool, card_id: &str, delta: i64) -> Result<i64, String> {
    if delta == 0 || delta.unsigned_abs() > 100_000 {
        return Err("Choose a quantity change between 1 and 100,000 cards.".into());
    }
    let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO collection(card_id,quantity) SELECT id,0 FROM cards WHERE id=? ON CONFLICT(card_id) DO NOTHING")
        .bind(card_id).execute(&mut *transaction).await.map_err(|e| e.to_string())?;
    let quantity: Option<i64> = sqlx::query_scalar("UPDATE collection SET quantity=quantity+? WHERE card_id=? AND quantity+? BETWEEN 0 AND 2147483647 RETURNING quantity")
        .bind(delta).bind(card_id).bind(delta).fetch_optional(&mut *transaction).await.map_err(|e| e.to_string())?;
    let quantity =
        quantity.ok_or("Cannot remove more cards than you own, or the printing is missing.")?;
    transaction.commit().await.map_err(|e| e.to_string())?;
    Ok(quantity)
}

pub fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .default_headers({
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(
                reqwest::header::ACCEPT,
                reqwest::header::HeaderValue::from_static("application/json;q=0.9,*/*;q=0.8"),
            );
            h
        })
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(900))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 {
                attempt.error("Too many redirects")
            } else if is_scryfall_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("Redirect outside Scryfall was blocked")
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

pub fn is_scryfall_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some("api.scryfall.com" | "data.scryfall.io" | "cards.scryfall.io")
        )
        && url.username().is_empty()
        && url.password().is_none()
}

fn progress(app: &AppHandle, stage: &str, processed: u64, total: Option<u64>, message: &str) {
    let _ = app.emit(
        "catalog-progress",
        CatalogProgress {
            stage: stage.into(),
            processed,
            total,
            message: message.into(),
        },
    );
}

async fn catalog_setting(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|error| error.to_string())
}

async fn stamp_forge_catalog(
    pool: &SqlitePool,
    version: &str,
    editions: &BTreeMap<String, String>,
    pending: &[Value],
) -> Result<(), String> {
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    for (key, value) in [
        ("catalog_forge_version", version.to_owned()),
        (
            "catalog_forge_editions",
            serde_json::to_string(editions).map_err(|error| error.to_string())?,
        ),
        (
            "catalog_pending_printings",
            serde_json::to_string(pending).map_err(|error| error.to_string())?,
        ),
        (
            "catalog_pending_retry_at",
            chrono::Utc::now().timestamp().to_string(),
        ),
    ] {
        sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(key).bind(value).execute(&mut *transaction).await.map_err(|error| error.to_string())?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())
}

async fn append_values(pool: &SqlitePool, values: Vec<Value>) -> Result<u64, String> {
    let mut cards = Vec::new();
    for value in values {
        if let Some(card) = normalize(value)? {
            cards.push(card);
        }
    }
    if cards.is_empty() {
        return Ok(0);
    }
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let mut added = 0;
    for batch in cards.chunks(500) {
        let mut sql = QueryBuilder::new("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri) ");
        sql.push_values(batch, |mut builder, card| {
            let value = &card.card;
            builder
                .push_bind(&value.id)
                .push_bind(&value.oracle_id)
                .push_bind(&value.name)
                .push_bind(&value.set_code)
                .push_bind(&value.collector_number)
                .push_bind(&value.rarity)
                .push_bind(&card.metadata)
                .push_bind(&value.set_name)
                .push_bind(&value.mana_cost)
                .push_bind(value.cmc)
                .push_bind(&value.type_line)
                .push_bind(&value.oracle_text)
                .push_bind(serde_json::to_string(&value.colors).unwrap_or_default())
                .push_bind(&value.image_uri)
                .push_bind(&value.back_image_uri);
        });
        sql.push(" ON CONFLICT(id) DO NOTHING");
        added += sql
            .build()
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?
            .rows_affected();
    }
    if added > 0 {
        sqlx::query("INSERT INTO settings(key,value) VALUES('catalog_updated_at',strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .execute(&mut *transaction).await.map_err(|error| error.to_string())?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;
    Ok(added)
}

fn printing_identifier(value: &Value) -> Option<(String, String)> {
    let set = value.get("set")?.as_str()?.to_lowercase();
    let number = value.get("collector_number")?.as_str()?.to_owned();
    (!set.is_empty()
        && set
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
        && !number.is_empty()
        && number.len() <= 100
        && !number.chars().any(char::is_control))
    .then_some((set, number))
}

fn missing_printings(
    editions: BTreeMap<String, (String, Vec<(String, String)>)>,
    previous: &BTreeMap<String, String>,
    present: &HashSet<(String, String)>,
) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    for (code, (stamp, cards)) in editions {
        if previous.get(&code) == Some(&stamp) {
            continue;
        }
        for (number, _) in cards {
            let key = (code.clone(), number.clone());
            if !present.contains(&key) && seen.insert(key) {
                missing.push(serde_json::json!({ "set": code, "collector_number": number }));
            }
        }
    }
    missing
}

#[tauri::command]
pub async fn ensure_catalog(
    app: AppHandle,
    paths: crate::forge::ForgePaths,
) -> Result<CatalogStatus, String> {
    let _operation = database_mutation_guard()?;
    let _setup = CATALOG_SETUP.lock().await;
    let report = crate::forge::test_forge_integration(paths.clone()).await?;
    if !report.install_dir_exists {
        return Err(
            "Select your Forge installation folder to finish setting up the card catalog.".into(),
        );
    }
    crate::forge::prepare_standard_directories(&paths)?;
    let version = report.forge_version.clone().unwrap_or_else(|| {
        format!(
            "unversioned:{}",
            report.forge_install_dir.as_deref().unwrap_or_default()
        )
    });
    let pool = open_pool(&app).await?;
    let status = status_pool(&pool).await?;
    let previous = catalog_setting(&pool, "catalog_forge_version").await?;
    let pending: Vec<Value> = catalog_setting(&pool, "catalog_pending_printings")
        .await?
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    let last_retry = catalog_setting(&pool, "catalog_pending_retry_at")
        .await?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let pending_due = !pending.is_empty()
        && chrono::Utc::now().timestamp().saturating_sub(last_retry) >= 24 * 60 * 60;
    if status.count > 0 && previous.as_deref() == Some(&version) && !pending_due {
        return Ok(status);
    }
    let hint = report.forge_install_dir.clone();
    let editions = tauri::async_runtime::spawn_blocking(move || {
        crate::decks::catalog_editions(hint.as_deref())
    })
    .await
    .map_err(|error| error.to_string())??;
    let fingerprints: BTreeMap<_, _> = editions
        .iter()
        .map(|(code, (stamp, _))| (code.clone(), stamp.clone()))
        .collect();
    if status.count == 0 {
        let status = import_catalog(app, None).await?;
        stamp_forge_catalog(&pool, &version, &fingerprints, &[]).await?;
        return Ok(status);
    }
    // Existing installations already have their bulk catalog. Adopt it once,
    // then only inspect changed editions on subsequent Forge version upgrades.
    if previous.is_none() {
        stamp_forge_catalog(&pool, &version, &fingerprints, &[]).await?;
        return Ok(status);
    }
    if IMPORTING.swap(true, Ordering::AcqRel) {
        return Err("The card catalog is already being updated.".into());
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            IMPORTING.store(false, Ordering::Release);
        }
    }
    let guard = Guard;
    let _guard = guard;
    let old: BTreeMap<String, String> = catalog_setting(&pool, "catalog_forge_editions")
        .await?
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    let rows = sqlx::query("SELECT set_code,collector_number FROM cards")
        .fetch_all(&pool)
        .await
        .map_err(|error| error.to_string())?;
    let present: HashSet<(String, String)> = rows
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("set_code").to_lowercase(),
                row.get("collector_number"),
            )
        })
        .collect();
    let mut missing = missing_printings(editions, &old, &present);
    let mut identifiers: HashSet<_> = missing.iter().filter_map(printing_identifier).collect();
    for item in pending {
        if let Some(key) = printing_identifier(&item) {
            if !present.contains(&key) && identifiers.insert(key) {
                missing.push(item);
            }
        }
    }
    let worker_app = app.clone();
    let values = tauri::async_runtime::spawn_blocking(move || {
        let client = http_client()?;
        let mut cards = Vec::new();
        let mut pending = Vec::new();
        let total = missing.len() as u64;
        for (index, batch) in missing.chunks(75).enumerate() {
            if index > 0 { std::thread::sleep(Duration::from_millis(150)); }
            progress(&worker_app, "extending", (index * 75) as u64, Some(total), "Adding printings introduced by your Forge update…");
            let response: Value = client.post("https://api.scryfall.com/cards/collection")
                .json(&serde_json::json!({"identifiers": batch})).send()
                .and_then(|response| response.error_for_status())
                .map_err(|error| format!("New Forge cards could not be downloaded: {error}. Your existing catalog and artwork are preserved; the app will retry next time."))?
                .json().map_err(|error| error.to_string())?;
            let data = response.get("data").and_then(Value::as_array).ok_or("Scryfall returned an invalid card collection.")?;
            cards.extend(data.iter().cloned());
            if let Some(not_found) = response.get("not_found").and_then(Value::as_array) {
                pending.extend(not_found.iter().filter(|item| printing_identifier(item).is_some()).cloned());
            }
        }
        Ok::<_, String>((cards, pending))
    }).await.map_err(|error| error.to_string())??;
    append_values(&pool, values.0).await?;
    stamp_forge_catalog(&pool, &version, &fingerprints, &values.1).await?;
    let status = status_pool(&pool).await?;
    progress(
        &app,
        "complete",
        status.count as u64,
        Some(status.count as u64),
        "Your offline catalog is ready.",
    );
    Ok(status)
}

#[tauri::command]
pub async fn get_banner_card(app: AppHandle) -> Result<CatalogCard, String> {
    let pool = open_pool(&app).await?;
    if status_pool(&pool).await?.count == 0 {
        return Err("The card catalog is still being prepared.".into());
    }
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM cards WHERE name='Black Lotus' ORDER BY CASE lower(set_code) WHEN 'lea' THEN 0 WHEN 'leb' THEN 1 WHEN '2ed' THEN 2 ELSE 3 END,collector_number,id LIMIT 1")
        .fetch_optional(&pool).await.map_err(|error| error.to_string())?;
    if let Some(id) = id {
        return get_card_pool(&pool, &id).await;
    }
    let _operation = database_mutation_guard()?;
    let value = tauri::async_runtime::spawn_blocking(|| {
        http_client()?
            .get("https://api.scryfall.com/cards/named")
            .timeout(Duration::from_secs(30))
            .query(&[("exact", "Black Lotus"), ("set", "lea")])
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| format!("Black Lotus artwork metadata is unavailable: {error}"))?
            .json::<Value>()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Black Lotus metadata has no printing ID.")?
        .to_owned();
    append_values(&pool, vec![value]).await?;
    get_card_pool(&pool, &id).await
}

#[tauri::command]
pub async fn import_catalog(
    app: AppHandle,
    source_path: Option<String>,
) -> Result<CatalogStatus, String> {
    let operation = crate::maintenance::DATABASE_OPERATION
        .try_read()
        .map_err(|_| {
            "Database maintenance is running. Try importing after it finishes.".to_string()
        })?;
    if IMPORTING.swap(true, Ordering::AcqRel) {
        return Err("A catalog import is already running.".into());
    }
    struct ImportGuard;
    impl Drop for ImportGuard {
        fn drop(&mut self) {
            IMPORTING.store(false, Ordering::Release);
        }
    }
    let guard = ImportGuard;
    let pool = open_pool(&app).await?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let _operation = operation;
        let imported = (|| {
            let downloaded = source_path.is_none();
            let source = match source_path {
                Some(path) => {
                    let p = PathBuf::from(path);
                    if !p.is_absolute() || !p.is_file() {
                        return Err(
                            "Choose an existing Scryfall bulk JSON, JSONL, or gzip file."
                                .to_string(),
                        );
                    }
                    p
                }
                None => download_bulk(&app)?,
            };
            progress(
                &app,
                "importing",
                0,
                None,
                "Reading card metadata. Your collection and decks remain intact.",
            );
            let imported = import_file(&pool, &source, |count| {
                progress(&app, "importing", count, None, "Importing card printings…")
            });
            if downloaded {
                let _ = fs::remove_file(&source);
            }
            imported?;
            let status = tauri::async_runtime::block_on(status_pool(&pool))?;
            progress(
                &app,
                "complete",
                status.count as u64,
                Some(status.count as u64),
                "Your offline catalog is ready.",
            );
            Ok(status)
        })();
        if let Err(error) = &imported {
            progress(&app, "error", 0, None, error);
        }
        imported
    })
    .await
    .map_err(|e| format!("Card import could not finish: {e}"))?;
    result
}

fn download_bulk(app: &AppHandle) -> Result<PathBuf, String> {
    progress(
        app,
        "checking",
        0,
        None,
        "Checking Scryfall's bulk-data manifest…",
    );
    let client = http_client()?;
    let manifest: Value = client
        .get("https://api.scryfall.com/bulk-data/default_cards")
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| {
              format!("Cannot reach Scryfall: {e}. Check your connection and try again. Your saved collection is preserved.")
        })?
        .json()
        .map_err(|e| format!("Cannot read Scryfall's manifest: {e}"))?;
    let uri = manifest
        .get("jsonl_download_uri")
        .or_else(|| manifest.get("download_uri"))
        .and_then(Value::as_str)
        .ok_or("Scryfall's manifest has no supported download URI.")?;
    let url = reqwest::Url::parse(uri).map_err(|e| e.to_string())?;
    if !is_scryfall_url(&url) || url.host_str() != Some("data.scryfall.io") {
        return Err("Scryfall returned an unexpected bulk-data host.".into());
    }
    let response = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Cannot download card metadata: {e}"))?;
    let total = response.content_length().or_else(|| {
        manifest
            .get("compressed_size")
            .or_else(|| manifest.get("size"))
            .and_then(Value::as_u64)
    });
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let source = cache.join("scryfall-bulk-download.part");
    let result = (|| {
        let mut file = File::create(&source).map_err(|e| e.to_string())?;
        let mut reader = response;
        let mut buffer = [0u8; 65536];
        let mut count = 0;
        let mut last = 0;
        loop {
            let n = reader
                .read(&mut buffer)
                .map_err(|e| format!("Download interrupted: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buffer[..n])
                .map_err(|e| format!("Cannot save card download: {e}"))?;
            count += n as u64;
            if count > 3 * 1024 * 1024 * 1024 {
                return Err("Scryfall bulk download exceeded 3 GB.".to_string());
            }
            if count - last >= 1024 * 1024 {
                progress(
                    app,
                    "downloading",
                    count,
                    total,
                    "Downloading Scryfall's default card printings…",
                );
                last = count;
            }
        }
        if count == 0 {
            return Err("Scryfall returned an empty download.".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(source.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&source);
    }
    result
}

struct ImportCard {
    card: CatalogCard,
    metadata: String,
}

fn normalize(value: Value) -> Result<Option<ImportCard>, String> {
    if value
        .get("object")
        .and_then(Value::as_str)
        .is_some_and(|x| x != "card")
    {
        return Ok(None);
    }
    let string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let id = string("id");
    let name = string("name");
    let set_code = string("set").to_lowercase();
    if id.is_empty()
        || id.len() > 100
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        || name.is_empty()
        || set_code.is_empty()
    {
        return Err(
            "The bulk file contains a card without a valid id, name, or expansion code.".into(),
        );
    }
    let faces = value.get("card_faces").and_then(Value::as_array);
    let face_field = |key: &str| {
        faces
            .map(|fs| {
                fs.iter()
                    .filter_map(|f| f.get(key).and_then(Value::as_str))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" // ")
            })
            .unwrap_or_default()
    };
    let oracle_id = if string("oracle_id").is_empty() {
        faces
            .and_then(|fs| fs.first())
            .and_then(|f| f.get("oracle_id"))
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string()
    } else {
        string("oracle_id")
    };
    let image = |v: &Value| {
        v.get("image_uris")
            .and_then(|u| {
                u.get("normal")
                    .or_else(|| u.get("jpeg"))
                    .or_else(|| u.get("png"))
            })
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let image_uri = image(&value).or_else(|| faces.and_then(|f| f.first()).and_then(image));
    let back_image_uri = faces.and_then(|f| f.get(1)).and_then(image);
    let mut colors = Vec::new();
    if let Some(cs) = value.get("colors").and_then(Value::as_array) {
        colors.extend(cs.iter().filter_map(Value::as_str).map(str::to_owned));
    } else if let Some(fs) = faces {
        for face in fs {
            if let Some(cs) = face.get("colors").and_then(Value::as_array) {
                colors.extend(cs.iter().filter_map(Value::as_str).map(str::to_owned));
            }
        }
    }
    colors.sort();
    colors.dedup();
    let rarity = string("rarity");
    if !["common", "uncommon", "rare", "mythic", "special", "bonus"].contains(&rarity.as_str()) {
        return Err(format!("Unsupported rarity in bulk file: {rarity}"));
    }
    let card = CatalogCard {
        id,
        oracle_id,
        name,
        set_code,
        set_name: string("set_name"),
        collector_number: string("collector_number"),
        rarity,
        mana_cost: if string("mana_cost").is_empty() {
            face_field("mana_cost")
        } else {
            string("mana_cost")
        },
        cmc: value.get("cmc").and_then(Value::as_f64).unwrap_or(0.0),
        type_line: if string("type_line").is_empty() {
            face_field("type_line")
        } else {
            string("type_line")
        },
        oracle_text: if string("oracle_text").is_empty() {
            face_field("oracle_text")
        } else {
            string("oracle_text")
        },
        colors,
        image_uri,
        back_image_uri,
        owned: 0,
        oracle_owned: 0,
        forge_set_code: None,
    };
    Ok(Some(ImportCard {
        card,
        metadata: serde_json::to_string(&value).map_err(|e| e.to_string())?,
    }))
}

pub fn import_file(
    pool: &SqlitePool,
    path: &Path,
    mut notify: impl FnMut(u64),
) -> Result<u64, String> {
    // Keep SQLx's deferred connection cleanup inside a runtime context even
    // when this helper is called by a synchronous fixture test.
    let runtime = tauri::async_runtime::handle();
    let _context = runtime.inner().enter();
    let file = File::open(path).map_err(|e| format!("Cannot open bulk file: {e}"))?;
    let mut probe = BufReader::new(file);
    let gzip = probe
        .fill_buf()
        .map_err(|e| e.to_string())?
        .starts_with(&[0x1f, 0x8b]);
    let reader: Box<dyn Read> = if gzip {
        Box::new(GzDecoder::new(probe))
    } else {
        Box::new(probe)
    };
    let mut reader = BufReader::new(reader);
    let mut first = None;
    loop {
        let bytes = reader.fill_buf().map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            break;
        }
        let skipped = bytes.iter().take_while(|c| c.is_ascii_whitespace()).count();
        if skipped < bytes.len() {
            first = Some(bytes[skipped]);
            reader.consume(skipped);
            break;
        }
        reader.consume(skipped);
    }
    // Stage outside a transaction on the main database. Holding a main read
    // snapshot during parsing would make a concurrent ownership/deck edit
    // prevent the final write upgrade under WAL (SQLITE_BUSY_SNAPSHOT).
    let mut connection =
        tauri::async_runtime::block_on(pool.acquire()).map_err(|e| e.to_string())?;
    tauri::async_runtime::block_on(
        sqlx::query("DROP TABLE IF EXISTS temp.catalog_import_stage").execute(&mut *connection),
    )
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::block_on(sqlx::query("CREATE TEMP TABLE catalog_import_stage AS SELECT id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri FROM cards WHERE 0").execute(&mut *connection)).map_err(|e|e.to_string())?;
    let mut count = 0u64;
    let mut batch = Vec::with_capacity(500);
    let mut consume = |value: Value| -> Result<(), String> {
        if let Some(card) = normalize(value)? {
            batch.push(card);
            count += 1;
        }
        if batch.len() >= 500 {
            flush(&mut connection, &batch)?;
            batch.clear();
            notify(count);
        }
        Ok(())
    };
    if first == Some(b'[') {
        struct ArraySeed<'a, F>(&'a mut F);
        impl<'de, F: FnMut(Value) -> Result<(), String>> DeserializeSeed<'de> for ArraySeed<'_, F> {
            type Value = ();
            fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
                struct ArrayVisitor<'a, F>(&'a mut F);
                impl<'de, F: FnMut(Value) -> Result<(), String>> Visitor<'de> for ArrayVisitor<'_, F> {
                    type Value = ();
                    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                        f.write_str("an array of Scryfall cards")
                    }
                    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<(), A::Error> {
                        while let Some(v) = a.next_element::<Value>()? {
                            (self.0)(v).map_err(de::Error::custom)?;
                        }
                        Ok(())
                    }
                }
                d.deserialize_seq(ArrayVisitor(self.0))
            }
        }
        let mut deserializer = serde_json::Deserializer::from_reader(reader);
        ArraySeed(&mut consume)
            .deserialize(&mut deserializer)
            .map_err(|e| format!("Invalid bulk JSON: {e}"))?;
        deserializer.end().map_err(|e| e.to_string())?;
    } else if first == Some(b'{') {
        for value in serde_json::Deserializer::from_reader(reader).into_iter::<Value>() {
            consume(value.map_err(|e| format!("Invalid bulk JSONL: {e}"))?)?;
        }
    } else {
        return Err(
            "Choose a Scryfall JSON array or JSONL bulk-data file (optionally gzipped).".into(),
        );
    }
    drop(consume);
    if count == 0 {
        return Err(
            "The bulk file contains no card printings; the existing catalog was preserved.".into(),
        );
    }
    flush(&mut connection, &batch)?;
    tauri::async_runtime::block_on(async {
        let mut transaction=connection.begin().await?;
        sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri) SELECT id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri FROM catalog_import_stage WHERE 1 ON CONFLICT(id) DO UPDATE SET oracle_id=excluded.oracle_id,name=excluded.name,set_code=excluded.set_code,collector_number=excluded.collector_number,rarity=excluded.rarity,metadata_json=excluded.metadata_json,set_name=excluded.set_name,mana_cost=excluded.mana_cost,cmc=excluded.cmc,type_line=excluded.type_line,oracle_text=excluded.oracle_text,colors_json=excluded.colors_json,image_uri=excluded.image_uri,back_image_uri=excluded.back_image_uri").execute(&mut *transaction).await?;
        sqlx::query("INSERT INTO settings(key,value) VALUES('catalog_updated_at',strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value").execute(&mut *transaction).await?;
        sqlx::query("DROP TABLE catalog_import_stage").execute(&mut *transaction).await?;
        transaction.commit().await
    }).map_err(|e|format!("Could not commit the catalog; existing data was preserved: {e}"))?;
    notify(count);
    Ok(count)
}

fn flush(connection: &mut SqliteConnection, cards: &[ImportCard]) -> Result<(), String> {
    if cards.is_empty() {
        return Ok(());
    }
    let mut sql=QueryBuilder::new("INSERT INTO catalog_import_stage(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri) ");
    sql.push_values(cards, |mut b, c| {
        let x = &c.card;
        b.push_bind(&x.id)
            .push_bind(&x.oracle_id)
            .push_bind(&x.name)
            .push_bind(&x.set_code)
            .push_bind(&x.collector_number)
            .push_bind(&x.rarity)
            .push_bind(&c.metadata)
            .push_bind(&x.set_name)
            .push_bind(&x.mana_cost)
            .push_bind(x.cmc)
            .push_bind(&x.type_line)
            .push_bind(&x.oracle_text)
            .push_bind(serde_json::to_string(&x.colors).unwrap_or_else(|_| "[]".into()))
            .push_bind(&x.image_uri)
            .push_bind(&x.back_image_uri);
    });
    tauri::async_runtime::block_on(sql.build().execute(connection)).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pool() -> (tempfile::TempDir, SqlitePool) {
        let directory = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(directory.path().join("test.db"))
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = tauri::async_runtime::block_on(
            SqlitePoolOptions::new()
                .max_connections(2)
                .connect_with(options),
        )
        .unwrap();
        tauri::async_runtime::block_on(
            sqlx::raw_sql(include_str!("../migrations/001_initial.sql")).execute(&pool),
        )
        .unwrap();
        tauri::async_runtime::block_on(
            sqlx::raw_sql(include_str!("../migrations/002_catalog.sql")).execute(&pool),
        )
        .unwrap();
        (directory, pool)
    }
    fn fixture(id: &str, name: &str) -> Value {
        serde_json::json!({"object":"card","id":id,"oracle_id":"oracle","name":name,"set":"tst","set_name":"Test","collector_number":"1","rarity":"common","mana_cost":"{G}","cmc":1,"type_line":"Creature","colors":["G"],"oracle_text":"A test card."})
    }
    #[test]
    fn forge_extension_only_appends_and_preserves_saved_data() {
        let (_directory, pool) = pool();
        tauri::async_runtime::block_on(async {
            assert_eq!(
                append_values(&pool, vec![fixture("old", "Original")])
                    .await
                    .unwrap(),
                1
            );
            change_quantity(&pool, "old", 3).await.unwrap();
            sqlx::query("INSERT INTO decks(id,name) VALUES('saved','Saved')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('saved','old','main',2)").execute(&pool).await.unwrap();
            assert_eq!(
                append_values(
                    &pool,
                    vec![
                        fixture("old", "Must not change"),
                        fixture("new", "New printing")
                    ]
                )
                .await
                .unwrap(),
                1
            );
            assert_eq!(get_card_pool(&pool, "old").await.unwrap().name, "Original");
            assert_eq!(get_card_pool(&pool, "old").await.unwrap().owned, 3);
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM deck_cards WHERE deck_id='saved'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                2
            );
            assert_eq!(status_pool(&pool).await.unwrap().count, 2);
            let stamps = BTreeMap::from([("tst".into(), "stamp".into())]);
            stamp_forge_catalog(&pool, "2.0.14", &stamps, &[])
                .await
                .unwrap();
            assert_eq!(
                catalog_setting(&pool, "catalog_forge_version")
                    .await
                    .unwrap()
                    .as_deref(),
                Some("2.0.14")
            );
            pool.close().await;
        });
    }
    #[test]
    fn forge_upgrade_only_requests_missing_printings_from_changed_editions() {
        let editions = BTreeMap::from([
            (
                "old".into(),
                ("same".into(), vec![("1".into(), "Old".into())]),
            ),
            (
                "changed".into(),
                (
                    "new".into(),
                    vec![
                        ("1".into(), "Present".into()),
                        ("2".into(), "Missing".into()),
                        ("2".into(), "Variant".into()),
                    ],
                ),
            ),
            (
                "new".into(),
                ("first".into(), vec![("7".into(), "New".into())]),
            ),
        ]);
        let previous = BTreeMap::from([
            ("old".into(), "same".into()),
            ("changed".into(), "before".into()),
        ]);
        let present = HashSet::from([("changed".into(), "1".into())]);
        assert_eq!(
            missing_printings(editions, &previous, &present),
            vec![
                serde_json::json!({"set":"changed","collector_number":"2"}),
                serde_json::json!({"set":"new","collector_number":"7"})
            ]
        );
    }
    #[test]
    fn refresh_preserves_collection_decks_and_atomic_failure() {
        let (dir, pool) = pool();
        let source = dir.path().join("cards.json");
        fs::write(
            &source,
            serde_json::to_vec(&vec![fixture("one", "Old name")]).unwrap(),
        )
        .unwrap();
        assert_eq!(import_file(&pool, &source, |_| {}).unwrap(), 1);
        tauri::async_runtime::block_on(async {
            change_quantity(&pool, "one", 3).await.unwrap();
            sqlx::query("INSERT INTO decks(id,name) VALUES('deck','My deck')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('deck','one','main',2)").execute(&pool).await.unwrap();
        });
        fs::write(
            &source,
            format!(
                "{}\n{}\n",
                fixture("one", "New name"),
                fixture("two", "Another")
            ),
        )
        .unwrap();
        assert_eq!(import_file(&pool, &source, |_| {}).unwrap(), 2);
        tauri::async_runtime::block_on(async {
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='one'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                3
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM deck_cards WHERE card_id='one'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                2
            );
        });
        fs::write(
            &source,
            format!("[{},{{invalid]", fixture("one", "Broken refresh")),
        )
        .unwrap();
        assert!(import_file(&pool, &source, |_| {}).is_err());
        tauri::async_runtime::block_on(async {
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT name FROM cards WHERE id='one'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "New name"
            );
            pool.close().await;
        });
    }
    #[test]
    fn filters_pagination_and_ownership_are_consistent() {
        let (dir, pool) = pool();
        let source = dir.path().join("cards.json");
        fs::write(
            &source,
            serde_json::to_vec(&vec![fixture("one", "Alpha"), fixture("two", "Beta")]).unwrap(),
        )
        .unwrap();
        import_file(&pool, &source, |_| {}).unwrap();
        tauri::async_runtime::block_on(async {
            change_quantity(&pool, "one", 2).await.unwrap();
            assert!(change_quantity(&pool, "one", -3).await.is_err());
            let page = query_pool(
                &pool,
                CardQuery {
                    page_size: 1,
                    page: 1,
                    color: "G".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(page.total, 2);
            assert_eq!(page.cards[0].name, "Beta");
            let owned = query_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(owned.total, 1);
            assert_eq!(owned.cards[0].owned, 2);
            change_quantity(&pool, "one", -2).await.unwrap();
            assert_eq!(
                query_pool(
                    &pool,
                    CardQuery {
                        owned_only: true,
                        ..Default::default()
                    }
                )
                .await
                .unwrap()
                .total,
                0
            );
            pool.close().await;
        });
    }

    #[test]
    fn oracle_ownership_totals_all_printings_outside_browser_filters() {
        let (dir, pool) = pool();
        let source = dir.path().join("reprints.json");
        let first = fixture("first", "Shared card");
        let mut second = fixture("second", "Shared card");
        second["set"] = serde_json::json!("old");
        let mut unowned = fixture("unowned", "Shared card");
        unowned["collector_number"] = serde_json::json!("2");
        let mut unrelated = fixture("unrelated", "Other card");
        unrelated["oracle_id"] = serde_json::json!("other-oracle");
        fs::write(
            &source,
            serde_json::to_vec(&vec![first, second, unowned, unrelated]).unwrap(),
        )
        .unwrap();
        import_file(&pool, &source, |_| {}).unwrap();
        tauri::async_runtime::block_on(async {
            change_quantity(&pool, "first", 3).await.unwrap();
            change_quantity(&pool, "second", 1).await.unwrap();
            change_quantity(&pool, "unrelated", 2).await.unwrap();

            let first = get_card_pool(&pool, "first").await.unwrap();
            assert_eq!(first.owned, 3);
            assert_eq!(first.oracle_owned, 4);
            let unowned = get_card_pool(&pool, "unowned").await.unwrap();
            assert_eq!(unowned.owned, 0);
            assert_eq!(unowned.oracle_owned, 4);
            assert_eq!(
                get_card_pool(&pool, "unrelated")
                    .await
                    .unwrap()
                    .oracle_owned,
                2
            );

            let filtered = query_pool(
                &pool,
                CardQuery {
                    search: "Shared card".into(),
                    set_code: "tst".into(),
                    page_size: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(filtered.total, 2);
            assert_eq!(filtered.cards[0].oracle_owned, 4);

            // Older pack receipts/history do not have the new total field.
            let mut old_snapshot = serde_json::to_value(&first).unwrap();
            old_snapshot.as_object_mut().unwrap().remove("oracleOwned");
            let old_card: CatalogCard = serde_json::from_value(old_snapshot).unwrap();
            assert_eq!(old_card.owned, 3);
            assert_eq!(old_card.oracle_owned, 0);
            pool.close().await;
        });
    }

    #[test]
    fn basic_lands_are_available_only_when_deck_queries_request_them() {
        let (dir, pool) = pool();
        let source = dir.path().join("cards.json");
        let cards = [
            ("forest", "Forest", "Basic Land — Forest"),
            ("snow", "Snow-Covered Forest", "Basic Snow Land — Forest"),
            ("wastes", "Wastes", "Basic Land"),
            ("fake", "Not a basic", "Creature — Basic Land"),
            ("owned", "Owned card", "Creature"),
        ]
        .map(|(id, name, kind)| {
            let mut value = fixture(id, name);
            value["type_line"] = kind.into();
            value
        });
        fs::write(&source, serde_json::to_vec(&cards).unwrap()).unwrap();
        import_file(&pool, &source, |_| {}).unwrap();
        tauri::async_runtime::block_on(async {
            change_quantity(&pool, "owned", 1).await.unwrap();
            let collection = query_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(collection.total, 1);
            let deck = query_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    include_basic_lands: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(deck.total, 4);
            assert_eq!(
                deck.cards
                    .iter()
                    .filter(|card| is_unlimited_basic(card))
                    .count(),
                3
            );
            assert!(!deck.cards.iter().any(|card| card.id == "fake"));
            let minimum = query_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    include_basic_lands: true,
                    min_owned: 4,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(minimum.total, 3);
            assert_eq!(
                query_pool(
                    &pool,
                    CardQuery {
                        type_line: "Basic Land".into(),
                        ..Default::default()
                    }
                )
                .await
                .unwrap()
                .total,
                3
            );
            assert_eq!(get_card_pool(&pool, "forest").await.unwrap().owned, 0);
            change_quantity(&pool, "forest", 2).await.unwrap();
            assert_eq!(get_card_pool(&pool, "forest").await.unwrap().owned, 2);
            assert!(get_card_pool(&pool, "missing").await.is_err());
            pool.close().await;
        });
    }

    #[test]
    fn land_slot_migration_changes_only_the_previous_default() {
        let (dir, pool) = pool();
        let source = dir.path().join("cards.json");
        fs::write(
            &source,
            serde_json::to_vec(&vec![fixture("owned", "Owned card")]).unwrap(),
        )
        .unwrap();
        import_file(&pool, &source, |_| {}).unwrap();
        tauri::async_runtime::block_on(async {
            change_quantity(&pool, "owned", 2).await.unwrap();
            sqlx::query("UPDATE wildcards SET quantity=9 WHERE rarity='common'")
                .execute(&pool)
                .await
                .unwrap();
            for (commons, basic_lands, expected) in [(10, 1, 0), (11, 1, 1), (10, 2, 2)] {
                let settings = serde_json::json!({"league":{"booster":{"commons":commons,"uncommons":3,"rareSlots":1,"basicLands":basic_lands}},"forge":{"dataDir":"preserve-me"}});
                sqlx::query("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(settings.to_string()).execute(&pool).await.unwrap();
                sqlx::raw_sql(include_str!("../migrations/004_land_policy.sql"))
                    .execute(&pool)
                    .await
                    .unwrap();
                let value: String =
                    sqlx::query_scalar("SELECT value FROM settings WHERE key='app'")
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                let saved: Value = serde_json::from_str(&value).unwrap();
                assert_eq!(saved["league"]["booster"]["basicLands"], expected);
                assert_eq!(saved["forge"]["dataDir"], "preserve-me");
            }
            assert_eq!(get_card_pool(&pool, "owned").await.unwrap().owned, 2);
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM wildcards WHERE rarity='common'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                9
            );
            sqlx::query("UPDATE settings SET value='{invalid' WHERE key='app'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("../migrations/004_land_policy.sql"))
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        });
    }
    #[test]
    fn double_faces_keep_image_and_oracle_data() {
        let value = serde_json::json!({"id":"dfc","name":"Front // Back","set":"tst","rarity":"rare","card_faces":[{"name":"Front","oracle_id":"oracle-front","mana_cost":"{W}","type_line":"Creature","oracle_text":"Front rules","colors":["W"],"image_uris":{"normal":"https://cards.scryfall.io/front.jpg"}},{"name":"Back","oracle_text":"Back rules","colors":["B"],"image_uris":{"normal":"https://cards.scryfall.io/back.jpg"}}]});
        let card = normalize(value).unwrap().unwrap().card;
        assert_eq!(card.oracle_id, "oracle-front");
        assert!(card.back_image_uri.unwrap().ends_with("back.jpg"));
        assert_eq!(card.colors, vec!["B", "W"]);
        assert!(card.oracle_text.contains("Back rules"));
    }
    #[test]
    fn gzipped_jsonl_import_allows_concurrent_collection_edits() {
        let (dir, pool) = pool();
        let source = dir.path().join("cards.jsonl.gz");
        let mut compressed = flate2::write::GzEncoder::new(
            File::create(&source).unwrap(),
            flate2::Compression::fast(),
        );
        writeln!(&mut compressed, "{}", fixture("owned", "Owned card")).unwrap();
        compressed.finish().unwrap();
        import_file(&pool, &source, |_| {}).unwrap();
        tauri::async_runtime::block_on(change_quantity(&pool, "owned", 1)).unwrap();
        let mut compressed = flate2::write::GzEncoder::new(
            File::create(&source).unwrap(),
            flate2::Compression::fast(),
        );
        for n in 0..501 {
            writeln!(
                &mut compressed,
                "{}",
                fixture(&format!("new-{n}"), &format!("New card {n}"))
            )
            .unwrap();
        }
        compressed.finish().unwrap();
        let mut edited = false;
        assert_eq!(
            import_file(&pool, &source, |count| {
                if count == 500 && !edited {
                    tauri::async_runtime::block_on(change_quantity(&pool, "owned", 2)).unwrap();
                    edited = true;
                }
            })
            .unwrap(),
            501
        );
        tauri::async_runtime::block_on(async {
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM collection WHERE card_id='owned'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                3
            );
            pool.close().await;
        });
    }
}
