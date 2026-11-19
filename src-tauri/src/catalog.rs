use flate2::read::GzDecoder;
use reqwest::blocking::Client;
use serde::{
    de::{self, DeserializeSeed, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use serde_json::Value;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow},
    Connection, QueryBuilder, Row, Sqlite, SqliteConnection, SqlitePool,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
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
static BROWSE_POLICY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static BANNER_MOXES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const BROWSE_POLICY_VERSION: &str = "1";
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
    #[serde(default)]
    pub produced_mana: Vec<String>,
    pub image_uri: Option<String>,
    pub back_image_uri: Option<String>,
    pub owned: i64,
    #[serde(default)]
    pub oracle_owned: i64,
    pub forge_set_code: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
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
    pub colors: Vec<String>,
    pub mana_values: Vec<i64>,
    pub card_types: Vec<String>,
    pub creature_type: String,
    pub group_by_oracle: bool,
    pub available_only: bool,
    pub allocated: HashMap<String, i64>,
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
pub struct CardFilterOptions {
    pub colors: Vec<String>,
    pub mana_values: Vec<i64>,
    pub rarities: Vec<String>,
    pub sets: Vec<CatalogSet>,
    pub card_types: Vec<String>,
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

#[derive(Deserialize)]
struct ManaMetadata {
    #[serde(default)]
    produced_mana: Vec<String>,
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
        produced_mana: row
            .try_get::<&str, _>("metadata_json")
            .ok()
            .and_then(|metadata| serde_json::from_str::<ManaMetadata>(metadata).ok())
            .map(|metadata| metadata.produced_mana)
            .unwrap_or_default(),
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

fn literal_search_pattern(term: &str) -> String {
    let mut pattern = String::with_capacity(term.len() + 2);
    pattern.push('%');
    for character in term.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

fn push_sets(sql: &mut QueryBuilder<'_, Sqlite>, sets: &[String]) {
    sql.push("c.set_code IN (");
    if sets.is_empty() {
        sql.push("NULL");
    }
    for (index, code) in sets.iter().enumerate() {
        if index > 0 {
            sql.push(",");
        }
        sql.push_bind(code.to_lowercase());
    }
    sql.push(")");
}

fn push_main_type(sql: &mut QueryBuilder<'_, Sqlite>, kind: &str) {
    let kind = if kind.eq_ignore_ascii_case("Tribal") {
        "Kindred"
    } else {
        kind
    };
    let Some(kind) = crate::card_policy::MAIN_TYPES
        .iter()
        .find(|value| value.eq_ignore_ascii_case(kind))
    else {
        sql.push("0");
        return;
    };
    sql.push("EXISTS(SELECT 1 FROM json_each('[' || replace(json_quote(c.type_line),' // ','\",\"') || ']') type_face WHERE (instr(' ' || lower(substr(type_face.value,1,instr(type_face.value || '—','—')-1)) || ' ',")
        .push_bind(format!(" {} ", kind.to_lowercase()))
        .push(")>0");
    if *kind == "Kindred" {
        sql.push(" OR instr(' ' || lower(substr(type_face.value,1,instr(type_face.value || '—','—')-1)) || ' ',' tribal ')>0");
    }
    sql.push("))");
}

fn filters<'a>(
    prefix: &str,
    query: &'a CardQuery,
    unlocked: &[String],
) -> QueryBuilder<'a, Sqlite> {
    append_filters(QueryBuilder::new(prefix.to_owned()), query, unlocked)
}

fn append_filters<'a>(
    mut sql: QueryBuilder<'a, Sqlite>,
    query: &'a CardQuery,
    unlocked: &[String],
) -> QueryBuilder<'a, Sqlite> {
    sql.push(" FROM cards c LEFT JOIN collection o ON o.card_id=c.id WHERE ")
        .push("c.league_eligible=1");
    // Every browse scope, including All Cards and its facets/counts, uses only
    // globally unlocked expansions. Stored ownership remains pooled separately.
    sql.push(" AND ");
    push_sets(&mut sql, unlocked);
    // Every term must appear in the name or rules text. Keeping terms separate
    // lets searches such as "gain life" find "gain 3 life" as well.
    for term in query.search.split_whitespace() {
        let pattern = literal_search_pattern(term);
        sql.push(" AND (c.name LIKE ")
            .push_bind(pattern.clone())
            .push(" ESCAPE '\\' OR c.oracle_text LIKE ")
            .push_bind(pattern)
            .push(" ESCAPE '\\')");
    }
    if query.owned_only {
        sql.push(" AND (").push(ORACLE_OWNED_SQL).push(">0");
        if query.include_basic_lands {
            sql.push(" OR ").push(UNLIMITED_BASIC_SQL);
        }
        sql.push(")");
    }
    if query.min_owned > 0 {
        sql.push(" AND (")
            .push(ORACLE_OWNED_SQL)
            .push(">=")
            .push_bind(query.min_owned);
        if query.include_basic_lands {
            sql.push(" OR ").push(UNLIMITED_BASIC_SQL);
        }
        sql.push(")");
    }
    if query.available_only {
        sql.push(" AND (");
        if query.include_basic_lands {
            sql.push(UNLIMITED_BASIC_SQL).push(" OR ");
        }
        sql.push(ORACLE_OWNED_SQL).push(" > ");
        if query.allocated.is_empty() {
            sql.push("0");
        } else {
            sql.push("CASE c.oracle_id");
            for (oracle, quantity) in &query.allocated {
                sql.push(" WHEN ")
                    .push_bind(oracle.clone())
                    .push(" THEN ")
                    .push_bind((*quantity).max(0));
            }
            sql.push(" ELSE 0 END");
        }
        sql.push(")");
    }
    let colors = if query.colors.is_empty() {
        vec![query.color.clone()]
    } else {
        query.colors.clone()
    };
    let colors: Vec<_> = colors
        .iter()
        .map(|color| color.to_uppercase())
        .filter(|color| ["W", "U", "B", "R", "G", "C", "M"].contains(&color.as_str()))
        .collect();
    if !colors.is_empty() {
        sql.push(" AND (");
    }
    for (index, color) in colors.iter().enumerate() {
        if index > 0 {
            sql.push(" OR ");
        }
        match color.as_str() {
            "C" => {
                sql.push("json_array_length(c.colors_json)=0");
            }
            "M" => {
                sql.push("json_array_length(c.colors_json)>1");
            }
            "W" | "U" | "B" | "R" | "G" => {
                sql.push("instr(c.colors_json,")
                    .push_bind(format!("\"{color}\""))
                    .push(")>0");
            }
            _ => (),
        }
    }
    if !colors.is_empty() {
        sql.push(")");
    }
    if !query.rarity.is_empty() && query.rarity != "all" {
        sql.push(" AND c.rarity=")
            .push_bind(query.rarity.to_lowercase());
    }
    if !query.set_code.is_empty() && query.set_code != "all" {
        sql.push(" AND c.set_code=")
            .push_bind(query.set_code.to_lowercase());
    }
    if !query.card_types.is_empty() {
        sql.push(" AND (");
        for (index, kind) in query.card_types.iter().enumerate() {
            if index > 0 {
                sql.push(" OR ");
            }
            push_main_type(&mut sql, kind);
        }
        sql.push(")");
    } else if query.type_line.trim().eq_ignore_ascii_case("basic land") {
        sql.push(" AND ").push(UNLIMITED_BASIC_SQL);
    } else if !query.type_line.is_empty() && query.type_line != "all" {
        sql.push(" AND c.type_line LIKE ")
            .push_bind(format!("%{}%", query.type_line));
    }
    if !query.creature_type.trim().is_empty() {
        sql.push(" AND ");
        push_main_type(&mut sql, "Creature");
        sql.push(" AND instr(' ' || lower(c.type_line) || ' ',")
            .push_bind(format!(" {} ", query.creature_type.trim().to_lowercase()))
            .push(")>0");
    }
    let values: Vec<_> = query
        .mana_values
        .iter()
        .copied()
        .filter(|value| (0..=6).contains(value))
        .collect();
    if !values.is_empty() {
        sql.push(" AND (");
        for (index, value) in values.iter().enumerate() {
            if index > 0 {
                sql.push(" OR ");
            }
            if *value == 6 {
                sql.push("c.cmc>=6");
            } else {
                sql.push("c.cmc=").push_bind(*value);
            }
        }
        sql.push(")");
    } else if let Ok(value) = query.mana_value.parse::<f64>() {
        sql.push(" AND c.cmc=").push_bind(value);
    }
    sql
}

