use crate::catalog::{
    card_from_row, database_mutation_guard, is_unlimited_basic, open_pool, CatalogCard,
    ORACLE_OWNED_SQL,
};
#[cfg(test)]
use crate::league_rules::AutoUnlock;
use crate::league_rules::{BoosterConfig, ExpansionScheduleEntry, LeagueRules as LeagueConfig};
use chrono::{DateTime, SecondsFormat, Utc};
use rand::{rngs::OsRng, seq::SliceRandom, Rng};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::AppHandle;

const WEEK_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_BALANCE: i64 = 2_147_483_647;
const COLLECTION_COPY_LIMIT: i64 = 4;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WildcardBalances {
    pub common: i64,
    pub uncommon: i64,
    pub rare: i64,
    pub mythic: i64,
}

impl WildcardBalances {
    fn values(&self) -> [(&'static str, i64); 4] {
        [
            ("common", self.common),
            ("uncommon", self.uncommon),
            ("rare", self.rare),
            ("mythic", self.mythic),
        ]
    }
    fn add_rarity(&mut self, rarity: &str) {
        match rarity {
            "common" => self.common += 1,
            "uncommon" => self.uncommon += 1,
            "rare" => self.rare += 1,
            "mythic" => self.mythic += 1,
            _ => (),
        }
    }
    fn add(&mut self, other: &Self) {
        self.common += other.common;
        self.uncommon += other.uncommon;
        self.rare += other.rare;
        self.mythic += other.mythic;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoosterHistory {
    pub id: String,
    pub set_code: String,
    pub opened_at: String,
    pub cards: Vec<CatalogCard>,
    #[serde(default)]
    pub duplicate_wildcards: WildcardBalances,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeagueStatus {
    pub started: bool,
    pub available_packs: i64,
    pub wildcards: WildcardBalances,
    pub enabled_sets: Vec<String>,
    pub next_reward_at: Option<String>,
    pub can_claim_weekly: bool,
    pub week: i64,
    pub history: Vec<BoosterHistory>,
    pub started_at: i64,
    pub claimable_weeks: i64,
    pub claimable_packs: i64,
    pub claimable_wildcards: WildcardBalances,
    pub join_packs: i64,
    pub join_wildcards: WildcardBalances,
    pub general_packs: i64,
    pub set_packs: BTreeMap<String, i64>,
    pub claimable_set_packs: BTreeMap<String, i64>,
    pub join_set_packs: BTreeMap<String, i64>,
    pub next_expansion: Option<ExpansionScheduleEntry>,
    pub upcoming_expansions: Vec<ExpansionScheduleEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoosterOpening {
    pub id: String,
    pub packs: i64,
    pub set_code: String,
    pub cards: Vec<CatalogCard>,
    pub wildcards: WildcardBalances,
    #[serde(default)]
    pub duplicate_wildcards: WildcardBalances,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PackContents {
    cards: Vec<CatalogCard>,
    duplicate_wildcards: WildcardBalances,
}

fn history_contents(json: &str) -> PackContents {
    serde_json::from_str(json)
        .or_else(|_| {
            serde_json::from_str::<Vec<CatalogCard>>(json).map(|cards| PackContents {
                cards,
                ..PackContents::default()
            })
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CraftingResult {
    pub card: CatalogCard,
    pub wildcards: WildcardBalances,
}

#[derive(Debug, Clone, Copy)]
struct LeagueState {
    started_at: i64,
    available_packs: i64,
    last_claimed_period: i64,
}

fn timestamp(seconds: i64) -> Result<String, String> {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Secs, true))
        .ok_or_else(|| "The league clock is outside the supported range.".into())
}

fn period(started_at: i64, now: i64) -> i64 {
    now.saturating_sub(started_at).max(0) / WEEK_SECONDS
}

fn normalized_sets(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|code| code.trim().to_lowercase())
        .filter(|code| !code.is_empty() && seen.insert(code.clone()))
        .collect()
}

fn enabled_sets(config: &LeagueConfig, _state: Option<LeagueState>, now: i64) -> Vec<String> {
    let mut values = config.enabled_sets.clone();
    let current = period(config.started_at, now);
    values.extend(
        config
            .expansion_schedule
            .iter()
            .filter(|expansion| expansion.week <= current)
            .map(|expansion| expansion.code.clone()),
    );
    if config.auto_unlock.interval_weeks > 0 {
        let unlocked = period(config.started_at, now) / config.auto_unlock.interval_weeks;
        values.extend(
            config
                .auto_unlock
                .set_codes
                .iter()
                .take(unlocked as usize)
                .cloned(),
        );
    }
    normalized_sets(values)
}

fn validate_config(config: &LeagueConfig) -> Result<(), String> {
    if [
        config.wildcard_reward_intervals.common,
        config.wildcard_reward_intervals.uncommon,
        config.wildcard_reward_intervals.rare,
        config.wildcard_reward_intervals.mythic,
    ]
    .iter()
    .any(|weeks| !(1..=10_000).contains(weeks))
    {
        return Err("Wildcard reward intervals must be whole weeks between 1 and 10,000.".into());
    }
    let mut scheduled_codes = HashSet::new();
    if config.expansion_schedule.iter().any(|expansion| {
        expansion.week < 0
            || expansion.week > 10_000
            || !(0..=100_000).contains(&expansion.bonus_packs)
            || expansion.code.trim().is_empty()
            || !expansion
                .code
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
            || !scheduled_codes.insert(expansion.code.to_lowercase())
    }) {
        return Err("The built-in expansion reward schedule is invalid.".into());
    }
    if [config.starting_packs, config.weekly_packs]
        .iter()
        .any(|value| !(0..=100_000).contains(value))
        || config
            .weekly_wildcards
            .values()
            .iter()
            .any(|(_, value)| !(0..=100_000).contains(value))
    {
        return Err(
            "Pack and weekly wildcard rewards must be whole numbers between 0 and 100,000.".into(),
        );
    }
    if [config.mythic_probability, config.wildcard_drop_probability]
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err("Mythic and wildcard probabilities must be between 0% and 100%.".into());
    }
    timestamp(config.started_at)?;
    let slots = [
        config.booster.commons,
        config.booster.uncommons,
        config.booster.rare_slots,
        config.booster.basic_lands,
    ];
    if slots.iter().any(|value| !(0..=100).contains(value))
        || !(1..=100).contains(&slots.iter().sum::<i64>())
    {
        return Err("A simplified booster must contain between 1 and 100 cards, with non-negative slot counts.".into());
    }
    if config.auto_unlock.interval_weeks < 0 || config.auto_unlock.interval_weeks > 10_000 {
        return Err("The automatic set-unlock interval must be between 0 and 10,000 weeks.".into());
    }
    if config
        .enabled_sets
        .iter()
        .chain(config.auto_unlock.set_codes.iter())
        .any(|code| {
            code.trim().is_empty() || !code.trim().chars().all(|c| c.is_ascii_alphanumeric())
        })
    {
        return Err("Expansion codes must contain only letters and numbers.".into());
    }
    Ok(())
}

async fn config(_connection: &mut SqliteConnection) -> Result<LeagueConfig, String> {
    // Only unit fixtures can opt into mutable rules. Release builds always use
    // the rules embedded in the application, regardless of database settings.
    #[cfg(test)]
    {
        let test_override: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM settings WHERE key='test.allow-league-settings' AND value='true'",
        )
        .fetch_one(&mut *_connection)
        .await
        .map_err(|e| e.to_string())?;
        if test_override != 0 {
            let json: Option<String> =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='app'")
                    .fetch_optional(&mut *_connection)
                    .await
                    .map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_str(json.as_deref().unwrap_or("{}"))
                .map_err(|e| format!("Cannot read test league rules: {e}"))?;
            let rules: LeagueConfig = serde_json::from_value(
                value
                    .get("league")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            )
            .map_err(|e| format!("Cannot read test league configuration: {e}"))?;
            validate_config(&rules)?;
            return Ok(rules);
        }
    }
    let rules = crate::league_rules::builtin_rules()?;
    validate_config(&rules)?;
    Ok(rules)
}

async fn state(
    connection: &mut SqliteConnection,
    config: &LeagueConfig,
) -> Result<Option<LeagueState>, String> {
    let row = sqlx::query(
        "SELECT started_at,available_packs,last_claimed_period FROM league_state WHERE id=1",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    let Some(row) = row else { return Ok(None) };
    let mut state = LeagueState {
        started_at: row.get("started_at"),
        available_packs: row.get("available_packs"),
        last_claimed_period: row.get::<i64, _>("last_claimed_period").max(0),
    };
    if state.started_at != config.started_at {
        // The old per-player clock did not record each individual weekly grant.
        // Preserve credited periods and all balances while adopting the shared
        // anchor. Crediting prior grants avoids handing out the same week twice.
        sqlx::query("UPDATE league_state SET started_at=?,last_claimed_period=? WHERE id=1")
            .bind(config.started_at)
            .bind(state.last_claimed_period)
            .execute(&mut *connection)
            .await
            .map_err(|e| e.to_string())?;
        state.started_at = config.started_at;
    }
    Ok(Some(state))
}

fn accumulated_rewards(
    config: &LeagueConfig,
    weeks: i64,
) -> Result<(i64, WildcardBalances), String> {
    rewards_between(config, 0, weeks)
}

fn rewards_between(
    config: &LeagueConfig,
    claimed_period: i64,
    current_period: i64,
) -> Result<(i64, WildcardBalances), String> {
    let claimed = claimed_period.max(0);
    let current = current_period.max(0);
    let multiply = |amount: i64, grants: i64| {
        amount
            .checked_mul(grants.max(0))
            .filter(|value| *value <= MAX_BALANCE)
            .ok_or_else(|| "Accumulated weekly rewards exceed the supported balance.".to_string())
    };
    let wildcard = |amount: i64, interval: i64| {
        if interval < 1 {
            return Err("Wildcard reward intervals must be positive whole weeks.".to_string());
        }
        // Count calendar boundaries crossed, not the rounded length of the
        // missed interval. Claiming week 1 then week 2 must grant the first rare.
        let grants = (current / interval)
            .saturating_sub(claimed / interval)
            .max(0);
        multiply(amount, grants)
    };
    Ok((
        multiply(config.weekly_packs, current.saturating_sub(claimed).max(0))?,
        WildcardBalances {
            common: wildcard(
                config.weekly_wildcards.common,
                config.wildcard_reward_intervals.common,
            )?,
            uncommon: wildcard(
                config.weekly_wildcards.uncommon,
                config.wildcard_reward_intervals.uncommon,
            )?,
            rare: wildcard(
                config.weekly_wildcards.rare,
                config.wildcard_reward_intervals.rare,
            )?,
            mythic: wildcard(
                config.weekly_wildcards.mythic,
                config.wildcard_reward_intervals.mythic,
            )?,
        },
    ))
}

async fn set_pack_balances(
    connection: &mut SqliteConnection,
) -> Result<BTreeMap<String, i64>, String> {
    let rows = sqlx::query(
        "SELECT set_code,quantity FROM set_booster_balances WHERE quantity>0 ORDER BY set_code",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("set_code").to_lowercase(),
                row.get("quantity"),
            )
        })
        .collect())
}

fn total_set_packs(values: &BTreeMap<String, i64>) -> Result<i64, String> {
    values
        .values()
        .try_fold(0_i64, |sum, quantity| sum.checked_add(*quantity))
        .ok_or_else(|| "The set-specific pack balance exceeds the supported range.".into())
}

async fn unclaimed_expansion_rewards(
    connection: &mut SqliteConnection,
    config: &LeagueConfig,
    now: i64,
) -> Result<BTreeMap<String, i64>, String> {
    let claimed: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT set_code FROM expansion_reward_claims")
            .fetch_all(&mut *connection)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|code| code.to_lowercase())
            .collect();
    let current = period(config.started_at, now);
    Ok(config
        .expansion_schedule
        .iter()
        .filter(|expansion| {
            expansion.week <= current
                && expansion.bonus_packs > 0
                && !claimed.contains(&expansion.code.to_lowercase())
        })
        .map(|expansion| (expansion.code.to_lowercase(), expansion.bonus_packs))
        .collect())
}

async fn grant_expansion_rewards(
    connection: &mut SqliteConnection,
    config: &LeagueConfig,
    now: i64,
) -> Result<(), String> {
    let rewards = unclaimed_expansion_rewards(connection, config, now).await?;
    for expansion in &config.expansion_schedule {
        let code = expansion.code.to_lowercase();
        let Some(amount) = rewards.get(&code).copied() else {
            continue;
        };
        let claimed = sqlx::query("INSERT INTO expansion_reward_claims(set_code,week,quantity,claimed_at) VALUES(?,?,?,?) ON CONFLICT(set_code) DO NOTHING")
            .bind(&code).bind(expansion.week).bind(amount).bind(timestamp(now)?)
            .execute(&mut *connection).await.map_err(|error| error.to_string())?.rows_affected();
        if claimed == 0 {
            continue;
        }
        let updated: Option<i64> = sqlx::query_scalar("INSERT INTO set_booster_balances(set_code,quantity) VALUES(?,?) ON CONFLICT(set_code) DO UPDATE SET quantity=quantity+excluded.quantity WHERE quantity<=? RETURNING quantity")
            .bind(&code).bind(amount).bind(MAX_BALANCE - amount)
            .fetch_optional(&mut *connection).await.map_err(|error| error.to_string())?;
        if updated.is_none() {
            return Err(format!(
                "The {} bonus-pack balance is full.",
                code.to_uppercase()
            ));
        }
    }
    Ok(())
}

async fn balances(connection: &mut SqliteConnection) -> Result<WildcardBalances, String> {
    let rows = sqlx::query("SELECT rarity,quantity FROM wildcards")
        .fetch_all(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
    let mut balances = WildcardBalances::default();
    for row in rows {
        let quantity: i64 = row.get("quantity");
        match row.get::<&str, _>("rarity") {
            "common" => balances.common = quantity,
            "uncommon" => balances.uncommon = quantity,
            "rare" => balances.rare = quantity,
            "mythic" => balances.mythic = quantity,
            _ => (),
        }
    }
    Ok(balances)
}

async fn add_wildcards(
    connection: &mut SqliteConnection,
    rewards: &WildcardBalances,
) -> Result<(), String> {
    for (rarity, amount) in rewards.values() {
        if amount == 0 {
            continue;
        }
        let changed =
            sqlx::query("UPDATE wildcards SET quantity=quantity+? WHERE rarity=? AND quantity<=?")
                .bind(amount)
                .bind(rarity)
                .bind(MAX_BALANCE - amount)
                .execute(&mut *connection)
                .await
                .map_err(|e| e.to_string())?
                .rows_affected();
        if changed != 1 {
            return Err(format!(
                "The {rarity} wildcard balance cannot accept this reward."
            ));
        }
    }
    Ok(())
}

async fn status_connection(
    connection: &mut SqliteConnection,
    now: i64,
) -> Result<LeagueStatus, String> {
    let config = config(connection).await?;
    let state = state(connection, &config).await?;
    let rows = sqlx::query("SELECT id,set_code,opened_at,contents_json FROM booster_history ORDER BY opened_at DESC,rowid DESC LIMIT 20").fetch_all(&mut *connection).await.map_err(|e| e.to_string())?;
    let history = rows
        .into_iter()
        .map(|row| {
            let contents = history_contents(row.get("contents_json"));
            BoosterHistory {
                id: row.get("id"),
                set_code: row.get("set_code"),
                opened_at: row.get("opened_at"),
                cards: contents.cards,
                duplicate_wildcards: contents.duplicate_wildcards,
            }
        })
        .collect();
    let current = period(config.started_at, now);
    let general_packs = state.map(|state| state.available_packs).unwrap_or(0);
    let set_packs = set_pack_balances(connection).await?;
    let available_packs = general_packs
        .checked_add(total_set_packs(&set_packs)?)
        .ok_or("The pack balance exceeds the supported range.")?;
    let unclaimed_bonuses = unclaimed_expansion_rewards(connection, &config, now).await?;
    let claimable_set_packs = if state.is_some() {
        unclaimed_bonuses.clone()
    } else {
        BTreeMap::new()
    };
    let join_set_packs = unclaimed_bonuses;
    let claimable_weeks = state
        .map(|state| current.saturating_sub(state.last_claimed_period).max(0))
        .unwrap_or(0);
    let (claimable_base_packs, claimable_wildcards) = rewards_between(
        &config,
        state
            .map(|state| state.last_claimed_period)
            .unwrap_or(current),
        current,
    )?;
    let claimable_packs = claimable_base_packs
        .checked_add(total_set_packs(&claimable_set_packs)?)
        .ok_or("The claimable pack balance exceeds the supported range.")?;
    let (join_weekly_packs, join_wildcards) = accumulated_rewards(&config, current)?;
    let join_packs = config
        .starting_packs
        .checked_add(join_weekly_packs)
        .filter(|packs| *packs <= MAX_BALANCE)
        .and_then(|packs| packs.checked_add(total_set_packs(&join_set_packs).ok()?))
        .ok_or("The catch-up pack balance exceeds the supported range.")?;
    let can_claim_weekly =
        state.is_some() && (claimable_weeks > 0 || !claimable_set_packs.is_empty());
    let mut upcoming_expansions: Vec<_> = config
        .expansion_schedule
        .iter()
        .filter(|expansion| expansion.week > current)
        .cloned()
        .collect();
    upcoming_expansions.sort_by_key(|expansion| expansion.week);
    let next_expansion = upcoming_expansions.first().cloned();
    let next_period = if can_claim_weekly {
        current
    } else {
        let base = current.max(state.map(|state| state.last_claimed_period).unwrap_or(0)) + 1;
        upcoming_expansions
            .iter()
            .filter(|expansion| expansion.bonus_packs > 0)
            .map(|expansion| expansion.week)
            .min()
            .map(|week| week.min(base))
            .unwrap_or(base)
    };
    let next_reward_at = config
        .started_at
        .checked_add(
            next_period
                .checked_mul(WEEK_SECONDS)
                .ok_or("The next reward time is outside the supported range.")?,
        )
        .map(timestamp)
        .transpose()?;
    Ok(LeagueStatus {
        started: state.is_some(),
        available_packs,
        wildcards: balances(connection).await?,
        enabled_sets: enabled_sets(&config, state, now),
        next_reward_at,
        can_claim_weekly,
        week: current + 1,
        history,
        started_at: config.started_at,
        claimable_weeks,
        claimable_packs,
        claimable_wildcards,
        join_packs,
        join_wildcards,
        general_packs,
        set_packs,
        claimable_set_packs,
        join_set_packs,
        next_expansion,
        upcoming_expansions,
    })
}

pub async fn status_pool(pool: &SqlitePool, now: i64) -> Result<LeagueStatus, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let status = status_connection(&mut transaction, now).await?;
    transaction.commit().await.map_err(|e| e.to_string())?;
    Ok(status)
}

pub async fn begin_pool(pool: &SqlitePool, now: i64) -> Result<LeagueStatus, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let config = config(&mut transaction).await?;
    if state(&mut transaction, &config).await?.is_none() {
        if now < config.started_at {
            return Err(format!(
                "This league begins on {}.",
                timestamp(config.started_at)?
            ));
        }
        let elapsed = period(config.started_at, now);
        let (weekly_packs, wildcards) = accumulated_rewards(&config, elapsed)?;
        let packs = config
            .starting_packs
            .checked_add(weekly_packs)
            .filter(|packs| *packs <= MAX_BALANCE)
            .ok_or("The catch-up pack balance exceeds the supported range.")?;
        sqlx::query("INSERT INTO league_state(id,started_at,available_packs,last_claimed_period) VALUES(1,?,?,?)")
            .bind(config.started_at).bind(packs).bind(elapsed)
            .execute(&mut *transaction).await.map_err(|e| e.to_string())?;
        add_wildcards(&mut transaction, &wildcards).await?;
        grant_expansion_rewards(&mut transaction, &config, now).await?;
    }
    let status = status_connection(&mut transaction, now).await?;
    transaction.commit().await.map_err(|e| e.to_string())?;
    Ok(status)
}