async fn ensure_browse_policy(pool: &SqlitePool) -> Result<(), String> {
    let version: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='catalog_browse_policy'")
            .fetch_optional(pool)
            .await
            .map_err(|error| error.to_string())?;
    if version.as_deref() == Some(BROWSE_POLICY_VERSION) {
        return Ok(());
    }
    let _lock = BROWSE_POLICY.lock().await;
    let version: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='catalog_browse_policy'")
            .fetch_optional(pool)
            .await
            .map_err(|error| error.to_string())?;
    if version.as_deref() == Some(BROWSE_POLICY_VERSION) {
        return Ok(());
    }
    let _operation = database_mutation_guard()?;
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query(&format!(
        "UPDATE cards AS c SET league_eligible=CASE WHEN {} AND {} THEN 1 ELSE 0 END",
        crate::card_policy::ELIGIBLE_SQL,
        crate::card_policy::regular_type_sql()
    ))
    .execute(&mut *transaction)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query("INSERT INTO settings(key,value) VALUES('catalog_browse_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(BROWSE_POLICY_VERSION).execute(&mut *transaction).await.map_err(|error|error.to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())
}

pub async fn query_pool(pool: &SqlitePool, query: CardQuery) -> Result<CardPage, String> {
    ensure_browse_policy(pool).await?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    let unlocked = crate::progression::unlocked_sets_connection(&mut connection).await?;
    drop(connection);
    let total: i64 = filters(
        if query.group_by_oracle {
            "SELECT COUNT(DISTINCT c.oracle_id)"
        } else {
            "SELECT COUNT(*)"
        },
        &query,
        &unlocked,
    )
    .build_query_scalar()
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let size = if query.page_size == 0 {
        30
    } else {
        query.page_size.clamp(1, 100)
    };
    let prefix = if query.group_by_oracle {
        let mut prefix = QueryBuilder::new("WITH matched AS (SELECT c.id,c.name,c.set_code,c.collector_number,ROW_NUMBER() OVER (PARTITION BY c.oracle_id ORDER BY CASE WHEN ".to_owned());
        push_sets(&mut prefix, &unlocked);
        prefix.push(" THEN 0 ELSE 1 END, CASE WHEN COALESCE(o.quantity,0)>0 THEN 0 ELSE 1 END,c.set_code,c.collector_number,c.id) AS representative_rank");
        prefix
    } else {
        QueryBuilder::new(format!(
            "SELECT c.*, COALESCE(o.quantity,0) AS owned, {ORACLE_OWNED_SQL} AS oracle_owned"
        ))
    };
    let mut sql = append_filters(prefix, &query, &unlocked);
    if query.group_by_oracle {
        sql.push(") SELECT c.*,COALESCE(o.quantity,0) AS owned,").push(ORACLE_OWNED_SQL)
            .push(" AS oracle_owned FROM cards c JOIN (SELECT id FROM matched WHERE representative_rank=1 ORDER BY name COLLATE NOCASE,set_code,collector_number,id LIMIT ")
            .push_bind(i64::from(size)).push(" OFFSET ").push_bind(i64::from(query.page)*i64::from(size))
            .push(") selected ON selected.id=c.id LEFT JOIN collection o ON o.card_id=c.id ORDER BY c.name COLLATE NOCASE,c.set_code,c.collector_number,c.id");
    } else {
        sql.push(" ORDER BY name COLLATE NOCASE,set_code,collector_number,id LIMIT ")
            .push_bind(i64::from(size))
            .push(" OFFSET ")
            .push_bind(i64::from(query.page) * i64::from(size));
    }
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

fn filter_scope(mut query: CardQuery) -> CardQuery {
    query.colors.clear();
    query.color.clear();
    query.mana_values.clear();
    query.mana_value.clear();
    query.card_types.clear();
    query.type_line.clear();
    query.creature_type.clear();
    query.rarity.clear();
    query.set_code.clear();
    query.page = 0;
    query
}

pub async fn filter_options_pool(
    pool: &SqlitePool,
    query: CardQuery,
) -> Result<CardFilterOptions, String> {
    ensure_browse_policy(pool).await?;
    let query = filter_scope(query);
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    let unlocked = crate::progression::unlocked_sets_connection(&mut connection).await?;
    drop(connection);
    let rows = filters(
        "SELECT c.oracle_id,c.colors_json,c.cmc,c.rarity,c.set_code,c.set_name,c.type_line",
        &query,
        &unlocked,
    )
    .build()
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())?;
    let mut colors = HashSet::new();
    let mut values = HashSet::new();
    let mut rarities = HashSet::new();
    let mut types = HashSet::new();
    let mut sets = BTreeMap::<String, (String, HashSet<String>)>::new();
    for row in rows {
        let card_colors: Vec<String> =
            serde_json::from_str(row.get("colors_json")).unwrap_or_default();
        if card_colors.is_empty() {
            colors.insert("C".to_owned());
        }
        if card_colors.len() > 1 {
            colors.insert("M".to_owned());
        }
        colors.extend(card_colors);
        let cmc: f64 = row.get("cmc");
        values.insert((cmc as i64).min(6));
        rarities.insert(row.get::<String, _>("rarity"));
        types.extend(crate::card_policy::main_types(row.get("type_line")));
        sets.entry(row.get("set_code"))
            .or_insert_with(|| (row.get("set_name"), HashSet::new()))
            .1
            .insert(row.get("oracle_id"));
    }
    let colors = ["W", "U", "B", "R", "G", "C", "M"]
        .into_iter()
        .filter(|color| colors.contains(*color))
        .map(str::to_owned)
        .collect();
    let mut mana_values: Vec<_> = values.into_iter().collect();
    mana_values.sort();
    let rarities = ["common", "uncommon", "rare", "mythic", "special", "bonus"]
        .into_iter()
        .filter(|rarity| rarities.contains(*rarity))
        .map(str::to_owned)
        .collect();
    let card_types = crate::card_policy::MAIN_TYPES
        .into_iter()
        .filter(|kind| types.contains(*kind))
        .map(str::to_owned)
        .collect();
    let mut sets: Vec<_> = sets
        .into_iter()
        .map(|(code, (name, oracles))| CatalogSet {
            code,
            name,
            count: oracles.len() as i64,
        })
        .collect();
    sets.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.code.cmp(&b.code))
    });
    Ok(CardFilterOptions {
        colors,
        mana_values,
        rarities,
        sets,
        card_types,
    })
}

#[tauri::command]
pub async fn card_filter_options(
    app: AppHandle,
    query: CardQuery,
) -> Result<CardFilterOptions, String> {
    filter_options_pool(&open_pool(&app).await?, query).await
}

pub async fn creature_types_pool(
    pool: &SqlitePool,
    query: CardQuery,
    search: &str,
) -> Result<Vec<String>, String> {
    let search = search.trim().to_lowercase();
    if search.chars().count() < 2 {
        return Ok(Vec::new());
    }
    ensure_browse_policy(pool).await?;
    let mut query = query;
    query.creature_type.clear();
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    let unlocked = crate::progression::unlocked_sets_connection(&mut connection).await?;
    drop(connection);
    let mut sql = filters("SELECT DISTINCT c.type_line", &query, &unlocked);
    sql.push(" AND ");
    push_main_type(&mut sql, "Creature");
    let rows = sql
        .build()
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
    let mut values = HashSet::new();
    for row in rows {
        values.extend(
            crate::card_policy::creature_types(row.get("type_line"))
                .into_iter()
                .filter(|kind| kind.to_lowercase().contains(&search)),
        );
    }
    let mut values: Vec<_> = values.into_iter().collect();
    values.sort_by_key(|kind| kind.to_lowercase());
    values.truncate(30);
    Ok(values)
}

#[tauri::command]
pub async fn search_creature_types(
    app: AppHandle,
    query: CardQuery,
    search: String,
) -> Result<Vec<String>, String> {
    creature_types_pool(&open_pool(&app).await?, query, &search).await
}

pub async fn printings_pool(
    pool: &SqlitePool,
    oracle_id: &str,
) -> Result<Vec<CatalogCard>, String> {
    ensure_browse_policy(pool).await?;
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    let unlocked = crate::progression::unlocked_sets_connection(&mut connection).await?;
    drop(connection);
    let query = CardQuery::default();
    let mut sql = filters(
        &format!("SELECT c.*,COALESCE(o.quantity,0) AS owned,{ORACLE_OWNED_SQL} AS oracle_owned"),
        &query,
        &unlocked,
    );
    sql.push(" AND c.oracle_id=")
        .push_bind(oracle_id.to_owned())
        .push(" AND ");
    push_sets(&mut sql, &unlocked);
    sql.push(" ORDER BY CASE WHEN COALESCE(o.quantity,0)>0 THEN 0 ELSE 1 END,c.set_code,c.collector_number,c.id");
    sql.build()
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?
        .iter()
        .map(card_from_row)
        .collect()
}

#[tauri::command]
pub async fn card_printings(app: AppHandle, oracle_id: String) -> Result<Vec<CatalogCard>, String> {
    printings_pool(&open_pool(&app).await?, &oracle_id).await
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
        let mut sql = QueryBuilder::new("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri,league_eligible) ");
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
                .push_bind(&value.back_image_uri)
                .push_bind(i64::from(card.eligible));
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
    ensure_browse_policy(&pool).await?;
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
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM cards WHERE name='Black Lotus' ORDER BY CASE lower(set_code) WHEN 'vma' THEN 0 WHEN 'ydmu' THEN 1 WHEN '30a' THEN 2 WHEN 'prm' THEN 3 WHEN 'lea' THEN 4 WHEN 'leb' THEN 5 WHEN '2ed' THEN 6 ELSE 7 END,collector_number,id LIMIT 1")
        .fetch_optional(&pool).await.map_err(|error| error.to_string())?;
    if let Some(id) = id {
        return get_card_pool(&pool, &id).await;
    }
    let _operation = database_mutation_guard()?;
    let value = tauri::async_runtime::spawn_blocking(|| {
        http_client()?
            .get("https://api.scryfall.com/cards/named")
            .timeout(Duration::from_secs(30))
            .query(&[("exact", "Black Lotus"), ("set", "vma")])
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

const BANNER_MOX_NAMES: [&str; 5] = [
    "Mox Pearl",
    "Mox Sapphire",
    "Mox Jet",
    "Mox Ruby",
    "Mox Emerald",
];

async fn banner_moxes_pool(pool: &SqlitePool) -> Result<Vec<CatalogCard>, String> {
    let mut cards = Vec::with_capacity(BANNER_MOX_NAMES.len());
    for name in BANNER_MOX_NAMES {
        // Decorative artwork can use Vintage Masters, which is deliberately
        // excluded from the league's regular paper-card browser.
        let id: Option<String> = sqlx::query_scalar("SELECT id FROM cards WHERE name=? ORDER BY CASE WHEN image_uri IS NULL THEN 1 ELSE 0 END,CASE lower(set_code) WHEN 'vma' THEN 0 WHEN '30a' THEN 1 WHEN 'prm' THEN 2 WHEN 'lea' THEN 3 WHEN 'leb' THEN 4 WHEN '2ed' THEN 5 ELSE 6 END,collector_number,id LIMIT 1")
            .bind(name).fetch_optional(pool).await.map_err(|error| error.to_string())?;
        if let Some(id) = id {
            cards.push(get_card_pool(pool, &id).await?);
        }
    }
    Ok(cards)
}

#[tauri::command]
pub async fn get_banner_moxes(app: AppHandle) -> Result<Vec<CatalogCard>, String> {
    let pool = open_pool(&app).await?;
    if status_pool(&pool).await?.count == 0 {
        return Err("The card catalog is still being prepared.".into());
    }
    let _banner = BANNER_MOXES.lock().await;
    let cards = banner_moxes_pool(&pool).await?;
    let missing: Vec<_> = BANNER_MOX_NAMES
        .into_iter()
        .filter(|name| !cards.iter().any(|card| card.name == *name))
        .collect();
    if missing.is_empty() {
        return Ok(cards);
    }
    let _operation = database_mutation_guard()?;
    let values = tauri::async_runtime::spawn_blocking(move || {
        let client = http_client()?;
        let mut values = Vec::new();
        for (index, name) in missing.into_iter().enumerate() {
            if index > 0 {
                std::thread::sleep(Duration::from_millis(150));
            }
            // Existing local artwork remains available if a missing card cannot
            // be fetched while offline. A later dashboard visit can retry it.
            let response = client
                .get("https://api.scryfall.com/cards/named")
                .timeout(Duration::from_secs(15))
                .query(&[("exact", name), ("set", "vma")])
                .send();
            if let Ok(response) = response.and_then(|response| response.error_for_status()) {
                if let Ok(value) = response.json::<Value>() {
                    values.push(value);
                }
            }
        }
        Ok::<_, String>(values)
    })
    .await
    .map_err(|error| error.to_string())??;
    if !values.is_empty() {
        append_values(&pool, values).await?;
    }
    banner_moxes_pool(&pool).await
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
            let imported = import_file_with_finalizing(
                &pool,
                &source,
                |count| progress(&app, "importing", count, None, "Importing card printings…"),
                |count| {
                    progress(
                        &app,
                        "finalizing",
                        count,
                        Some(count),
                        "Finalizing the offline catalog. Your collection and decks remain intact.",
                    )
                },
            );
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
    eligible: bool,
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
        produced_mana: value
            .get("produced_mana")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        image_uri,
        back_image_uri,
        owned: 0,
        oracle_owned: 0,
        forge_set_code: None,
    };
    let eligible = crate::card_policy::eligible(&value, &card);
    Ok(Some(ImportCard {
        card,
        metadata: serde_json::to_string(&value).map_err(|e| e.to_string())?,
        eligible,
    }))
}

#[cfg(test)]
pub fn import_file(pool: &SqlitePool, path: &Path, notify: impl FnMut(u64)) -> Result<u64, String> {
    import_file_with_finalizing(pool, path, notify, |_| {})
}

fn import_file_with_finalizing(
    pool: &SqlitePool,
    path: &Path,
    mut notify: impl FnMut(u64),
    mut finalizing: impl FnMut(u64),
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
    tauri::async_runtime::block_on(sqlx::query("CREATE TEMP TABLE catalog_import_stage AS SELECT id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri,league_eligible FROM cards WHERE 0").execute(&mut *connection)).map_err(|e|e.to_string())?;
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
    finalizing(count);
    tauri::async_runtime::block_on(merge_catalog_stage(
        &mut connection,
        3,
        Duration::from_millis(200),
    ))
    .map_err(|error| {
        if sqlite_busy(&error) {
            "Another database operation is still running. Close other Arcane Fold windows and retry catalog setup. Your saved collection and decks were preserved.".to_string()
        } else {
            format!("Could not commit the catalog; existing data was preserved: {error}")
        }
    })?;
    notify(count);
    Ok(count)
}

fn sqlite_busy(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|error| error.code())
        .and_then(|code| code.parse::<u32>().ok())
        .is_some_and(|code| code & 0xff == 5)
}

async fn merge_catalog_stage(
    connection: &mut SqliteConnection,
    attempts: usize,
    retry_delay: Duration,
) -> Result<(), sqlx::Error> {
    // SQLite permits one writer even with WAL. Retain the complete TEMP stage
    // while waiting, and acquire write access before reading any main snapshot.
    // Only lock acquisition is retried; a constraint/disk/merge failure is not.
    // Production keeps the normal 20-second busy timeout and tries at most 3
    // times, instead of repeatedly downloading/parsing or waiting indefinitely.
    for attempt in 0..attempts.max(1) {
        let mut transaction = match connection.begin_with("BEGIN IMMEDIATE").await {
            Ok(transaction) => transaction,
            Err(error) if sqlite_busy(&error) && attempt + 1 < attempts => {
                tokio::time::sleep(retry_delay).await;
                continue;
            }
            Err(error) => return Err(error),
        };
        let merged = async {
            let fresh: bool = sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM cards)")
                .fetch_one(&mut *transaction)
                .await?;
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri,league_eligible) SELECT id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri,league_eligible FROM catalog_import_stage WHERE 1 ON CONFLICT(id) DO UPDATE SET oracle_id=excluded.oracle_id,name=excluded.name,set_code=excluded.set_code,collector_number=excluded.collector_number,rarity=excluded.rarity,metadata_json=excluded.metadata_json,set_name=excluded.set_name,mana_cost=excluded.mana_cost,cmc=excluded.cmc,type_line=excluded.type_line,oracle_text=excluded.oracle_text,colors_json=excluded.colors_json,image_uri=excluded.image_uri,back_image_uri=excluded.back_image_uri,league_eligible=excluded.league_eligible").execute(&mut *transaction).await?;
            sqlx::query("INSERT INTO settings(key,value) VALUES('catalog_updated_at',strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value").execute(&mut *transaction).await?;
            // normalize() derived eligibility for every row in a fresh catalog.
            // Avoid immediately locking it again for a redundant full backfill.
            // Partial/legacy catalogs can contain unimported old rows and must
            // retain the existing policy-upgrade path instead.
            if fresh {
                sqlx::query("INSERT INTO settings(key,value) VALUES('catalog_browse_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
                    .bind(BROWSE_POLICY_VERSION).execute(&mut *transaction).await?;
            }
            Ok::<(), sqlx::Error>(())
        }.await;
        if let Err(error) = merged {
            transaction.rollback().await?;
            return Err(error);
        }
        transaction.commit().await?;
        // TEMP cleanup cannot turn an already committed catalog into a reported
        // import failure. The next import also clears any leftover TEMP stage.
        let _ = sqlx::query("DROP TABLE temp.catalog_import_stage")
            .execute(&mut *connection)
            .await;
        return Ok(());
    }
    unreachable!("there is always at least one catalog merge attempt")
}