pub async fn claim_pool(pool: &SqlitePool, now: i64) -> Result<LeagueStatus, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let config = config(&mut transaction).await?;
    let state = state(&mut transaction, &config)
        .await?
        .ok_or("Begin your league before claiming weekly rewards.")?;
    let current = period(config.started_at, now);
    let bonuses = unclaimed_expansion_rewards(&mut transaction, &config, now).await?;
    if current < 1 && bonuses.is_empty() {
        return Err(
            "The first weekly reward becomes available seven days after the league begins.".into(),
        );
    }
    if current <= state.last_claimed_period && bonuses.is_empty() {
        return Err("All available weekly and expansion rewards have already been claimed.".into());
    }
    let (packs, wildcards) = rewards_between(&config, state.last_claimed_period, current)?;
    let credited_period = current.max(state.last_claimed_period);
    let changed = sqlx::query("UPDATE league_state SET available_packs=available_packs+?,last_claimed_period=? WHERE id=1 AND last_claimed_period=? AND available_packs<=?")
        .bind(packs).bind(credited_period).bind(state.last_claimed_period).bind(MAX_BALANCE - packs)
        .execute(&mut *transaction).await.map_err(|e| e.to_string())?.rows_affected();
    if changed != 1 {
        return Err("The weekly rewards could not be claimed because the pack balance is full or they were already claimed.".into());
    }
    add_wildcards(&mut transaction, &wildcards).await?;
    grant_expansion_rewards(&mut transaction, &config, now).await?;
    let status = status_connection(&mut transaction, now).await?;
    transaction.commit().await.map_err(|e| e.to_string())?;
    Ok(status)
}

fn valid_request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
    {
        return Err("Use a unique operation identifier containing letters, numbers, hyphens, colons, or underscores.".into());
    }
    Ok(())
}

async fn receipt<T: DeserializeOwned>(
    connection: &mut SqliteConnection,
    id: &str,
    kind: &str,
    request_json: &str,
) -> Result<Option<T>, String> {
    valid_request_id(id)?;
    let row =
        sqlx::query("SELECT kind,request_json,result_json FROM progression_operations WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|e| e.to_string())?;
    if let Some(row) = row {
        if row.get::<&str, _>("kind") != kind || row.get::<&str, _>("request_json") != request_json
        {
            return Err("This operation identifier was already used for a different request. Start a new action instead of changing a retry.".into());
        }
        return serde_json::from_str(row.get("result_json"))
            .map(Some)
            .map_err(|e| format!("Cannot read the saved operation receipt: {e}"));
    }
    Ok(None)
}

async fn save_receipt<T: Serialize>(
    connection: &mut SqliteConnection,
    id: &str,
    kind: &str,
    request_json: &str,
    result: &T,
    now: i64,
) -> Result<(), String> {
    sqlx::query("INSERT INTO progression_operations(id,kind,request_json,result_json,created_at) VALUES(?,?,?,?,?)")
        .bind(id).bind(kind).bind(request_json).bind(serde_json::to_string(result).map_err(|e| e.to_string())?).bind(timestamp(now)?)
        .execute(&mut *connection).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn craftable(metadata: &Value, card: &CatalogCard) -> bool {
    matches!(
        card.rarity.as_str(),
        "common" | "uncommon" | "rare" | "mythic"
    ) && !metadata
        .get("digital")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && !metadata
            .get("oversized")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && !metadata
            .get("games")
            .and_then(Value::as_array)
            .is_some_and(|games| !games.iter().any(|game| game.as_str() == Some("paper")))
        && !matches!(
            metadata.get("layout").and_then(Value::as_str),
            Some("token" | "double_faced_token" | "emblem" | "art_series")
        )
        && !card.type_line.to_lowercase().contains("token")
        && !card.type_line.to_lowercase().contains("emblem")
}

#[derive(Default)]
struct BoosterPools {
    common: Vec<CatalogCard>,
    uncommon: Vec<CatalogCard>,
    rare: Vec<CatalogCard>,
    mythic: Vec<CatalogCard>,
    basic: Vec<CatalogCard>,
}

async fn booster_pools(
    connection: &mut SqliteConnection,
    set_code: &str,
) -> Result<BoosterPools, String> {
    let rows = sqlx::query(&format!("SELECT c.*,COALESCE(o.quantity,0) AS owned,{ORACLE_OWNED_SQL} AS oracle_owned FROM cards c LEFT JOIN collection o ON o.card_id=c.id WHERE c.set_code=? ORDER BY c.id"))
        .bind(set_code).fetch_all(&mut *connection).await.map_err(|e| e.to_string())?;
    let mut pools = BoosterPools::default();
    for row in rows {
        let card = card_from_row(&row)?;
        let metadata: Value = serde_json::from_str(row.get("metadata_json"))
            .map_err(|e| format!("Invalid card metadata for {}: {e}", card.name))?;
        if !craftable(&metadata, &card)
            || metadata
                .get("promo")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            || !metadata
                .get("booster")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        {
            continue;
        }
        if is_unlimited_basic(&card) {
            pools.basic.push(card);
            continue;
        }
        match card.rarity.as_str() {
            "common" => pools.common.push(card),
            "uncommon" => pools.uncommon.push(card),
            "rare" => pools.rare.push(card),
            "mythic" => pools.mythic.push(card),
            _ => (),
        }
    }
    Ok(pools)
}

fn validate_pools(
    pools: &BoosterPools,
    slots: &BoosterConfig,
    set_code: &str,
) -> Result<(), String> {
    for (count, size, label) in [
        (slots.commons, pools.common.len(), "common cards"),
        (slots.uncommons, pools.uncommon.len(), "uncommon cards"),
        (slots.rare_slots, pools.rare.len(), "rare cards"),
        (slots.basic_lands, pools.basic.len(), "basic lands"),
    ] {
        if count > 0 && size == 0 {
            return Err(format!("{} has no eligible {label} in the local catalog. Wait for automatic card-catalog setup to finish and check the Forge installation.", set_code.to_uppercase()));
        }
    }
    Ok(())
}

async fn owned_totals(connection: &mut SqliteConnection) -> Result<HashMap<String, i64>, String> {
    let rows = sqlx::query("SELECT c.oracle_id, SUM(o.quantity) AS owned FROM collection o JOIN cards c ON c.id=o.card_id GROUP BY c.oracle_id")
        .fetch_all(&mut *connection).await.map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("oracle_id"), row.get("owned")))
        .collect())
}

fn draw_protected_card<R: Rng + ?Sized>(
    pool: &[CatalogCard],
    rarity: &str,
    owned: &mut HashMap<String, i64>,
    pack: &mut PackContents,
    rng: &mut R,
) {
    // Select a card identity uniformly, then a printing, so artwork variants
    // neither bypass the collection cap nor skew duplicate protection.
    let mut seen = HashSet::new();
    let available: Vec<_> = pool
        .iter()
        .filter(|card| {
            owned.get(&card.oracle_id).copied().unwrap_or(0) < COLLECTION_COPY_LIMIT
                && seen.insert(card.oracle_id.as_str())
        })
        .map(|card| card.oracle_id.as_str())
        .collect();
    let Some(oracle_id) = available.choose(rng) else {
        pack.duplicate_wildcards.add_rarity(rarity);
        return;
    };
    let printings: Vec<_> = pool
        .iter()
        .filter(|card| card.oracle_id.as_str() == *oracle_id)
        .collect();
    let card = (*printings.choose(rng).unwrap()).clone();
    *owned.entry(card.oracle_id.clone()).or_default() += 1;
    pack.cards.push(card);
}

fn generate_pack<R: Rng + ?Sized>(
    pools: &BoosterPools,
    config: &LeagueConfig,
    owned: &mut HashMap<String, i64>,
    rng: &mut R,
) -> PackContents {
    let mut pack = PackContents::default();
    for _ in 0..config.booster.commons {
        draw_protected_card(&pools.common, "common", owned, &mut pack, rng);
    }
    for _ in 0..config.booster.uncommons {
        draw_protected_card(&pools.uncommon, "uncommon", owned, &mut pack, rng);
    }
    for _ in 0..config.booster.rare_slots {
        if !pools.mythic.is_empty() && rng.gen_bool(config.mythic_probability) {
            draw_protected_card(&pools.mythic, "mythic", owned, &mut pack, rng);
        } else {
            draw_protected_card(&pools.rare, "rare", owned, &mut pack, rng);
        }
    }
    for _ in 0..config.booster.basic_lands {
        if let Some(card) = pools.basic.choose(rng) {
            // Custom land slots may display artwork, but basics are freely
            // available for decks and never add collected quantities.
            pack.cards.push(card.clone());
        }
    }
    pack
}

async fn add_cards(
    connection: &mut SqliteConnection,
    cards: &mut [CatalogCard],
) -> Result<(), String> {
    let mut quantities = HashMap::<String, i64>::new();
    let mut oracle_quantities = HashMap::<String, i64>::new();
    for card in cards.iter() {
        if is_unlimited_basic(card) {
            continue;
        }
        *quantities.entry(card.id.clone()).or_default() += 1;
        *oracle_quantities.entry(card.oracle_id.clone()).or_default() += 1;
    }
    let mut totals = owned_totals(connection).await?;
    for (oracle_id, incoming) in oracle_quantities {
        let total = totals.entry(oracle_id).or_default();
        if *total + incoming > COLLECTION_COPY_LIMIT {
            return Err("You already own four copies of this card across all printings.".into());
        }
        *total += incoming;
    }
    let mut owned = HashMap::new();
    for (id, quantity) in quantities {
        let updated: Option<i64> = sqlx::query_scalar("INSERT INTO collection(card_id,quantity) VALUES(?,?) ON CONFLICT(card_id) DO UPDATE SET quantity=quantity+excluded.quantity WHERE quantity<=? RETURNING quantity")
            .bind(&id).bind(quantity).bind(MAX_BALANCE - quantity).fetch_optional(&mut *connection).await.map_err(|e| e.to_string())?;
        owned.insert(
            id,
            updated.ok_or("An ownership count is too large to accept these cards.")?,
        );
    }
    for card in cards {
        if !is_unlimited_basic(card) {
            card.owned = owned[&card.id];
            card.oracle_owned = totals[&card.oracle_id];
        }
    }
    Ok(())
}