fn flush(connection: &mut SqliteConnection, cards: &[ImportCard]) -> Result<(), String> {
    if cards.is_empty() {
        return Ok(());
    }
    let mut sql=QueryBuilder::new("INSERT INTO catalog_import_stage(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,set_name,mana_cost,cmc,type_line,oracle_text,colors_json,image_uri,back_image_uri,league_eligible) ");
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
            .push_bind(&x.back_image_uri)
            .push_bind(i64::from(c.eligible));
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
        tauri::async_runtime::block_on(
            sqlx::raw_sql(include_str!("../migrations/006_catalog_eligibility.sql")).execute(&pool),
        )
        .unwrap();
        tauri::async_runtime::block_on(
            sqlx::query("INSERT INTO settings(key,value) VALUES('test.unlocked-sets','[\"tst\"]')")
                .execute(&pool),
        )
        .unwrap();
        (directory, pool)
    }
    fn fixture(id: &str, name: &str) -> Value {
        serde_json::json!({"object":"card","id":id,"oracle_id":id,"name":name,"set":"tst","set_name":"Test","collector_number":"1","rarity":"common","mana_cost":"{G}","cmc":1,"type_line":"Creature","colors":["G"],"oracle_text":"A test card."})
    }

    fn wal_pool_pair() -> (tempfile::TempDir, SqlitePool, SqlitePool) {
        let (directory, initial) = pool();
        tauri::async_runtime::block_on(initial.close());
        let options = SqliteConnectOptions::new()
            .filename(directory.path().join("test.db"))
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_millis(20));
        let (pool, other) = tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(2)
                .connect_with(options.clone())
                .await
                .unwrap();
            let other = SqlitePoolOptions::new()
                .max_connections(2)
                .connect_with(options)
                .await
                .unwrap();
            (pool, other)
        });
        (directory, pool, other)
    }

    #[test]
    fn catalog_import_waits_for_another_wal_writer_without_reparsing_or_losing_progress() {
        let (directory, pool, other) = wal_pool_pair();
        tauri::async_runtime::block_on(async {
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json) VALUES('owned','owned','Owned card','tst','1','common','{}')").execute(&pool).await.unwrap();
            sqlx::raw_sql("INSERT INTO collection(card_id,quantity) VALUES('owned',2); INSERT INTO decks(id,name) VALUES('saved','Saved deck'); INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('saved','owned','main',1); UPDATE wildcards SET quantity=7 WHERE rarity='common'; INSERT INTO settings(key,value) VALUES('app','preserve-settings'); INSERT INTO booster_history(id,set_code,contents_json) VALUES('opening','tst','[]');").execute(&pool).await.unwrap();
            // Pre-open both connections so connection setup is outside contention.
            let first = pool.acquire().await.unwrap();
            let second = pool.acquire().await.unwrap();
            drop((first, second));
        });
        let source = directory.path().join("concurrent.json");
        let cards: Vec<_> = (0..501)
            .map(|n| fixture(&format!("new-{n}"), "New card"))
            .collect();
        fs::write(&source, serde_json::to_vec(&cards).unwrap()).unwrap();
        let (ready, acquired) = std::sync::mpsc::channel();
        let writer_pool = other.clone();
        let writer = std::thread::spawn(move || {
            tauri::async_runtime::block_on(async {
                let mut transaction = writer_pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
                sqlx::query("INSERT INTO settings(key,value) VALUES('other-writer','committed')")
                    .execute(&mut *transaction)
                    .await
                    .unwrap();
                ready.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(180));
                transaction.commit().await.unwrap();
            })
        });
        acquired.recv_timeout(Duration::from_secs(3)).unwrap();
        let mut parsed = Vec::new();
        let mut finalizing = Vec::new();
        let imported = import_file_with_finalizing(
            &pool,
            &source,
            |count| {
                parsed.push(count);
                if count == 500 {
                    assert_eq!(
                        tauri::async_runtime::block_on(
                            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cards")
                                .fetch_one(&pool)
                        )
                        .unwrap(),
                        1
                    );
                }
            },
            |count| finalizing.push(count),
        );
        writer.join().unwrap();
        assert_eq!(imported.unwrap(), 501);
        assert_eq!(parsed, [500, 501]);
        assert_eq!(finalizing, [501]);
        tauri::async_runtime::block_on(async {
            assert_eq!(status_pool(&pool).await.unwrap().count, 502);
            assert_eq!(get_card_pool(&pool, "owned").await.unwrap().owned, 2);
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM deck_cards WHERE deck_id='saved'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM wildcards WHERE rarity='common'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                7
            );
            assert_eq!(
                catalog_setting(&pool, "app").await.unwrap().as_deref(),
                Some("preserve-settings")
            );
            assert_eq!(
                catalog_setting(&pool, "other-writer")
                    .await
                    .unwrap()
                    .as_deref(),
                Some("committed")
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM booster_history")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "ok"
            );
            pool.close().await;
            other.close().await;
        });
    }

    #[test]
    fn catalog_merge_bounds_busy_retries_and_retains_the_stage_for_a_later_attempt() {
        let (_directory, pool, other) = wal_pool_pair();
        tauri::async_runtime::block_on(async {
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json) VALUES('old','old','Old card','tst','1','common','{}')").execute(&pool).await.unwrap();
            let mut connection = pool.acquire().await.unwrap();
            sqlx::raw_sql("CREATE TEMP TABLE catalog_import_stage AS SELECT * FROM cards; UPDATE catalog_import_stage SET id='new',oracle_id='new';")
                .execute(&mut *connection).await.unwrap();
            let writer = other.begin_with("BEGIN IMMEDIATE").await.unwrap();
            let started = std::time::Instant::now();
            let error = merge_catalog_stage(&mut connection, 2, Duration::ZERO)
                .await
                .unwrap_err();
            assert!(sqlite_busy(&error));
            assert!(started.elapsed() < Duration::from_secs(5));
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cards WHERE id='new'")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM temp.catalog_import_stage")
                    .fetch_one(&mut *connection)
                    .await
                    .unwrap(),
                1
            );
            writer.rollback().await.unwrap();
            merge_catalog_stage(&mut connection, 2, Duration::ZERO)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cards")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                2
            );
            drop(connection);
            pool.close().await;
            other.close().await;
        });
    }

    #[test]
    fn catalog_merge_rolls_back_cards_policy_and_timestamp_after_a_late_failure() {
        let (directory, pool) = pool();
        tauri::async_runtime::block_on(async {
            sqlx::raw_sql("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json) VALUES('owned','owned','Original name','tst','1','common','{}'); INSERT INTO collection(card_id,quantity) VALUES('owned',2); INSERT INTO settings(key,value) VALUES('catalog_updated_at','before'); CREATE TRIGGER reject_catalog_stamp BEFORE INSERT ON settings WHEN NEW.key='catalog_updated_at' BEGIN SELECT RAISE(ABORT,'fixture stamp failure'); END;")
                .execute(&pool).await.unwrap();
        });
        let source = directory.path().join("late-failure.json");
        fs::write(
            &source,
            serde_json::to_vec(&[fixture("owned", "Changed name"), fixture("new", "New card")])
                .unwrap(),
        )
        .unwrap();
        let error = import_file(&pool, &source, |_| {}).unwrap_err();
        assert!(error.contains("fixture stamp failure"));
        tauri::async_runtime::block_on(async {
            assert_eq!(status_pool(&pool).await.unwrap().count, 1);
            let owned = get_card_pool(&pool, "owned").await.unwrap();
            assert_eq!(owned.name, "Original name");
            assert_eq!(owned.owned, 2);
            assert_eq!(
                catalog_setting(&pool, "catalog_updated_at")
                    .await
                    .unwrap()
                    .as_deref(),
                Some("before")
            );
            assert_eq!(
                catalog_setting(&pool, "catalog_browse_policy")
                    .await
                    .unwrap(),
                None
            );
            sqlx::query("DROP TRIGGER reject_catalog_stamp")
                .execute(&pool)
                .await
                .unwrap();
        });
        assert_eq!(import_file(&pool, &source, |_| {}).unwrap(), 2);
        tauri::async_runtime::block_on(async {
            assert_eq!(get_card_pool(&pool, "owned").await.unwrap().owned, 2);
            pool.close().await;
        });
    }

    #[test]
    fn fresh_catalog_import_avoids_a_redundant_eligibility_write_but_partial_catalogs_upgrade() {
        let (directory, fresh_pool) = pool();
        let source = directory.path().join("fresh.json");
        fs::write(
            &source,
            serde_json::to_vec(&[fixture("fresh", "Fresh creature")]).unwrap(),
        )
        .unwrap();
        import_file(&fresh_pool, &source, |_| {}).unwrap();
        tauri::async_runtime::block_on(async {
            assert_eq!(
                catalog_setting(&fresh_pool, "catalog_browse_policy")
                    .await
                    .unwrap()
                    .as_deref(),
                Some(BROWSE_POLICY_VERSION)
            );
            sqlx::query("CREATE TRIGGER reject_redundant_backfill BEFORE UPDATE OF league_eligible ON cards BEGIN SELECT RAISE(ABORT,'unexpected full catalog backfill'); END")
                .execute(&fresh_pool).await.unwrap();
            assert_eq!(
                query_pool(&fresh_pool, CardQuery::default())
                    .await
                    .unwrap()
                    .total,
                1
            );
            fresh_pool.close().await;
        });
        let (partial_directory, partial_pool) = pool();
        tauri::async_runtime::block_on(async {
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,type_line) VALUES('legacy','legacy','Legacy creature','tst','1','common','{}','Creature')")
                .execute(&partial_pool).await.unwrap();
        });
        let source = partial_directory.path().join("partial.json");
        fs::write(
            &source,
            serde_json::to_vec(&[fixture("new", "New creature")]).unwrap(),
        )
        .unwrap();
        import_file(&partial_pool, &source, |_| {}).unwrap();
        tauri::async_runtime::block_on(async {
            assert_eq!(
                catalog_setting(&partial_pool, "catalog_browse_policy")
                    .await
                    .unwrap(),
                None
            );
            assert_eq!(
                query_pool(&partial_pool, CardQuery::default())
                    .await
                    .unwrap()
                    .total,
                2
            );
            assert_eq!(
                catalog_setting(&partial_pool, "catalog_browse_policy")
                    .await
                    .unwrap()
                    .as_deref(),
                Some(BROWSE_POLICY_VERSION)
            );
            partial_pool.close().await;
        });
    }
    #[test]
    fn banner_selects_all_five_original_moxes_preferring_vma_without_acquiring_cards() {
        let (_directory, pool) = pool();
        tauri::async_runtime::block_on(async {
            let mut values = Vec::new();
            for (index, name) in BANNER_MOX_NAMES.into_iter().enumerate() {
                let mut classic = fixture(&format!("classic-{index}"), name);
                classic["set"] = "leb".into();
                classic["image_uris"] = serde_json::json!({"normal": "https://cards.scryfall.io/normal/front/test.jpg"});
                values.push(classic);
                if name != "Mox Sapphire" {
                    let mut modern = fixture(&format!("modern-{index}"), name);
                    modern["set"] = "vma".into();
                    modern["image_uris"] = serde_json::json!({"normal": "https://cards.scryfall.io/normal/front/test.jpg"});
                    values.push(modern);
                }
            }
            values.push(fixture("other-mox", "Mox Opal"));
            append_values(&pool, values).await.unwrap();
            let cards = banner_moxes_pool(&pool).await.unwrap();
            assert_eq!(
                cards
                    .iter()
                    .map(|card| card.name.as_str())
                    .collect::<Vec<_>>(),
                BANNER_MOX_NAMES
            );
            assert_eq!(cards[1].set_code, "leb");
            assert!(cards
                .iter()
                .filter(|card| card.name != "Mox Sapphire")
                .all(|card| card.set_code == "vma"));
            assert!(cards
                .iter()
                .all(|card| card.owned == 0 && card.oracle_owned == 0));
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collection")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );
            pool.close().await;
        });
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
    fn grouped_collection_budgets_printings_and_pagination_share_oracle_identity() {
        let (_directory, pool) = pool();
        let mut first = fixture("owned", "A Shared Elf");
        first["oracle_id"] = "elf".into();
        let mut alternate = fixture("alternate", "A Shared Elf");
        alternate["oracle_id"] = "elf".into();
        alternate["collector_number"] = "2".into();
        let mut locked = fixture("locked", "A Shared Elf");
        locked["oracle_id"] = "elf".into();
        locked["set"] = "future".into();
        let second = fixture("second", "B Another Creature");
        let mut basic = fixture("basic", "Forest");
        basic["type_line"] = "Basic Land — Forest".into();
        let mut locked_basic = fixture("locked-basic", "Forest");
        locked_basic["type_line"] = "Basic Land — Forest".into();
        locked_basic["set"] = "future".into();
        tauri::async_runtime::block_on(async {
            append_values(
                &pool,
                vec![first, alternate, locked, second, basic, locked_basic],
            )
            .await
            .unwrap();
            change_quantity(&pool, "owned", 2).await.unwrap();
            change_quantity(&pool, "locked", 2).await.unwrap();
            change_quantity(&pool, "second", 1).await.unwrap();
            let query = CardQuery {
                owned_only: true,
                group_by_oracle: true,
                page_size: 1,
                ..Default::default()
            };
            let page = query_pool(&pool, query.clone()).await.unwrap();
            assert_eq!(page.total, 2);
            assert_eq!(page.cards[0].id, "owned");
            assert_eq!(page.cards[0].owned, 2);
            assert_eq!(page.cards[0].oracle_owned, 4);
            let page = query_pool(
                &pool,
                CardQuery {
                    page: 1,
                    ..query.clone()
                },
            )
            .await
            .unwrap();
            assert_eq!(page.total, 2);
            assert_eq!(page.cards[0].id, "second");
            let prints = printings_pool(&pool, "elf").await.unwrap();
            assert_eq!(prints.len(), 2);
            assert!(prints
                .iter()
                .all(|card| card.set_code == "tst" && card.oracle_owned == 4));
            assert!(prints
                .iter()
                .any(|card| card.id == "alternate" && card.owned == 0));
            let available = query_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    include_basic_lands: true,
                    group_by_oracle: true,
                    available_only: true,
                    allocated: HashMap::from([("elf".into(), 4), ("second".into(), 1)]),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(available.total, 1);
            assert_eq!(available.cards[0].id, "basic");
            let all = query_pool(&pool, CardQuery::default()).await.unwrap();
            assert!(!all.cards.iter().any(|card| card.id == "locked"));
            assert!(!all.cards.iter().any(|card| card.id == "locked-basic"));
            assert_eq!(
                get_card_pool(&pool, "locked-basic").await.unwrap().set_code,
                "future"
            );
            let grouped_all = query_pool(
                &pool,
                CardQuery {
                    search: "Shared Elf".into(),
                    group_by_oracle: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(grouped_all.total, 1);
            assert_eq!(grouped_all.cards[0].id, "owned");
            pool.close().await;
        });
    }

    #[test]
    fn all_cards_counts_filters_and_suggestions_follow_unlocks_without_changing_ownership() {
        let (_directory, pool) = pool();
        tauri::async_runtime::block_on(async {
            let mut first = fixture("first", "A Shared Elf");
            first["oracle_id"] = "shared".into();
            first["type_line"] = "Creature — Elf".into();
            let mut alternate = first.clone();
            alternate["id"] = "alternate".into();
            alternate["collector_number"] = "2".into();
            let mut locked_shared = first.clone();
            locked_shared["id"] = "locked-shared".into();
            locked_shared["set"] = "future".into();
            locked_shared["set_name"] = "Future Set".into();
            let mut locked_only = fixture("locked-only", "B Future Basilisk");
            locked_only["set"] = "future".into();
            locked_only["set_name"] = "Future Set".into();
            locked_only["rarity"] = "mythic".into();
            locked_only["colors"] = serde_json::json!(["B"]);
            locked_only["cmc"] = 7.into();
            locked_only["type_line"] = "Creature — Basilisk".into();
            let mut locked_artifact = locked_only.clone();
            locked_artifact["id"] = "locked-artifact".into();
            locked_artifact["oracle_id"] = "artifact".into();
            locked_artifact["name"] = "C Future Artifact".into();
            locked_artifact["type_line"] = "Artifact".into();
            let mut locked_basic = fixture("locked-basic", "Forest");
            locked_basic["set"] = "future".into();
            locked_basic["set_name"] = "Future Set".into();
            locked_basic["type_line"] = "Basic Land — Forest".into();
            append_values(
                &pool,
                vec![
                    first,
                    alternate,
                    locked_shared,
                    locked_only,
                    locked_artifact,
                    locked_basic,
                ],
            )
            .await
            .unwrap();
            change_quantity(&pool, "locked-shared", 3).await.unwrap();
            change_quantity(&pool, "locked-only", 2).await.unwrap();
            let owned_before: Vec<(String, i64)> =
                sqlx::query_as("SELECT card_id,quantity FROM collection ORDER BY card_id")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let all = CardQuery {
                group_by_oracle: true,
                ..Default::default()
            };
            let grouped = query_pool(&pool, all.clone()).await.unwrap();
            assert_eq!(grouped.total, 1);
            assert_eq!(grouped.cards[0].set_code, "tst");
            assert_eq!(grouped.cards[0].oracle_owned, 3);
            assert_eq!(grouped.cards[0].owned, 0);
            // Unlocked reprints still use ownership held in a locked expansion.
            assert_eq!(
                query_pool(
                    &pool,
                    CardQuery {
                        owned_only: true,
                        ..all.clone()
                    }
                )
                .await
                .unwrap()
                .total,
                1
            );
            for page in 0..2 {
                let result = query_pool(
                    &pool,
                    CardQuery {
                        page,
                        page_size: 1,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                assert_eq!(result.total, 2);
                assert_eq!(result.cards.len(), 1);
                assert_eq!(result.cards[0].set_code, "tst");
            }
            for group_by_oracle in [false, true] {
                assert_eq!(
                    query_pool(
                        &pool,
                        CardQuery {
                            set_code: "future".into(),
                            group_by_oracle,
                            ..Default::default()
                        }
                    )
                    .await
                    .unwrap()
                    .total,
                    0
                );
            }
            assert_eq!(
                query_pool(
                    &pool,
                    CardQuery {
                        search: "Basilisk".into(),
                        ..all.clone()
                    }
                )
                .await
                .unwrap()
                .total,
                0
            );
            let options = filter_options_pool(&pool, all.clone()).await.unwrap();
            assert_eq!(
                options
                    .sets
                    .iter()
                    .map(|set| (set.code.as_str(), set.count))
                    .collect::<Vec<_>>(),
                vec![("tst", 1)]
            );
            assert_eq!(options.colors, vec!["G"]);
            assert_eq!(options.mana_values, vec![1]);
            assert_eq!(options.rarities, vec!["common"]);
            assert_eq!(options.card_types, vec!["Creature"]);
            assert!(creature_types_pool(&pool, all.clone(), "ba")
                .await
                .unwrap()
                .is_empty());
            assert_eq!(printings_pool(&pool, "shared").await.unwrap().len(), 2);
            assert_eq!(get_card_pool(&pool, "locked-only").await.unwrap().owned, 2);
            // The next unlock exposes existing catalog rows without an import.
            sqlx::query(
                "UPDATE settings SET value='[\"tst\",\"future\"]' WHERE key='test.unlocked-sets'",
            )
            .execute(&pool)
            .await
            .unwrap();
            assert_eq!(query_pool(&pool, all.clone()).await.unwrap().total, 4);
            assert_eq!(
                query_pool(&pool, CardQuery::default()).await.unwrap().total,
                6
            );
            let options = filter_options_pool(&pool, all.clone()).await.unwrap();
            assert_eq!(
                options
                    .sets
                    .iter()
                    .map(|set| set.code.as_str())
                    .collect::<Vec<_>>(),
                vec!["future", "tst"]
            );
            assert!(options.rarities.contains(&"mythic".to_string()));
            assert!(options.card_types.contains(&"Artifact".to_string()));
            assert_eq!(
                creature_types_pool(&pool, all, "ba").await.unwrap(),
                vec!["Basilisk"]
            );
            assert_eq!(printings_pool(&pool, "shared").await.unwrap().len(), 3);
            let owned_after: Vec<(String, i64)> =
                sqlx::query_as("SELECT card_id,quantity FROM collection ORDER BY card_id")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(owned_after, owned_before);
            assert_eq!(status_pool(&pool).await.unwrap().count, 6);
            pool.close().await;
        });
    }

    #[test]
    fn empty_unlock_pool_hides_all_browse_results_but_keeps_stored_card_details() {
        let (_directory, pool) = pool();
        tauri::async_runtime::block_on(async {
            let mut card = fixture("owned", "Stored Elf");
            card["type_line"] = "Creature — Elf".into();
            append_values(&pool, vec![card]).await.unwrap();
            change_quantity(&pool, "owned", 1).await.unwrap();
            sqlx::query("UPDATE settings SET value='[]' WHERE key='test.unlocked-sets'")
                .execute(&pool)
                .await
                .unwrap();
            for owned_only in [false, true] {
                let query = CardQuery {
                    owned_only,
                    group_by_oracle: true,
                    include_basic_lands: true,
                    ..Default::default()
                };
                let result = query_pool(&pool, query.clone()).await.unwrap();
                assert_eq!(result.total, 0);
                assert!(result.cards.is_empty());
                assert!(filter_options_pool(&pool, query.clone())
                    .await
                    .unwrap()
                    .sets
                    .is_empty());
                assert!(creature_types_pool(&pool, query, "el")
                    .await
                    .unwrap()
                    .is_empty());
            }
            assert!(printings_pool(&pool, "owned").await.unwrap().is_empty());
            assert_eq!(get_card_pool(&pool, "owned").await.unwrap().owned, 1);
            assert_eq!(status_pool(&pool).await.unwrap().count, 1);
            pool.close().await;
        });
    }

    #[test]
    fn eligibility_cache_upgrades_existing_rows_and_stays_correct_after_catalog_writes() {
        let (directory, pool) = pool();
        tauri::async_runtime::block_on(async {
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,type_line) VALUES('old','old','Old creature','tst','1','common','{}','Creature')").execute(&pool).await.unwrap();
            change_quantity(&pool, "old", 2).await.unwrap();
            let initial = query_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(initial.total, 1);
            assert_eq!(initial.cards[0].owned, 2);
            append_values(&pool, vec![fixture("appended", "Appended creature")])
                .await
                .unwrap();
            assert_eq!(
                query_pool(&pool, CardQuery::default()).await.unwrap().total,
                2
            );
        });
        let mut changed = fixture("old", "Old creature");
        changed["border_color"] = "gold".into();
        let source = directory.path().join("changed.json");
        fs::write(&source, serde_json::to_vec(&vec![changed]).unwrap()).unwrap();
        import_file(&pool, &source, |_| {}).unwrap();
        tauri::async_runtime::block_on(async {
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
            assert_eq!(get_card_pool(&pool, "old").await.unwrap().owned, 2);
            assert_eq!(
                query_pool(&pool, CardQuery::default()).await.unwrap().total,
                1
            );
            pool.close().await;
        });
    }

    #[test]
    fn printing_choices_use_global_unlocks_and_pooled_ownership_across_uncollected_expansions() {
        let (_directory, pool) = pool();
        let mut original = fixture("set-a-owned", "Shared Elf");
        original["oracle_id"] = "elf".into();
        original["type_line"] = "Creature — Elf Druid".into();
        let mut alternate = fixture("set-a-variant", "Shared Elf");
        alternate["oracle_id"] = "elf".into();
        alternate["collector_number"] = "2".into();
        alternate["type_line"] = "Creature — Elf Druid".into();
        let mut next = fixture("set-b-first", "Shared Elf");
        next["oracle_id"] = "elf".into();
        next["set"] = "nxt".into();
        next["set_name"] = "Next Set".into();
        next["rarity"] = "rare".into();
        next["type_line"] = "Creature — Elf Druid".into();
        let mut next_variant = next.clone();
        next_variant["id"] = "set-b-variant".into();
        next_variant["collector_number"] = "2".into();
        let mut locked = next.clone();
        locked["id"] = "set-c-locked".into();
        locked["set"] = "future".into();
        locked["set_name"] = "Future Set".into();
        locked["rarity"] = "mythic".into();
        locked["type_line"] = "Creature — Elf Wizard".into();
        let mut basic = fixture("next-basic", "Forest");
        basic["set"] = "nxt".into();
        basic["set_name"] = "Next Set".into();
        basic["type_line"] = "Basic Land — Forest".into();
        basic["oracle_id"] = "forest".into();
        tauri::async_runtime::block_on(async {
            sqlx::query(
                "UPDATE settings SET value='[\"tst\",\"nxt\"]' WHERE key='test.unlocked-sets'",
            )
            .execute(&pool)
            .await
            .unwrap();
            append_values(
                &pool,
                vec![original, alternate, next, next_variant, locked, basic],
            )
            .await
            .unwrap();
            change_quantity(&pool, "set-a-owned", 3).await.unwrap();
            let prints = printings_pool(&pool, "elf").await.unwrap();
            assert_eq!(prints.len(), 4);
            assert!(prints
                .iter()
                .all(|card| ["tst", "nxt"].contains(&card.set_code.as_str())
                    && card.oracle_owned == 3));
            assert!(prints
                .iter()
                .any(|card| card.id == "set-a-variant" && card.owned == 0));
            let scope = CardQuery {
                owned_only: true,
                group_by_oracle: true,
                ..Default::default()
            };
            let before = query_pool(
                &pool,
                CardQuery {
                    set_code: "nxt".into(),
                    ..scope.clone()
                },
            )
            .await
            .unwrap();
            assert_eq!(before.total, 1);
            assert_eq!(before.cards[0].oracle_owned, 3);
            assert_eq!(before.cards[0].owned, 0);
            assert_eq!(
                query_pool(
                    &pool,
                    CardQuery {
                        set_code: "nxt".into(),
                        available_only: true,
                        allocated: HashMap::from([("elf".into(), 2)]),
                        ..scope.clone()
                    }
                )
                .await
                .unwrap()
                .total,
                1
            );
            assert_eq!(
                query_pool(
                    &pool,
                    CardQuery {
                        set_code: "nxt".into(),
                        available_only: true,
                        allocated: HashMap::from([("elf".into(), 3)]),
                        ..scope.clone()
                    }
                )
                .await
                .unwrap()
                .total,
                0
            );
            let facets = filter_options_pool(&pool, scope.clone()).await.unwrap();
            assert_eq!(
                facets
                    .sets
                    .iter()
                    .map(|set| set.code.as_str())
                    .collect::<Vec<_>>(),
                vec!["nxt", "tst"]
            );
            assert_eq!(facets.rarities, vec!["common", "rare"]);
            let all = query_pool(
                &pool,
                CardQuery {
                    set_code: "nxt".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert!(all.cards.iter().any(|card| card.id == "set-b-first"));
            assert_eq!(
                printings_pool(&pool, "forest").await.unwrap()[0].id,
                "next-basic"
            );
            assert_eq!(
                creature_types_pool(
                    &pool,
                    CardQuery {
                        set_code: "nxt".into(),
                        ..scope.clone()
                    },
                    "dr"
                )
                .await
                .unwrap(),
                vec!["Druid"]
            );
            assert!(creature_types_pool(&pool, scope.clone(), "wi")
                .await
                .unwrap()
                .is_empty());
            for scope in [
                scope.clone(),
                CardQuery {
                    available_only: true,
                    group_by_oracle: true,
                    ..Default::default()
                },
            ] {
                assert_eq!(
                    query_pool(
                        &pool,
                        CardQuery {
                            set_code: "future".into(),
                            ..scope
                        }
                    )
                    .await
                    .unwrap()
                    .total,
                    0
                );
            }
            // All Cards follows the same global expansion unlocks.
            assert_eq!(
                query_pool(
                    &pool,
                    CardQuery {
                        set_code: "future".into(),
                        ..Default::default()
                    }
                )
                .await
                .unwrap()
                .total,
                0
            );
            change_quantity(&pool, "set-b-first", 1).await.unwrap();
            let after = printings_pool(&pool, "elf").await.unwrap();
            assert_eq!(after.len(), 4);
            assert!(after.iter().all(|card| card.oracle_owned == 4));
            assert!(after
                .iter()
                .any(|card| card.id == "set-b-variant" && card.owned == 0));
            let page = query_pool(
                &pool,
                CardQuery {
                    set_code: "nxt".into(),
                    ..scope.clone()
                },
            )
            .await
            .unwrap();
            assert_eq!(page.total, 1);
            assert_eq!(page.cards[0].oracle_owned, 4);
            assert_eq!(
                creature_types_pool(
                    &pool,
                    CardQuery {
                        set_code: "nxt".into(),
                        ..scope.clone()
                    },
                    "dr"
                )
                .await
                .unwrap(),
                vec!["Druid"]
            );
            let facets = filter_options_pool(&pool, scope).await.unwrap();
            assert_eq!(facets.sets.len(), 2);
            assert_eq!(facets.rarities, vec!["common", "rare"]);
            let exhausted = query_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    group_by_oracle: true,
                    available_only: true,
                    allocated: HashMap::from([("elf".into(), 4)]),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(exhausted.total, 0);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT SUM(quantity) FROM collection")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                4
            );
            pool.close().await;
        });
    }

    #[test]
    fn multi_select_facets_and_creature_suggestions_use_the_eligible_owned_scope() {
        let (_directory, pool) = pool();
        let specs = [
            ("green", "Elf Scout", vec!["G"], 1, "Creature — Elf Scout"),
            (
                "blue",
                "Doctor",
                vec!["U"],
                7,
                "Legendary Creature — Time Lord Doctor",
            ),
            ("red", "Ember", vec!["R"], 6, "Instant"),
            (
                "multicolor",
                "Marauder",
                vec!["R", "G"],
                2,
                "Creature — Orc Warrior",
            ),
        ];
        let cards = specs
            .into_iter()
            .map(|(id, name, colors, cmc, kind)| {
                let mut card = fixture(id, name);
                card["colors"] = serde_json::json!(colors);
                card["cmc"] = cmc.into();
                card["type_line"] = kind.into();
                card
            })
            .collect();
        tauri::async_runtime::block_on(async {
            append_values(&pool, cards).await.unwrap();
            for id in ["green", "blue", "multicolor"] {
                change_quantity(&pool, id, 1).await.unwrap();
            }
            let scope = CardQuery {
                owned_only: true,
                group_by_oracle: true,
                ..Default::default()
            };
            let facets = filter_options_pool(
                &pool,
                CardQuery {
                    colors: vec!["G".into()],
                    mana_values: vec![1],
                    ..scope.clone()
                },
            )
            .await
            .unwrap();
            assert_eq!(facets.colors, vec!["U", "R", "G", "M"]);
            assert_eq!(facets.mana_values, vec![1, 2, 6]);
            assert_eq!(facets.card_types, vec!["Creature"]);
            assert_eq!(facets.sets.len(), 1);
            assert_eq!(facets.sets[0].count, 3);
            let selected = query_pool(
                &pool,
                CardQuery {
                    colors: vec!["U".into(), "G".into()],
                    mana_values: vec![1, 6],
                    ..scope.clone()
                },
            )
            .await
            .unwrap();
            assert_eq!(selected.total, 2);
            assert!(selected.cards.iter().any(|card| card.id == "blue"));
            assert!(selected.cards.iter().any(|card| card.id == "green"));
            let instant = query_pool(
                &pool,
                CardQuery {
                    card_types: vec!["Instant".into()],
                    ..scope.clone()
                },
            )
            .await
            .unwrap();
            assert_eq!(instant.total, 0);
            assert!(creature_types_pool(&pool, scope.clone(), "e")
                .await
                .unwrap()
                .is_empty());
            assert_eq!(
                creature_types_pool(&pool, scope.clone(), "el")
                    .await
                    .unwrap(),
                vec!["Elf"]
            );
            assert_eq!(
                creature_types_pool(&pool, scope.clone(), "time")
                    .await
                    .unwrap(),
                vec!["Time Lord"]
            );
            let doctor = query_pool(
                &pool,
                CardQuery {
                    creature_type: "Time Lord".into(),
                    ..scope
                },
            )
            .await
            .unwrap();
            assert_eq!(doctor.total, 1);
            assert_eq!(doctor.cards[0].id, "blue");
            let extra: Vec<_> = (0..40)
                .map(|index| {
                    let mut value = fixture(&format!("extra-{index}"), "Extra creature");
                    value["type_line"] = format!("Creature — Elf{index:02}").into();
                    value
                })
                .collect();
            append_values(&pool, extra).await.unwrap();
            for index in 0..40 {
                change_quantity(&pool, &format!("extra-{index}"), 1)
                    .await
                    .unwrap();
            }
            assert_eq!(
                creature_types_pool(
                    &pool,
                    CardQuery {
                        owned_only: true,
                        ..Default::default()
                    },
                    "el"
                )
                .await
                .unwrap()
                .len(),
                30
            );
            pool.close().await;
        });
    }

    #[test]
    fn ineligible_metadata_is_hidden_consistently_without_deleting_owned_rows() {
        let (_directory, pool) = pool();
        let mut cards = vec![fixture("normal", "Normal Elf")];
        for (id, key, value) in [
            ("silver", "border_color", serde_json::json!("silver")),
            ("gold", "border_color", serde_json::json!("gold")),
            ("acorn", "security_stamp", serde_json::json!("acorn")),
            ("heart", "security_stamp", serde_json::json!("heart")),
            ("funny", "set_type", serde_json::json!("funny")),
            ("token", "layout", serde_json::json!("token")),
            ("digital", "digital", serde_json::json!(true)),
            ("oversized", "oversized", serde_json::json!(true)),
            ("fraction", "cmc", serde_json::json!(0.5)),
            ("half-power", "power", serde_json::json!("½")),
            ("decimal-power", "power", serde_json::json!("1.5")),
            ("unset", "set", serde_json::json!("unf")),
        ] {
            let mut card = fixture(id, id);
            card[key] = value;
            cards.push(card);
        }
        tauri::async_runtime::block_on(async {
            append_values(&pool, cards.clone()).await.unwrap();
            for value in &cards {
                change_quantity(&pool, value["id"].as_str().unwrap(), 1)
                    .await
                    .unwrap();
            }
            let page = query_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(page.total, 1);
            assert_eq!(page.cards[0].id, "normal");
            assert_eq!(
                query_pool(&pool, CardQuery::default()).await.unwrap().total,
                1
            );
            let facets = filter_options_pool(
                &pool,
                CardQuery {
                    owned_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(facets.mana_values, vec![1]);
            for value in cards {
                let id = value["id"].as_str().unwrap();
                let card = get_card_pool(&pool, id).await.unwrap();
                assert_eq!(card.owned, 1);
                assert_eq!(crate::card_policy::eligible(&value, &card), id == "normal");
            }
            assert_eq!(status_pool(&pool).await.unwrap().count, 13);
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
    fn search_finds_names_and_card_abilities() {
        let (_directory, pool) = pool();
        let cards = [
            (
                "draw",
                "Deepwood Ranger",
                "When this creature enters, draw a card.",
            ),
            ("flying", "Sky Scout", "Flying"),
            ("destroy", "Final Verdict", "Destroy target creature."),
            ("life", "Dawn Healer", "You gain 3 life."),
            ("deathtouch", "Night Predator", "Deathtouch"),
            ("other", "Ordinary Creature", "Vigilance"),
        ]
        .map(|(id, name, rules)| {
            let mut card = fixture(id, name);
            card["oracle_text"] = rules.into();
            card
        });
        tauri::async_runtime::block_on(async {
            append_values(&pool, cards.into()).await.unwrap();
            for (search, expected) in [
                ("draw a card", "draw"),
                ("flying", "flying"),
                ("destroy target creature", "destroy"),
                ("gain life", "life"),
                ("deathtouch", "deathtouch"),
                ("  DAWN\tHEALER  ", "life"),
            ] {
                let result = query_pool(
                    &pool,
                    CardQuery {
                        search: search.into(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                assert_eq!(result.total, 1, "search: {search}");
                assert_eq!(result.cards[0].id, expected, "search: {search}");
            }
            pool.close().await;
        });
    }

    #[test]
    fn search_terms_share_filters_and_page_counts() {
        let (_directory, pool) = pool();
        let mut first = fixture("first", "A Healer");
        first["oracle_text"] = "You gain 3 life.".into();
        let mut second = fixture("second", "B Healer");
        second["oracle_text"] = "Whenever you gain life, put a counter on this creature.".into();
        let mut third = fixture("third", "Gain Guardian");
        third["oracle_text"] = "Your life total can't change.".into();
        third["colors"] = serde_json::json!(["W"]);
        let mut missing_term = fixture("missing-term", "D Healer");
        missing_term["oracle_text"] = "You gain 3 energy counters.".into();
        let mut double_faced = fixture("double-faced", "Front // Back");
        double_faced["oracle_text"] = "".into();
        double_faced["card_faces"] = serde_json::json!([
            {"name":"Front","oracle_text":"Vigilance"},
            {"name":"Back","oracle_text":"When this creature transforms, draw a card."}
        ]);
        tauri::async_runtime::block_on(async {
            append_values(
                &pool,
                vec![first, second, third, missing_term, double_faced],
            )
            .await
            .unwrap();
            let mut seen = Vec::new();
            for page in 0..4 {
                let result = query_pool(
                    &pool,
                    CardQuery {
                        search: "gain life".into(),
                        page,
                        page_size: 1,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                assert_eq!(result.total, 3);
                seen.extend(result.cards.into_iter().map(|card| card.id));
            }
            assert_eq!(seen, ["first", "second", "third"]);
            change_quantity(&pool, "first", 2).await.unwrap();
            let filtered = query_pool(
                &pool,
                CardQuery {
                    search: "gain life".into(),
                    owned_only: true,
                    min_owned: 2,
                    color: "G".into(),
                    rarity: "common".into(),
                    set_code: "tst".into(),
                    type_line: "Creature".into(),
                    mana_value: "1".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(filtered.total, 1);
            assert_eq!(filtered.cards[0].id, "first");
            let back_rules = query_pool(
                &pool,
                CardQuery {
                    search: "draw card".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(back_rules.total, 1);
            assert_eq!(back_rules.cards[0].id, "double-faced");
            pool.close().await;
        });
    }

    #[test]
    fn search_treats_like_metacharacters_and_quotes_literally() {
        let (_directory, pool) = pool();
        let cards = [
            ("percent", "Percent% Scout"),
            ("underscore", "Under_score Mage"),
            ("backslash", "Path\\finder"),
            ("quote", "Cleric's Gift"),
            ("ordinary", "Ordinary Scout"),
        ]
        .map(|(id, name)| fixture(id, name));
        tauri::async_runtime::block_on(async {
            append_values(&pool, cards.into()).await.unwrap();
            for (search, expected) in [
                ("%", "percent"),
                ("_", "underscore"),
                ("\\", "backslash"),
                ("Cleric's", "quote"),
            ] {
                let result = query_pool(
                    &pool,
                    CardQuery {
                        search: search.into(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                assert_eq!(result.total, 1, "search: {search}");
                assert_eq!(result.cards[0].id, expected, "search: {search}");
            }
            let injection = query_pool(
                &pool,
                CardQuery {
                    search: "' OR 1=1 --".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(injection.total, 0);
            pool.close().await;
        });
    }

    #[test]
    fn oracle_ownership_totals_all_printings_outside_browser_filters() {
        let (dir, pool) = pool();
        let source = dir.path().join("reprints.json");
        let mut first = fixture("first", "Shared card");
        first["oracle_id"] = "shared".into();
        let mut second = fixture("second", "Shared card");
        second["oracle_id"] = "shared".into();
        second["set"] = serde_json::json!("old");
        let mut unowned = fixture("unowned", "Shared card");
        unowned["oracle_id"] = "shared".into();
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