pub async fn open_pool_boosters(
    pool: &SqlitePool,
    set_code: &str,
    count: i64,
    request_id: &str,
    now: i64,
) -> Result<BoosterOpening, String> {
    valid_request_id(request_id)?;
    if !(1..=100).contains(&count) {
        return Err("Open between 1 and 100 booster packs at a time.".into());
    }
    let set_code = set_code.trim().to_lowercase();
    let request = serde_json::json!({ "setCode": set_code, "count": count }).to_string();
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    if let Some(result) = receipt(&mut transaction, request_id, "open", &request).await? {
        transaction.commit().await.map_err(|e| e.to_string())?;
        return Ok(result);
    }
    let config = config(&mut transaction).await?;
    let state = state(&mut transaction, &config)
        .await?
        .ok_or("Begin your league before opening booster packs.")?;
    if !enabled_sets(&config, Some(state), now).contains(&set_code) {
        return Err("This set is locked until its shared league unlock date.".into());
    }
    let reserved: i64 =
        sqlx::query_scalar("SELECT quantity FROM set_booster_balances WHERE set_code=?")
            .bind(&set_code)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or(0);
    let use_reserved = reserved.min(count);
    let use_general = count - use_reserved;
    if state.available_packs < use_general {
        return Err(format!(
            "You have {} packs available for {}: {} general packs and {} set-specific bonus packs.",
            state.available_packs + reserved,
            set_code.to_uppercase(),
            state.available_packs,
            reserved
        ));
    }
    if use_reserved > 0 {
        let changed = sqlx::query(
            "UPDATE set_booster_balances SET quantity=quantity-? WHERE set_code=? AND quantity>=?",
        )
        .bind(use_reserved)
        .bind(&set_code)
        .bind(use_reserved)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?
        .rows_affected();
        if changed != 1 {
            return Err("The set-specific pack balance changed. Try opening again.".into());
        }
    }
    if use_general > 0 {
        let changed = sqlx::query("UPDATE league_state SET available_packs=available_packs-? WHERE id=1 AND available_packs>=?")
            .bind(use_general).bind(use_general).execute(&mut *transaction).await.map_err(|error| error.to_string())?.rows_affected();
        if changed != 1 {
            return Err("The general pack balance changed. Try opening again.".into());
        }
    }
    let pools = booster_pools(&mut transaction, &set_code).await?;
    validate_pools(&pools, &config.booster, &set_code)?;
    let mut rng = OsRng;
    let mut cards = Vec::new();
    let mut rewards = WildcardBalances::default();
    let mut duplicate_wildcards = WildcardBalances::default();
    let mut owned = owned_totals(&mut transaction).await?;
    let mut pack_outcomes = Vec::new();
    for _ in 0..count {
        let pack = generate_pack(&pools, &config, &mut owned, &mut rng);
        rewards.add(&pack.duplicate_wildcards);
        duplicate_wildcards.add(&pack.duplicate_wildcards);
        pack_outcomes.push((pack.cards.len(), pack.duplicate_wildcards));
        cards.extend(pack.cards);
        if rng.gen_bool(config.wildcard_drop_probability) {
            rewards.add_rarity(
                ["common", "uncommon", "rare", "mythic"]
                    .choose(&mut rng)
                    .copied()
                    .unwrap(),
            );
        }
    }
    add_cards(&mut transaction, &mut cards).await?;
    add_wildcards(&mut transaction, &rewards).await?;
    let mut offset = 0;
    for (index, (size, duplicate_wildcards)) in pack_outcomes.into_iter().enumerate() {
        let contents = PackContents {
            cards: cards[offset..offset + size].to_vec(),
            duplicate_wildcards,
        };
        offset += size;
        sqlx::query(
            "INSERT INTO booster_history(id,set_code,opened_at,contents_json) VALUES(?,?,?,?)",
        )
        .bind(format!("{request_id}:{index}"))
        .bind(&set_code)
        .bind(timestamp(now)?)
        .bind(serde_json::to_string(&contents).map_err(|e| e.to_string())?)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    let result = BoosterOpening {
        id: request_id.into(),
        packs: count,
        set_code,
        cards,
        wildcards: balances(&mut transaction).await?,
        duplicate_wildcards,
    };
    save_receipt(&mut transaction, request_id, "open", &request, &result, now).await?;
    transaction
        .commit()
        .await
        .map_err(|e| format!("The booster opening was not saved: {e}"))?;
    Ok(result)
}

pub async fn craft_pool(
    pool: &SqlitePool,
    card_id: &str,
    request_id: &str,
    now: i64,
) -> Result<CraftingResult, String> {
    valid_request_id(request_id)?;
    let request = serde_json::json!({ "cardId": card_id }).to_string();
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    if let Some(result) = receipt(&mut transaction, request_id, "craft", &request).await? {
        transaction.commit().await.map_err(|e| e.to_string())?;
        return Ok(result);
    }
    let config = config(&mut transaction).await?;
    let state = state(&mut transaction, &config)
        .await?
        .ok_or("Begin your league before crafting cards.")?;
    let row = sqlx::query(&format!("SELECT c.*,COALESCE(o.quantity,0) AS owned,{ORACLE_OWNED_SQL} AS oracle_owned FROM cards c LEFT JOIN collection o ON o.card_id=c.id WHERE c.id=?"))
        .bind(card_id).fetch_optional(&mut *transaction).await.map_err(|e| e.to_string())?.ok_or("This printing is missing from the card catalog.")?;
    let card = card_from_row(&row)?;
    if is_unlimited_basic(&card) {
        return Err(
            "Basic lands are freely available in the deck builder; no wildcard is needed.".into(),
        );
    }
    let metadata: Value =
        serde_json::from_str(row.get("metadata_json")).map_err(|e| e.to_string())?;
    if !craftable(&metadata, &card) {
        return Err(
            "This card is not an eligible paper Magic printing with a craftable rarity.".into(),
        );
    }
    if !enabled_sets(&config, Some(state), now).contains(&card.set_code.to_lowercase()) {
        return Err("This printing's set is locked until its shared league unlock date.".into());
    }
    if card.oracle_owned >= COLLECTION_COPY_LIMIT {
        return Err("You already own four copies of this card across all printings.".into());
    }
    let changed =
        sqlx::query("UPDATE wildcards SET quantity=quantity-1 WHERE rarity=? AND quantity>=1")
            .bind(&card.rarity)
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?
            .rows_affected();
    if changed != 1 {
        return Err(format!(
            "You need one {} wildcard to craft this printing.",
            card.rarity
        ));
    }
    let mut cards = vec![card];
    add_cards(&mut transaction, &mut cards).await?;
    let result = CraftingResult {
        card: cards.remove(0),
        wildcards: balances(&mut transaction).await?,
    };
    save_receipt(
        &mut transaction,
        request_id,
        "craft",
        &request,
        &result,
        now,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|e| format!("The crafted card was not saved: {e}"))?;
    Ok(result)
}

#[tauri::command]
pub async fn league_status(app: AppHandle) -> Result<LeagueStatus, String> {
    let _operation = database_mutation_guard()?;
    status_pool(&open_pool(&app).await?, Utc::now().timestamp()).await
}
#[tauri::command]
pub async fn begin_league(app: AppHandle) -> Result<LeagueStatus, String> {
    let _operation = database_mutation_guard()?;
    begin_pool(&open_pool(&app).await?, Utc::now().timestamp()).await
}
#[tauri::command]
pub async fn claim_weekly_reward(app: AppHandle) -> Result<LeagueStatus, String> {
    let _operation = database_mutation_guard()?;
    claim_pool(&open_pool(&app).await?, Utc::now().timestamp()).await
}
#[tauri::command]
pub async fn open_boosters(
    app: AppHandle,
    set_code: String,
    count: i64,
    request_id: String,
) -> Result<BoosterOpening, String> {
    let _operation = database_mutation_guard()?;
    open_pool_boosters(
        &open_pool(&app).await?,
        &set_code,
        count,
        &request_id,
        Utc::now().timestamp(),
    )
    .await
}
#[tauri::command]
pub async fn craft_card(
    app: AppHandle,
    card_id: String,
    request_id: String,
) -> Result<CraftingResult, String> {
    let _operation = database_mutation_guard()?;
    craft_pool(
        &open_pool(&app).await?,
        &card_id,
        &request_id,
        Utc::now().timestamp(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::StdRng, SeedableRng};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::time::Duration;

    const NOW: i64 = 1_700_000_000;

    struct TestDatabase {
        pool: SqlitePool,
        _directory: tempfile::TempDir,
    }

    async fn fixture() -> TestDatabase {
        let directory = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(directory.path().join("league.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
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
        sqlx::raw_sql(include_str!("../migrations/003_progression.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../migrations/005_expansion_rewards.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let settings = serde_json::json!({ "league": { "startedAt": NOW, "startingPacks": 2, "weeklyPacks": 4, "weeklyWildcards": { "common": 0, "uncommon": 0, "rare": 2, "mythic": 0 }, "enabledSets": ["tst"], "mythicProbability": 0.125 } });
        sqlx::query("INSERT INTO settings(key,value) VALUES('app',?)")
            .bind(settings.to_string())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('test.allow-league-settings','true')")
            .execute(&pool)
            .await
            .unwrap();
        for (id, rarity, kind) in [
            ("c", "common", "Creature"),
            ("c2", "common", "Creature"),
            ("c3", "common", "Creature"),
            ("u", "uncommon", "Creature"),
            ("r", "rare", "Creature"),
            ("m", "mythic", "Creature"),
            ("l", "common", "Basic Land — Forest"),
        ] {
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,type_line) VALUES(?,?,?,'tst',?,?,?,?)")
                .bind(id).bind(id).bind(id).bind(id).bind(rarity).bind(r#"{"games":["paper"],"booster":true}"#).bind(kind).execute(&pool).await.unwrap();
        }
        TestDatabase {
            pool,
            _directory: directory,
        }
    }

    async fn scheduled_fixture() -> TestDatabase {
        let db = fixture().await;
        let mut rules = crate::league_rules::builtin_rules().unwrap();
        rules.started_at = NOW;
        sqlx::query("UPDATE settings SET value=? WHERE key='app'")
            .bind(serde_json::json!({ "league": rules }).to_string())
            .execute(&db.pool)
            .await
            .unwrap();
        for code in ["fdn", "blb"] {
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,type_line) SELECT ? || '-' || id,? || '-' || oracle_id,name,?,collector_number,rarity,metadata_json,type_line FROM cards WHERE set_code='tst'")
                .bind(code).bind(code).bind(code).execute(&db.pool).await.unwrap();
        }
        db
    }

    #[test]
    fn simplified_packs_have_exact_slots_and_mythic_fallback() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let mut connection = db.pool.acquire().await.unwrap();
            let mut pools = booster_pools(&mut connection, "tst").await.unwrap();
            let mut config = config(&mut connection).await.unwrap();
            config.mythic_probability = 1.0;
            let mut rng = StdRng::seed_from_u64(7);
            let mut owned = HashMap::new();
            let pack = generate_pack(&pools, &config, &mut owned, &mut rng);
            assert_eq!(pack.cards.len(), 14);
            assert_eq!(
                pack.cards
                    .iter()
                    .filter(|card| card.rarity == "common")
                    .count(),
                10
            );
            assert_eq!(pack.cards.iter().filter(|card| card.id == "u").count(), 3);
            assert_eq!(pack.cards.iter().filter(|card| card.id == "m").count(), 1);
            assert_eq!(pack.cards.iter().filter(|card| card.id == "l").count(), 0);
            assert!(owned
                .values()
                .all(|quantity| *quantity <= COLLECTION_COPY_LIMIT));
            assert_eq!(pack.duplicate_wildcards, WildcardBalances::default());
            pools.mythic.clear();
            assert_eq!(
                generate_pack(&pools, &config, &mut HashMap::new(), &mut rng)
                    .cards
                    .iter()
                    .filter(|card| card.id == "r")
                    .count(),
                1
            );
            pools.basic.clear();
            assert!(validate_pools(&pools, &config.booster, "tst").is_ok());
            config.booster.basic_lands = 1;
            assert!(validate_pools(&pools, &config.booster, "tst")
                .unwrap_err()
                .contains("basic lands"));
            config.booster.basic_lands = 0;
            assert!(validate_pools(&pools, &config.booster, "tst").is_ok());
        });
    }

    #[test]
    fn starting_and_weekly_rewards_are_once_per_period() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            assert!(!status_pool(&db.pool, NOW).await.unwrap().started);
            assert_eq!(begin_pool(&db.pool, NOW).await.unwrap().available_packs, 2);
            assert_eq!(
                begin_pool(&db.pool, NOW + 100)
                    .await
                    .unwrap()
                    .available_packs,
                2
            );
            assert!(claim_pool(&db.pool, NOW + WEEK_SECONDS - 1).await.is_err());
            let reward = claim_pool(&db.pool, NOW + WEEK_SECONDS).await.unwrap();
            assert_eq!(reward.available_packs, 6);
            assert_eq!(reward.wildcards.rare, 2);
            assert_eq!(reward.week, 2);
            assert!(claim_pool(&db.pool, NOW + WEEK_SECONDS + 10).await.is_err());
            assert_eq!(
                status_pool(&db.pool, NOW + WEEK_SECONDS + 10)
                    .await
                    .unwrap()
                    .available_packs,
                6
            );
            // Missed periods accumulate and are granted together exactly once.
            assert_eq!(
                claim_pool(&db.pool, NOW + 3 * WEEK_SECONDS)
                    .await
                    .unwrap()
                    .available_packs,
                14
            );
            let rolled_back_clock = status_pool(&db.pool, NOW + WEEK_SECONDS).await.unwrap();
            assert!(!rolled_back_clock.can_claim_weekly);
            assert_eq!(
                rolled_back_clock.next_reward_at,
                Some(timestamp(NOW + 4 * WEEK_SECONDS).unwrap())
            );
            assert!(
                !status_pool(&db.pool, NOW - 1)
                    .await
                    .unwrap()
                    .can_claim_weekly
            );
        });
    }

    #[test]
    fn opening_receipts_prevent_double_claim_and_reject_changed_requests() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            let first = open_pool_boosters(&db.pool, "TST", 1, "opening-one", NOW)
                .await
                .unwrap();
            let retry = open_pool_boosters(&db.pool, "tst", 1, "opening-one", NOW + 2)
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(&first).unwrap(),
                serde_json::to_value(&retry).unwrap()
            );
            assert_eq!(first.cards.len(), 14);
            assert_eq!(status_pool(&db.pool, NOW).await.unwrap().available_packs, 1);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT SUM(quantity) FROM collection")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                14
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM booster_history")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                1
            );
            assert!(open_pool_boosters(&db.pool, "tst", 2, "opening-one", NOW)
                .await
                .is_err());
            assert!(craft_pool(&db.pool, "r", "opening-one", NOW).await.is_err());
            assert!(open_pool_boosters(&db.pool, "locked", 1, "locked-set", NOW)
                .await
                .unwrap_err()
                .contains("locked"));
        });
    }

    #[test]
    fn incomplete_pack_generation_rolls_back_pack_balance_and_history() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("DELETE FROM cards WHERE rarity='common' AND type_line='Creature'")
                .execute(&db.pool)
                .await
                .unwrap();
            assert!(
                open_pool_boosters(&db.pool, "tst", 1, "missing-common", NOW)
                    .await
                    .is_err()
            );
            assert_eq!(status_pool(&db.pool, NOW).await.unwrap().available_packs, 2);
            for table in ["collection", "booster_history", "progression_operations"] {
                assert_eq!(
                    sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table}"))
                        .fetch_one(&db.pool)
                        .await
                        .unwrap(),
                    0
                );
            }
        });
    }

    #[test]
    fn crafting_is_atomic_idempotent_and_respects_set_locks() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("UPDATE wildcards SET quantity=1 WHERE rarity='rare'")
                .execute(&db.pool)
                .await
                .unwrap();
            let result = craft_pool(&db.pool, "r", "craft-once", NOW).await.unwrap();
            assert_eq!(result.card.owned, 1);
            assert_eq!(result.wildcards.rare, 0);
            assert_eq!(
                craft_pool(&db.pool, "r", "craft-once", NOW + 1)
                    .await
                    .unwrap()
                    .card
                    .owned,
                1
            );
            assert!(craft_pool(&db.pool, "r", "craft-no-wildcards", NOW)
                .await
                .is_err());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='r'")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                1
            );
            sqlx::query("UPDATE cards SET set_code='locked' WHERE id='u'")
                .execute(&db.pool)
                .await
                .unwrap();
            assert!(craft_pool(&db.pool, "u", "craft-locked", NOW)
                .await
                .unwrap_err()
                .contains("locked"));
            // Older collections above the new limit cannot spend another wildcard.
            sqlx::query("UPDATE wildcards SET quantity=1 WHERE rarity='rare'")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::query("UPDATE collection SET quantity=? WHERE card_id='r'")
                .bind(MAX_BALANCE)
                .execute(&db.pool)
                .await
                .unwrap();
            assert!(craft_pool(&db.pool, "r", "craft-overflow", NOW)
                .await
                .is_err());
            assert_eq!(status_pool(&db.pool, NOW).await.unwrap().wildcards.rare, 1);
        });
    }

    #[test]
    fn free_basic_lands_never_spend_wildcards() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("UPDATE wildcards SET quantity=1 WHERE rarity='common'")
                .execute(&db.pool)
                .await
                .unwrap();
            let error = craft_pool(&db.pool, "l", "free-basic", NOW)
                .await
                .unwrap_err();
            assert!(error.contains("freely available"));
            assert_eq!(
                status_pool(&db.pool, NOW).await.unwrap().wildcards.common,
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collection")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM progression_operations")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
        });
    }

    #[test]
    fn crafting_cap_counts_reprints_and_preserves_receipts_and_wildcards() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,type_line) SELECT 'r-reprint',oracle_id,name,set_code,'alternate',rarity,metadata_json,type_line FROM cards WHERE id='r'")
                .execute(&db.pool).await.unwrap();
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('r',3)")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::query("UPDATE wildcards SET quantity=3 WHERE rarity='rare'")
                .execute(&db.pool)
                .await
                .unwrap();
            let fourth = craft_pool(&db.pool, "r-reprint", "fourth-reprint", NOW)
                .await
                .unwrap();
            assert_eq!(fourth.card.owned, 1);
            assert_eq!(fourth.card.oracle_owned, 4);
            assert_eq!(fourth.wildcards.rare, 2);
            assert_eq!(
                craft_pool(&db.pool, "r-reprint", "fourth-reprint", NOW + 1)
                    .await
                    .unwrap()
                    .wildcards
                    .rare,
                2
            );
            for (id, request) in [("r", "fifth-original"), ("r-reprint", "fifth-reprint")] {
                assert!(craft_pool(&db.pool, id, request, NOW)
                    .await
                    .unwrap_err()
                    .contains("four copies"));
            }
            assert_eq!(status_pool(&db.pool, NOW).await.unwrap().wildcards.rare, 2);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT SUM(quantity) FROM collection")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                4
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM progression_operations")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                1
            );
        });
    }

    #[test]
    fn protected_packs_reroll_reprints_then_convert_completed_rarity_and_keep_empty_history() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            sqlx::query("UPDATE settings SET value=json_set(value,'$.league.booster.commons',1,'$.league.booster.uncommons',0,'$.league.booster.rareSlots',0,'$.league.booster.basicLands',0) WHERE key='app'").execute(&db.pool).await.unwrap();
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,type_line) SELECT 'c-reprint',oracle_id,name,'other','alternate',rarity,metadata_json,type_line FROM cards WHERE id='c'").execute(&db.pool).await.unwrap();
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('c-reprint',4)")
                .execute(&db.pool)
                .await
                .unwrap();
            begin_pool(&db.pool, NOW).await.unwrap();
            let rerolled = open_pool_boosters(&db.pool, "tst", 1, "rerolled", NOW)
                .await
                .unwrap();
            assert_eq!(rerolled.cards.len(), 1);
            assert_ne!(rerolled.cards[0].oracle_id, "c");
            assert_eq!(rerolled.duplicate_wildcards, WildcardBalances::default());
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('c2',4),('c3',4) ON CONFLICT(card_id) DO UPDATE SET quantity=excluded.quantity").execute(&db.pool).await.unwrap();
            let completed = open_pool_boosters(&db.pool, "tst", 1, "completed", NOW + 1)
                .await
                .unwrap();
            assert!(completed.cards.is_empty());
            assert_eq!(completed.duplicate_wildcards.common, 1);
            assert_eq!(completed.wildcards.common, 1);
            let retry = open_pool_boosters(&db.pool, "tst", 1, "completed", NOW + 2)
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(&completed).unwrap(),
                serde_json::to_value(&retry).unwrap()
            );
            let status = status_pool(&db.pool, NOW + 2).await.unwrap();
            assert_eq!(status.available_packs, 0);
            assert_eq!(status.wildcards.common, 1);
            assert_eq!(status.history.len(), 2);
            assert!(status.history[0].cards.is_empty());
            assert_eq!(status.history[0].duplicate_wildcards.common, 1);
        });
    }

    #[test]
    fn opening_multiple_packs_caps_the_whole_batch_and_accounts_each_slot() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            let result = open_pool_boosters(&db.pool, "tst", 2, "batch", NOW)
                .await
                .unwrap();
            assert_eq!(result.cards.len(), 18);
            assert_eq!(result.duplicate_wildcards.common, 8);
            assert_eq!(result.duplicate_wildcards.uncommon, 2);
            assert_eq!(result.wildcards.common, 8);
            assert_eq!(result.wildcards.uncommon, 2);
            assert!(result.cards.iter().all(|card| card.oracle_owned <= 4));
            let mut connection = db.pool.acquire().await.unwrap();
            assert!(owned_totals(&mut connection)
                .await
                .unwrap()
                .values()
                .all(|quantity| *quantity <= 4));
            drop(connection);
            let status = status_pool(&db.pool, NOW).await.unwrap();
            assert_eq!(status.history.len(), 2);
            for pack in status.history {
                assert_eq!(
                    pack.cards.len() as i64
                        + pack
                            .duplicate_wildcards
                            .values()
                            .iter()
                            .map(|(_, quantity)| *quantity)
                            .sum::<i64>(),
                    14
                );
            }
        });
    }

    #[test]
    fn exhausted_mythics_keep_their_rolled_rarity_and_free_lands_do_not_increment() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let mut connection = db.pool.acquire().await.unwrap();
            let pools = booster_pools(&mut connection, "tst").await.unwrap();
            let mut config = config(&mut connection).await.unwrap();
            config.booster = BoosterConfig {
                commons: 0,
                uncommons: 0,
                rare_slots: 1,
                basic_lands: 0,
            };
            config.mythic_probability = 1.0;
            let mut owned = HashMap::from([("m".into(), 4)]);
            let pack = generate_pack(&pools, &config, &mut owned, &mut StdRng::seed_from_u64(3));
            assert!(pack.cards.is_empty());
            assert_eq!(pack.duplicate_wildcards.mythic, 1);
            assert_eq!(pack.duplicate_wildcards.rare, 0);
            drop(connection);
            sqlx::query("UPDATE settings SET value=json_set(value,'$.league.booster.commons',0,'$.league.booster.uncommons',0,'$.league.booster.rareSlots',0,'$.league.booster.basicLands',5) WHERE key='app'").execute(&db.pool).await.unwrap();
            begin_pool(&db.pool, NOW).await.unwrap();
            let basics = open_pool_boosters(&db.pool, "tst", 1, "free-land-slots", NOW)
                .await
                .unwrap();
            assert_eq!(basics.cards.len(), 5);
            assert!(basics.cards.iter().all(is_unlimited_basic));
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collection")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
        });
    }

    #[test]
    fn concurrent_crafting_and_packs_cannot_add_a_fifth_copy() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            sqlx::query("UPDATE settings SET value=json_set(value,'$.league.booster.commons',0,'$.league.booster.uncommons',0,'$.league.booster.rareSlots',1,'$.league.booster.basicLands',0,'$.league.mythicProbability',0) WHERE key='app'").execute(&db.pool).await.unwrap();
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('r',3)")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::query("UPDATE wildcards SET quantity=2 WHERE rarity='rare'")
                .execute(&db.pool)
                .await
                .unwrap();
            begin_pool(&db.pool, NOW).await.unwrap();
            let craft_db = db.pool.clone();
            let craft = tauri::async_runtime::spawn(async move {
                craft_pool(&craft_db, "r", "racing-craft", NOW).await
            });
            let pack_db = db.pool.clone();
            let opening = tauri::async_runtime::spawn(async move {
                open_pool_boosters(&pack_db, "tst", 1, "racing-pack", NOW).await
            });
            let craft = craft.await.unwrap();
            let opening = opening.await.unwrap().unwrap();
            assert_eq!(
                opening.cards.len() as i64 + opening.duplicate_wildcards.rare,
                1
            );
            assert_eq!(opening.duplicate_wildcards.rare, i64::from(craft.is_ok()));
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='r'")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                4
            );
            assert_eq!(status_pool(&db.pool, NOW).await.unwrap().wildcards.rare, 2);
        });
    }

    #[test]
    fn failed_collection_insert_rolls_back_wildcard_spending() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("UPDATE wildcards SET quantity=1 WHERE rarity='rare'")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::raw_sql("CREATE TRIGGER reject_test_card BEFORE INSERT ON collection WHEN NEW.card_id='r' BEGIN SELECT RAISE(ABORT,'test insert failure'); END;").execute(&db.pool).await.unwrap();
            assert!(craft_pool(&db.pool, "r", "failed-insert", NOW)
                .await
                .unwrap_err()
                .contains("test insert failure"));
            assert_eq!(status_pool(&db.pool, NOW).await.unwrap().wildcards.rare, 1);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collection")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM progression_operations")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
        });
    }

    #[test]
    fn legacy_history_arrays_and_receipts_still_load() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let mut connection = db.pool.acquire().await.unwrap();
            let pools = booster_pools(&mut connection, "tst").await.unwrap();
            let json = serde_json::to_string(&pools.common).unwrap();
            let history = history_contents(&json);
            assert_eq!(history.cards.len(), 3);
            assert_eq!(history.duplicate_wildcards, WildcardBalances::default());
            let old_receipt = serde_json::json!({ "id": "old", "packs": 1, "setCode": "tst", "cards": pools.common, "wildcards": WildcardBalances::default() });
            let receipt: BoosterOpening = serde_json::from_value(old_receipt).unwrap();
            assert_eq!(receipt.duplicate_wildcards, WildcardBalances::default());
            assert_eq!(receipt.cards.len(), 3);
        });
    }

    #[test]
    fn concurrent_retries_and_reward_claims_share_one_result() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            let first_pool = db.pool.clone();
            let first = tauri::async_runtime::spawn(async move {
                open_pool_boosters(&first_pool, "tst", 1, "concurrent-opening", NOW).await
            });
            let second_pool = db.pool.clone();
            let second = tauri::async_runtime::spawn(async move {
                open_pool_boosters(&second_pool, "tst", 1, "concurrent-opening", NOW).await
            });
            assert!(first.await.unwrap().is_ok());
            assert!(second.await.unwrap().is_ok());
            assert_eq!(status_pool(&db.pool, NOW).await.unwrap().available_packs, 1);
            let first_pool = db.pool.clone();
            let first = tauri::async_runtime::spawn(async move {
                claim_pool(&first_pool, NOW + WEEK_SECONDS).await
            });
            let second_pool = db.pool.clone();
            let second = tauri::async_runtime::spawn(async move {
                claim_pool(&second_pool, NOW + WEEK_SECONDS).await
            });
            let first = first.await.unwrap();
            let second = second.await.unwrap();
            assert_ne!(first.is_ok(), second.is_ok());
            assert_eq!(
                status_pool(&db.pool, NOW + WEEK_SECONDS)
                    .await
                    .unwrap()
                    .available_packs,
                5
            );
        });
    }

    #[test]
    fn late_joiners_receive_the_same_accumulated_rewards_as_existing_players() {
        tauri::async_runtime::block_on(async {
            let early = fixture().await;
            let late = fixture().await;
            begin_pool(&early.pool, NOW).await.unwrap();
            let catch_up = claim_pool(&early.pool, NOW + 3 * WEEK_SECONDS)
                .await
                .unwrap();
            let joined = begin_pool(&late.pool, NOW + 3 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(joined.available_packs, 14);
            assert_eq!(joined.available_packs, catch_up.available_packs);
            assert_eq!(joined.wildcards, catch_up.wildcards);
            assert_eq!(joined.wildcards.rare, 6);
            assert_eq!(joined.started_at, NOW);
            assert_eq!(joined.week, 4);
            assert!(!joined.can_claim_weekly);
            assert!(claim_pool(&late.pool, NOW + 3 * WEEK_SECONDS)
                .await
                .is_err());
            assert_eq!(
                begin_pool(&late.pool, NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap()
                    .available_packs,
                14
            );
            let next = claim_pool(&late.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(next.available_packs, 18);
            assert_eq!(next.wildcards.rare, 8);
        });
    }

    #[test]
    fn built_in_rules_ignore_saved_player_rules_and_unlocks_share_one_clock() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            sqlx::query("DELETE FROM settings WHERE key='test.allow-league-settings'")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::query("UPDATE settings SET value='{\"league\":{\"startingPacks\":999,\"weeklyPacks\":999,\"enabledSets\":[\"fake\"]}}' WHERE key='app'").execute(&db.pool).await.unwrap();
            let built_in = crate::league_rules::builtin_rules().unwrap();
            let joined = begin_pool(&db.pool, built_in.started_at + 2 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(joined.available_packs, 20);
            assert_eq!(
                joined.wildcards,
                WildcardBalances {
                    common: 8,
                    uncommon: 4,
                    rare: 1,
                    mythic: 0
                }
            );
            assert_eq!(joined.enabled_sets, vec!["fdn"]);
            assert_eq!(joined.started_at, built_in.started_at);

            let scheduled = fixture().await;
            sqlx::query("UPDATE settings SET value=json_set(value,'$.league.autoUnlock.intervalWeeks',1,'$.league.autoUnlock.setCodes',json('[\"NEO\",\"KHM\"]')) WHERE key='app'").execute(&scheduled.pool).await.unwrap();
            let before_join = status_pool(&scheduled.pool, NOW + 2 * WEEK_SECONDS)
                .await
                .unwrap();
            assert!(!before_join.started);
            assert_eq!(before_join.enabled_sets, vec!["tst", "neo", "khm"]);
            assert_eq!(before_join.join_packs, 10);
            assert_eq!(before_join.join_wildcards.rare, 4);
            let after_join = begin_pool(&scheduled.pool, NOW + 2 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(before_join.enabled_sets, after_join.enabled_sets);
        });
    }

    #[test]
    fn legacy_personal_clocks_adopt_the_shared_anchor_without_resetting_progress() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("UPDATE league_state SET started_at=?,available_packs=3,last_claimed_period=2 WHERE id=1")
                .bind(NOW - 4 * WEEK_SECONDS).execute(&db.pool).await.unwrap();
            sqlx::query("UPDATE wildcards SET quantity=7 WHERE rarity='rare'")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('c',2)")
                .execute(&db.pool)
                .await
                .unwrap();
            let normalized = status_pool(&db.pool, NOW + 3 * WEEK_SECONDS).await.unwrap();
            assert_eq!(normalized.started_at, NOW);
            assert_eq!(normalized.available_packs, 3);
            assert_eq!(normalized.wildcards.rare, 7);
            assert_eq!(normalized.claimable_weeks, 1);
            assert_eq!(normalized.claimable_packs, 4);
            assert_eq!(normalized.claimable_wildcards.rare, 2);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='c'")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                2
            );
            let claimed = claim_pool(&db.pool, NOW + 3 * WEEK_SECONDS).await.unwrap();
            assert_eq!(claimed.available_packs, 7);
            assert_eq!(claimed.wildcards.rare, 9);
            assert!(claim_pool(&db.pool, NOW + 3 * WEEK_SECONDS).await.is_err());
        });
    }

    #[test]
    fn concurrent_catch_up_and_failed_rewards_cannot_double_grant_or_partially_begin() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let first_pool = db.pool.clone();
            let second_pool = db.pool.clone();
            let first = tauri::async_runtime::spawn(async move {
                begin_pool(&first_pool, NOW + 3 * WEEK_SECONDS).await
            });
            let second = tauri::async_runtime::spawn(async move {
                begin_pool(&second_pool, NOW + 3 * WEEK_SECONDS).await
            });
            assert_eq!(first.await.unwrap().unwrap().available_packs, 14);
            assert_eq!(second.await.unwrap().unwrap().available_packs, 14);
            let first_pool = db.pool.clone();
            let second_pool = db.pool.clone();
            let first = tauri::async_runtime::spawn(async move {
                claim_pool(&first_pool, NOW + 5 * WEEK_SECONDS).await
            });
            let second = tauri::async_runtime::spawn(async move {
                claim_pool(&second_pool, NOW + 5 * WEEK_SECONDS).await
            });
            assert_ne!(first.await.unwrap().is_ok(), second.await.unwrap().is_ok());
            let final_status = status_pool(&db.pool, NOW + 5 * WEEK_SECONDS).await.unwrap();
            assert_eq!(final_status.available_packs, 22);
            assert_eq!(final_status.wildcards.rare, 10);

            let full = fixture().await;
            sqlx::query("UPDATE wildcards SET quantity=? WHERE rarity='rare'")
                .bind(MAX_BALANCE)
                .execute(&full.pool)
                .await
                .unwrap();
            assert!(begin_pool(&full.pool, NOW + WEEK_SECONDS).await.is_err());
            let untouched = status_pool(&full.pool, NOW + WEEK_SECONDS).await.unwrap();
            assert!(!untouched.started);
            assert_eq!(untouched.available_packs, 0);
            assert_eq!(untouched.wildcards.rare, MAX_BALANCE);
        });
    }

    #[test]
    fn expansion_week_four_adds_reserved_packs_on_top_of_weekly_rewards_and_survives_restart() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            let start = begin_pool(&db.pool, NOW).await.unwrap();
            assert_eq!(start.general_packs, 12);
            assert_eq!(start.available_packs, 12);
            assert_eq!(start.next_expansion.unwrap().code, "BLB");
            assert!(open_pool_boosters(
                &db.pool,
                "blb",
                1,
                "too-early",
                NOW + 4 * WEEK_SECONDS - 1
            )
            .await
            .unwrap_err()
            .contains("locked"));
            let pending = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            assert_eq!(pending.claimable_weeks, 4);
            assert_eq!(pending.claimable_packs, 24);
            assert_eq!(
                pending.claimable_set_packs,
                BTreeMap::from([("blb".into(), 8)])
            );
            let claimed = claim_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            assert_eq!(claimed.general_packs, 28);
            assert_eq!(claimed.set_packs, BTreeMap::from([("blb".into(), 8)]));
            assert_eq!(claimed.available_packs, 36);
            assert_eq!(
                claimed.wildcards,
                WildcardBalances {
                    common: 16,
                    uncommon: 8,
                    rare: 2,
                    mythic: 1
                }
            );
            assert_eq!(claimed.next_expansion.unwrap().code, "WOE");
            assert!(claim_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.is_err());
            db.pool.close().await;
            let reopened = SqlitePoolOptions::new()
                .connect_with(
                    SqliteConnectOptions::new()
                        .filename(db._directory.path().join("league.db"))
                        .foreign_keys(true),
                )
                .await
                .unwrap();
            let persisted = status_pool(&reopened, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(persisted.available_packs, 36);
            assert_eq!(persisted.set_packs["blb"], 8);
            assert!(!persisted.can_claim_weekly);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM expansion_reward_claims")
                    .fetch_one(&reopened)
                    .await
                    .unwrap(),
                1
            );
            reopened.close().await;
        });
    }

    #[test]
    fn late_joiners_receive_all_due_expansion_bonuses_and_the_same_weekly_entitlement() {
        tauri::async_runtime::block_on(async {
            let early = scheduled_fixture().await;
            let late = scheduled_fixture().await;
            begin_pool(&early.pool, NOW).await.unwrap();
            for week in [4, 8, 12] {
                claim_pool(&early.pool, NOW + week * WEEK_SECONDS)
                    .await
                    .unwrap();
            }
            let preview = status_pool(&late.pool, NOW + 12 * WEEK_SECONDS)
                .await
                .unwrap();
            let expected_sets =
                BTreeMap::from([("blb".into(), 8), ("woe".into(), 8), ("lci".into(), 8)]);
            assert_eq!(preview.join_packs, 84);
            assert_eq!(preview.join_set_packs, expected_sets);
            let joined = begin_pool(&late.pool, NOW + 12 * WEEK_SECONDS)
                .await
                .unwrap();
            let veteran = status_pool(&early.pool, NOW + 12 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(joined.general_packs, 60);
            assert_eq!(joined.available_packs, 84);
            assert_eq!(joined.set_packs, expected_sets);
            assert_eq!(joined.available_packs, veteran.available_packs);
            assert_eq!(joined.wildcards, veteran.wildcards);
            assert_eq!(
                joined.wildcards,
                WildcardBalances {
                    common: 48,
                    uncommon: 24,
                    rare: 6,
                    mythic: 3
                }
            );
            assert_eq!(joined.enabled_sets, vec!["fdn", "blb", "woe", "lci"]);
            assert_eq!(joined.next_expansion.unwrap().code, "OTJ");
            assert!(!joined.can_claim_weekly);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM expansion_reward_claims")
                    .fetch_one(&late.pool)
                    .await
                    .unwrap(),
                3
            );
        });
    }

    #[test]
    fn expansion_bonus_can_be_claimed_once_when_weekly_rewards_were_already_paid() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query(
                "UPDATE league_state SET available_packs=28,last_claimed_period=4 WHERE id=1",
            )
            .execute(&db.pool)
            .await
            .unwrap();
            sqlx::query("UPDATE wildcards SET quantity=7")
                .execute(&db.pool)
                .await
                .unwrap();
            let before = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            assert_eq!(before.claimable_weeks, 0);
            assert_eq!(before.claimable_packs, 8);
            assert_eq!(before.claimable_set_packs["blb"], 8);
            assert!(before.can_claim_weekly);
            let first_pool = db.pool.clone();
            let second_pool = db.pool.clone();
            let first = tauri::async_runtime::spawn(async move {
                claim_pool(&first_pool, NOW + 4 * WEEK_SECONDS).await
            });
            let second = tauri::async_runtime::spawn(async move {
                claim_pool(&second_pool, NOW + 4 * WEEK_SECONDS).await
            });
            assert_ne!(first.await.unwrap().is_ok(), second.await.unwrap().is_ok());
            let after = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            assert_eq!(after.general_packs, 28);
            assert_eq!(after.available_packs, 36);
            assert_eq!(after.wildcards, before.wildcards);
            assert!(!after.can_claim_weekly);
        });
    }

    #[test]
    fn reserved_bonus_packs_spend_only_on_their_set_and_before_general_packs() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            begin_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            sqlx::query("UPDATE league_state SET available_packs=0")
                .execute(&db.pool)
                .await
                .unwrap();
            assert!(
                open_pool_boosters(&db.pool, "fdn", 1, "wrong-set", NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap_err()
                    .contains("0 packs available for FDN")
            );
            let before = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            assert_eq!(before.available_packs, 8);
            assert_eq!(before.set_packs["blb"], 8);
            let first =
                open_pool_boosters(&db.pool, "blb", 2, "reserved-open", NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap();
            let retry =
                open_pool_boosters(&db.pool, "blb", 2, "reserved-open", NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap();
            assert_eq!(
                serde_json::to_value(first).unwrap(),
                serde_json::to_value(retry).unwrap()
            );
            let after = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            assert_eq!(after.general_packs, 0);
            assert_eq!(after.set_packs["blb"], 6);
            assert_eq!(after.available_packs, 6);
            sqlx::query("UPDATE league_state SET available_packs=2")
                .execute(&db.pool)
                .await
                .unwrap();
            open_pool_boosters(&db.pool, "blb", 7, "mixed-funding", NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            let mixed = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            assert_eq!(mixed.general_packs, 1);
            assert!(!mixed.set_packs.contains_key("blb"));
            assert_eq!(mixed.available_packs, 1);
            open_pool_boosters(&db.pool, "fdn", 1, "last-general", NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(
                status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap()
                    .available_packs,
                0
            );
        });
    }

    #[test]
    fn expansion_bonus_failure_rolls_back_weekly_rewards_and_its_claim_receipt() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("INSERT INTO set_booster_balances(set_code,quantity) VALUES('blb',?)")
                .bind(MAX_BALANCE)
                .execute(&db.pool)
                .await
                .unwrap();
            assert!(claim_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap_err()
                .contains("bonus-pack balance is full"));
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT available_packs FROM league_state")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                12
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT last_claimed_period FROM league_state")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM expansion_reward_claims")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap()
                    .wildcards,
                WildcardBalances::default()
            );
        });
    }

    #[test]
    fn completed_shared_calendar_has_no_upcoming_expansion_and_full_join_rewards() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            sqlx::query("DELETE FROM settings WHERE key='test.allow-league-settings'")
                .execute(&db.pool)
                .await
                .unwrap();
            let rules = crate::league_rules::builtin_rules().unwrap();
            let now = rules.started_at + 52 * WEEK_SECONDS;
            let status = status_pool(&db.pool, now).await.unwrap();
            assert_eq!(status.enabled_sets.len(), 14);
            assert!(status.next_expansion.is_none());
            assert!(status.upcoming_expansions.is_empty());
            assert_eq!(status.join_set_packs.len(), 13);
            assert!(status.join_set_packs.values().all(|packs| *packs == 8));
            assert_eq!(status.join_packs, 12 + 52 * 4 + 13 * 8);
            let joined = begin_pool(&db.pool, now).await.unwrap();
            assert_eq!(joined.general_packs, 220);
            assert_eq!(joined.available_packs, 324);
            assert_eq!(
                joined.wildcards,
                WildcardBalances {
                    common: 208,
                    uncommon: 104,
                    rare: 26,
                    mythic: 13,
                }
            );
            assert_eq!(
                begin_pool(&db.pool, now).await.unwrap().available_packs,
                324
            );
        });
    }

    #[test]
    fn wildcard_cadence_uses_calendar_boundaries_for_rare_and_mythic_rewards() {
        let rules = crate::league_rules::builtin_rules().unwrap();
        for (week, expected) in [
            (0, [0, 0, 0, 0]),
            (1, [4, 2, 0, 0]),
            (2, [8, 4, 1, 0]),
            (3, [12, 6, 1, 0]),
            (4, [16, 8, 2, 1]),
            (5, [20, 10, 2, 1]),
            (7, [28, 14, 3, 1]),
            (8, [32, 16, 4, 2]),
        ] {
            let (packs, rewards) = accumulated_rewards(&rules, week).unwrap();
            assert_eq!(packs, week * 4);
            assert_eq!(
                rewards,
                WildcardBalances {
                    common: expected[0],
                    uncommon: expected[1],
                    rare: expected[2],
                    mythic: expected[3]
                }
            );
        }
        let (_, at_second_week) = rewards_between(&rules, 1, 2).unwrap();
        assert_eq!(
            at_second_week,
            WildcardBalances {
                common: 4,
                uncommon: 2,
                rare: 1,
                mythic: 0
            }
        );
        let (_, at_fourth_week) = rewards_between(&rules, 3, 4).unwrap();
        assert_eq!(
            at_fourth_week,
            WildcardBalances {
                common: 4,
                uncommon: 2,
                rare: 1,
                mythic: 1
            }
        );
        let (_, skipped_weeks) = rewards_between(&rules, 1, 7).unwrap();
        assert_eq!(
            skipped_weeks,
            WildcardBalances {
                common: 24,
                uncommon: 12,
                rare: 3,
                mythic: 1
            }
        );
        assert_eq!(
            rewards_between(&rules, 9, 7).unwrap(),
            (0, WildcardBalances::default())
        );
        let mut invalid = rules;
        invalid.wildcard_reward_intervals.rare = 0;
        assert!(validate_config(&invalid).unwrap_err().contains("intervals"));
        assert!(accumulated_rewards(&invalid, 2).is_err());
    }

    #[test]
    fn odd_claim_periods_missed_weeks_and_late_joiners_receive_the_same_cadence() {
        tauri::async_runtime::block_on(async {
            let veteran = scheduled_fixture().await;
            let newcomer = scheduled_fixture().await;
            begin_pool(&veteran.pool, NOW).await.unwrap();
            let week_one = claim_pool(&veteran.pool, NOW + WEEK_SECONDS).await.unwrap();
            assert_eq!(
                week_one.wildcards,
                WildcardBalances {
                    common: 4,
                    uncommon: 2,
                    rare: 0,
                    mythic: 0
                }
            );
            let missed = status_pool(&veteran.pool, NOW + 3 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(missed.claimable_weeks, 2);
            assert_eq!(
                missed.claimable_wildcards,
                WildcardBalances {
                    common: 8,
                    uncommon: 4,
                    rare: 1,
                    mythic: 0
                }
            );
            let caught_up = claim_pool(&veteran.pool, NOW + 3 * WEEK_SECONDS)
                .await
                .unwrap();
            let late_join = begin_pool(&newcomer.pool, NOW + 3 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(
                caught_up.wildcards,
                WildcardBalances {
                    common: 12,
                    uncommon: 6,
                    rare: 1,
                    mythic: 0
                }
            );
            assert_eq!(caught_up.wildcards, late_join.wildcards);
            assert_eq!(caught_up.available_packs, late_join.available_packs);
            let fourth_week = status_pool(&veteran.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(
                fourth_week.claimable_wildcards,
                WildcardBalances {
                    common: 4,
                    uncommon: 2,
                    rare: 1,
                    mythic: 1
                }
            );
            assert_eq!(fourth_week.claimable_packs, 12);
            let paid = claim_pool(&veteran.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            let newcomer_paid = claim_pool(&newcomer.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(
                paid.wildcards,
                WildcardBalances {
                    common: 16,
                    uncommon: 8,
                    rare: 2,
                    mythic: 1
                }
            );
            assert_eq!(paid.wildcards, newcomer_paid.wildcards);
            assert_eq!(paid.set_packs["blb"], 8);
            assert!(claim_pool(&veteran.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .is_err());
        });
    }

    #[test]
    fn wildcard_cadence_changes_preserve_existing_cards_and_balances() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("UPDATE wildcards SET quantity=CASE rarity WHEN 'common' THEN 5 WHEN 'uncommon' THEN 6 WHEN 'rare' THEN 7 WHEN 'mythic' THEN 8 END").execute(&db.pool).await.unwrap();
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('fdn-c',2)")
                .execute(&db.pool)
                .await
                .unwrap();
            let before_claim = status_pool(&db.pool, NOW + 2 * WEEK_SECONDS).await.unwrap();
            assert_eq!(
                before_claim.wildcards,
                WildcardBalances {
                    common: 5,
                    uncommon: 6,
                    rare: 7,
                    mythic: 8
                }
            );
            let paid = claim_pool(&db.pool, NOW + 2 * WEEK_SECONDS).await.unwrap();
            assert_eq!(
                paid.wildcards,
                WildcardBalances {
                    common: 13,
                    uncommon: 10,
                    rare: 8,
                    mythic: 8
                }
            );
            assert_eq!(
                begin_pool(&db.pool, NOW + 2 * WEEK_SECONDS)
                    .await
                    .unwrap()
                    .wildcards,
                paid.wildcards
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT quantity FROM collection WHERE card_id='fdn-c'"
                )
                .fetch_one(&db.pool)
                .await
                .unwrap(),
                2
            );
        });
    }

    #[test]
    fn automatic_unlocks_are_ordered_and_do_not_change_ownership() {
        let mut config = LeagueConfig::default();
        config.started_at = NOW;
        config.enabled_sets = vec!["TST".into()];
        config.auto_unlock = AutoUnlock {
            interval_weeks: 2,
            set_codes: vec!["NEO".into(), "KHM".into()],
        };
        let state = Some(LeagueState {
            started_at: NOW,
            available_packs: 2,
            last_claimed_period: 0,
        });
        assert_eq!(
            enabled_sets(&config, state, NOW + WEEK_SECONDS),
            vec!["tst"]
        );
        assert_eq!(
            enabled_sets(&config, state, NOW + 2 * WEEK_SECONDS),
            vec!["tst", "neo"]
        );
        assert_eq!(
            enabled_sets(&config, state, NOW + 4 * WEEK_SECONDS),
            vec!["tst", "neo", "khm"]
        );
    }
}
