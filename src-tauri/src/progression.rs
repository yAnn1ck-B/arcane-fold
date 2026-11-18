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
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use tauri::AppHandle;

const WEEK_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_BALANCE: i64 = 2_147_483_647;
const COLLECTION_COPY_LIMIT: i64 = 4;
const REWARD_ENTITLEMENTS_KEY: &str = "league_reward_entitlements_v1";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WildcardBalances {
    pub common: i64,
    pub uncommon: i64,
    pub rare: i64,
    pub mythic: i64,
    #[serde(default)]
    pub discovery: i64,
}

impl WildcardBalances {
    fn values(&self) -> [(&'static str, i64); 5] {
        [
            ("common", self.common),
            ("uncommon", self.uncommon),
            ("rare", self.rare),
            ("mythic", self.mythic),
            ("discovery", self.discovery),
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
        self.discovery += other.discovery;
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
    pub openable_packs: i64,
    pub preview_weeks: i64,
    pub effective_now: String,
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
    #[serde(default)]
    pub per_set_packs: BTreeMap<String, i64>,
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

pub(crate) async fn unlocked_sets_connection(
    connection: &mut SqliteConnection,
) -> Result<Vec<String>, String> {
    #[cfg(test)]
    if let Some(value) =
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key='test.unlocked-sets'")
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| error.to_string())?
    {
        return serde_json::from_str(&value).map_err(|error| error.to_string());
    }
    let rules = config(connection).await?;
    Ok(enabled_sets(
        &rules,
        None,
        crate::league_clock::effective_now(),
    ))
}

fn validate_config(config: &LeagueConfig) -> Result<(), String> {
    if [
        config.wildcard_reward_intervals.common,
        config.wildcard_reward_intervals.uncommon,
        config.wildcard_reward_intervals.rare,
        config.wildcard_reward_intervals.mythic,
        config.wildcard_reward_intervals.discovery,
    ]
    .iter()
    .any(|weeks| !(1..=10_000).contains(weeks))
    {
        return Err("Wildcard reward intervals must be whole weeks between 1 and 10,000.".into());
    }
    for (offset, interval) in config.wildcard_reward_offsets.values().iter().zip([
        config.wildcard_reward_intervals.common,
        config.wildcard_reward_intervals.uncommon,
        config.wildcard_reward_intervals.rare,
        config.wildcard_reward_intervals.mythic,
        config.wildcard_reward_intervals.discovery,
    ]) {
        if offset.1 < 0 || offset.1 >= interval {
            return Err(
                "Wildcard reward offsets must be non-negative and less than their interval.".into(),
            );
        }
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
        || config
            .starting_wildcards
            .values()
            .iter()
            .any(|(_, value)| !(0..=100_000).contains(value))
    {
        return Err(
            "Pack and wildcard rewards must be whole numbers between 0 and 100,000.".into(),
        );
    }
    if [config.mythic_probability, config.wildcard_drop_probability]
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err("Mythic and wildcard probabilities must be between 0% and 100%.".into());
    }
    if config.booster.basic_lands != 0 {
        return Err(
            "Basic lands are freely available in decks and must not occupy booster slots.".into(),
        );
    }
    if !config.booster.common_land_weight.is_finite()
        || config.booster.common_land_weight <= 0.0
        || config.booster.common_land_weight > 1.0
    {
        return Err("The common land weight must be greater than zero and at most one.".into());
    }
    if !(0..=100).contains(&config.booster.preferred_land_limit) {
        return Err("The preferred nonbasic land limit must be between 0 and 100.".into());
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
    let wildcard = |amount: i64, interval: i64, offset: i64| {
        if interval < 1 {
            return Err("Wildcard reward intervals must be positive whole weeks.".to_string());
        }
        // Count calendar boundaries crossed, not the rounded length of the
        // missed interval. Claiming week 1 then week 2 must grant the first rare.
        let grants = (current.saturating_add(offset) / interval)
            .saturating_sub(claimed.saturating_add(offset) / interval)
            .max(0);
        multiply(amount, grants)
    };
    Ok((
        multiply(config.weekly_packs, current.saturating_sub(claimed).max(0))?,
        WildcardBalances {
            common: wildcard(
                config.weekly_wildcards.common,
                config.wildcard_reward_intervals.common,
                config.wildcard_reward_offsets.common,
            )?,
            uncommon: wildcard(
                config.weekly_wildcards.uncommon,
                config.wildcard_reward_intervals.uncommon,
                config.wildcard_reward_offsets.uncommon,
            )?,
            rare: wildcard(
                config.weekly_wildcards.rare,
                config.wildcard_reward_intervals.rare,
                config.wildcard_reward_offsets.rare,
            )?,
            mythic: wildcard(
                config.weekly_wildcards.mythic,
                config.wildcard_reward_intervals.mythic,
                config.wildcard_reward_offsets.mythic,
            )?,
            discovery: wildcard(
                config.weekly_wildcards.discovery,
                config.wildcard_reward_intervals.discovery,
                config.wildcard_reward_offsets.discovery,
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

// Queue rows retain the expansion and calendar order of every unspent grant.
// Balances remain authoritative for compatibility with existing local profiles.
fn pack_set_at(config: &LeagueConfig, week: i64) -> Result<String, String> {
    let mut selected = config.enabled_sets.first().cloned().map(|code| (0, code));
    for expansion in &config.expansion_schedule {
        if expansion.week <= week
            && selected
                .as_ref()
                .is_none_or(|(at, _)| expansion.week >= *at)
        {
            selected = Some((expansion.week, expansion.code.clone()));
        }
    }
    if config.auto_unlock.interval_weeks > 0 {
        for (index, code) in config.auto_unlock.set_codes.iter().enumerate() {
            let at = (index as i64 + 1) * config.auto_unlock.interval_weeks;
            if at <= week
                && selected
                    .as_ref()
                    .is_none_or(|(previous, _)| at >= *previous)
            {
                selected = Some((at, code.clone()));
            }
        }
    }
    selected
        .map(|(_, code)| code.trim().to_lowercase())
        .ok_or_else(|| "No expansion is available for these booster rewards.".into())
}

async fn enqueue_packs(
    connection: &mut SqliteConnection,
    id: &str,
    code: &str,
    source: &str,
    week: i64,
    priority: i64,
    count: i64,
) -> Result<(), String> {
    if count == 0 {
        return Ok(());
    }
    sqlx::query("INSERT INTO booster_pack_queue(id,set_code,source,earned_period,priority,remaining) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET remaining=remaining+excluded.remaining")
        .bind(id).bind(code).bind(source).bind(week).bind(priority).bind(count).execute(&mut *connection).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn enqueue_weekly(
    connection: &mut SqliteConnection,
    config: &LeagueConfig,
    from: i64,
    through: i64,
) -> Result<(), String> {
    enqueue_weekly_with_prefix(connection, config, from, through, "weekly").await
}

async fn enqueue_weekly_with_prefix(
    connection: &mut SqliteConnection,
    config: &LeagueConfig,
    from: i64,
    through: i64,
    prefix: &str,
) -> Result<(), String> {
    if through <= from || config.weekly_packs == 0 {
        return Ok(());
    }
    let end = through
        .checked_add(1)
        .ok_or("The reward calendar is outside the supported range.")?;
    let mut boundaries = BTreeSet::from([from + 1, end]);
    for expansion in &config.expansion_schedule {
        if expansion.week > from && expansion.week < end {
            boundaries.insert(expansion.week);
        }
    }
    if config.auto_unlock.interval_weeks > 0 {
        for index in 0..config.auto_unlock.set_codes.len() {
            let at = (index as i64 + 1) * config.auto_unlock.interval_weeks;
            if at > from && at < end {
                boundaries.insert(at);
            }
        }
    }
    let boundaries: Vec<_> = boundaries.into_iter().collect();
    for pair in boundaries.windows(2) {
        let first = pair[0];
        let count = (pair[1] - first)
            .checked_mul(config.weekly_packs)
            .filter(|count| *count <= MAX_BALANCE)
            .ok_or("The queued reward balance is too large.")?;
        let code = pack_set_at(config, first)?;
        enqueue_packs(
            connection,
            &format!("{prefix}:{first:012}"),
            &code,
            "general",
            first,
            1,
            count,
        )
        .await?;
    }
    Ok(())
}

async fn consume_queued_source(
    connection: &mut SqliteConnection,
    source: &str,
    code: &str,
    mut count: i64,
) -> Result<(), String> {
    let rows = sqlx::query("SELECT id,remaining FROM booster_pack_queue WHERE source=? AND (?='' OR set_code=?) AND remaining>0 ORDER BY earned_period,priority,id")
        .bind(source).bind(code).bind(code).fetch_all(&mut *connection).await.map_err(|e| e.to_string())?;
    for row in rows {
        if count == 0 {
            break;
        }
        let take = count.min(row.get("remaining"));
        sqlx::query(
            "UPDATE booster_pack_queue SET remaining=remaining-? WHERE id=? AND remaining>=?",
        )
        .bind(take)
        .bind(row.get::<&str, _>("id"))
        .bind(take)
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
        count -= take;
    }
    if count != 0 {
        return Err("The chronological pack queue does not match the saved balance.".into());
    }
    Ok(())
}

async fn reconcile_queue_source(
    connection: &mut SqliteConnection,
    source: &str,
    code: &str,
    actual: i64,
    fallback: &str,
    week: i64,
) -> Result<(), String> {
    let queued: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(remaining),0) FROM booster_pack_queue WHERE source=? AND (?='' OR set_code=?)")
        .bind(source).bind(code).bind(code).fetch_one(&mut *connection).await.map_err(|e| e.to_string())?;
    if queued > actual {
        consume_queued_source(connection, source, code, queued - actual).await?;
    }
    if queued < actual {
        enqueue_packs(
            connection,
            &format!("legacy:{source}:{code}"),
            fallback,
            source,
            week,
            0,
            actual - queued,
        )
        .await?;
    }
    Ok(())
}

async fn ensure_pack_queue(
    connection: &mut SqliteConnection,
    config: &LeagueConfig,
    current: Option<LeagueState>,
) -> Result<(), String> {
    let initial = pack_set_at(config, 0)?;
    reconcile_queue_source(
        connection,
        "general",
        "",
        current.map(|state| state.available_packs).unwrap_or(0),
        &initial,
        0,
    )
    .await?;
    let mut bonuses = set_pack_balances(connection).await?;
    let previous: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT set_code FROM booster_pack_queue WHERE source='bonus'")
            .fetch_all(&mut *connection)
            .await
            .map_err(|e| e.to_string())?;
    for code in previous {
        bonuses.entry(code).or_default();
    }
    for (code, balance) in bonuses {
        let week = config
            .expansion_schedule
            .iter()
            .find(|entry| entry.code.eq_ignore_ascii_case(&code))
            .map(|entry| entry.week)
            .unwrap_or(0);
        reconcile_queue_source(connection, "bonus", &code, balance, &code, week).await?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RewardEntitlements {
    version: u8,
    starting_packs: i64,
    weekly_packs: i64,
    starting_wildcards: WildcardBalances,
    #[serde(default)]
    alternating_rewards_applied: bool,
}

impl RewardEntitlements {
    fn current(config: &LeagueConfig) -> Self {
        Self {
            version: 1,
            starting_packs: config.starting_packs,
            weekly_packs: config.weekly_packs,
            starting_wildcards: config.starting_wildcards.clone(),
            alternating_rewards_applied: true,
        }
    }

    fn legacy() -> Self {
        // These are the fixed entitlements shipped before this ledger existed.
        Self {
            version: 1,
            starting_packs: 12,
            weekly_packs: 4,
            starting_wildcards: WildcardBalances::default(),
            alternating_rewards_applied: false,
        }
    }
}

async fn store_reward_entitlements(
    connection: &mut SqliteConnection,
    ledger: &RewardEntitlements,
) -> Result<(), String> {
    sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(REWARD_ENTITLEMENTS_KEY).bind(serde_json::to_string(ledger).map_err(|error| error.to_string())?)
        .execute(&mut *connection).await.map_err(|error| error.to_string())?;
    Ok(())
}

async fn reconcile_reward_entitlements(
    connection: &mut SqliteConnection,
    config: &LeagueConfig,
    current: LeagueState,
) -> Result<bool, String> {
    let saved: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
        .bind(REWARD_ENTITLEMENTS_KEY)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    let previous = match saved.as_deref() {
        Some(value) => serde_json::from_str::<RewardEntitlements>(value).map_err(|_| {
            "The saved reward entitlement ledger is invalid. Existing progress was preserved."
                .to_string()
        })?,
        None => RewardEntitlements::legacy(),
    };
    if previous.version != 1
        || [previous.starting_packs, previous.weekly_packs]
            .iter()
            .any(|value| !(0..=100_000).contains(value))
        || previous
            .starting_wildcards
            .values()
            .iter()
            .any(|(_, value)| !(0..=100_000).contains(value))
    {
        return Err(
            "The saved reward entitlement ledger is invalid. Existing progress was preserved."
                .into(),
        );
    }
    let initial_delta = (config.starting_packs - previous.starting_packs).max(0);
    let weekly_delta = (config.weekly_packs - previous.weekly_packs).max(0);
    let packs = weekly_delta
        .checked_mul(current.last_claimed_period)
        .and_then(|value| value.checked_add(initial_delta))
        .filter(|value| *value <= MAX_BALANCE)
        .ok_or("The accumulated reward adjustment exceeds the supported balance.")?;
    let mut wildcard_delta = WildcardBalances {
        common: (config.starting_wildcards.common - previous.starting_wildcards.common).max(0),
        uncommon: (config.starting_wildcards.uncommon - previous.starting_wildcards.uncommon)
            .max(0),
        rare: (config.starting_wildcards.rare - previous.starting_wildcards.rare).max(0),
        mythic: (config.starting_wildcards.mythic - previous.starting_wildcards.mythic).max(0),
        discovery: (config.starting_wildcards.discovery - previous.starting_wildcards.discovery)
            .max(0),
    };
    if !previous.alternating_rewards_applied
        && (config.weekly_wildcards.discovery > 0 || config.wildcard_reward_offsets.mythic > 0)
    {
        // Published clients credited one mythic at weeks 4,8,... and no Discovery.
        // Correct already-claimed periods once using entitlements, never balances:
        // a spent mythic or Discovery must never be replenished by an upgrade.
        let (_, entitled) = accumulated_rewards(config, current.last_claimed_period)?;
        wildcard_delta.mythic += (entitled.mythic - current.last_claimed_period / 4).max(0);
        wildcard_delta.discovery += entitled.discovery;
        if wildcard_delta
            .values()
            .iter()
            .any(|(_, amount)| *amount > MAX_BALANCE)
        {
            return Err(
                "The accumulated wildcard adjustment exceeds the supported balance.".into(),
            );
        }
    }
    if packs > 0 {
        ensure_pack_queue(connection, config, Some(current)).await?;
        let changed = sqlx::query("UPDATE league_state SET available_packs=available_packs+? WHERE id=1 AND available_packs<=?")
            .bind(packs).bind(MAX_BALANCE-packs).execute(&mut *connection).await.map_err(|error| error.to_string())?.rows_affected();
        if changed != 1 {
            return Err("The pack balance cannot accept the reward adjustment.".into());
        }
        enqueue_packs(
            connection,
            &format!(
                "reward-adjustment:v1:starting:{}:{}",
                previous.starting_packs, config.starting_packs
            ),
            &pack_set_at(config, 0)?,
            "general",
            0,
            0,
            initial_delta,
        )
        .await?;
        let mut delta_config = config.clone();
        delta_config.weekly_packs = weekly_delta;
        enqueue_weekly_with_prefix(
            connection,
            &delta_config,
            0,
            current.last_claimed_period,
            &format!(
                "reward-adjustment:v1:weekly:{}:{}",
                previous.weekly_packs, config.weekly_packs
            ),
        )
        .await?;
    }
    add_wildcards(connection, &wildcard_delta).await?;
    let updated = RewardEntitlements {
        version: 1,
        starting_packs: previous.starting_packs.max(config.starting_packs),
        weekly_packs: previous.weekly_packs.max(config.weekly_packs),
        alternating_rewards_applied: true,
        starting_wildcards: WildcardBalances {
            discovery: previous
                .starting_wildcards
                .discovery
                .max(config.starting_wildcards.discovery),
            common: previous
                .starting_wildcards
                .common
                .max(config.starting_wildcards.common),
            uncommon: previous
                .starting_wildcards
                .uncommon
                .max(config.starting_wildcards.uncommon),
            rare: previous
                .starting_wildcards
                .rare
                .max(config.starting_wildcards.rare),
            mythic: previous
                .starting_wildcards
                .mythic
                .max(config.starting_wildcards.mythic),
        },
    };
    if saved.is_none()
        || serde_json::to_string(&updated).map_err(|error| error.to_string())?
            != serde_json::to_string(&previous).map_err(|error| error.to_string())?
    {
        store_reward_entitlements(connection, &updated).await?;
    }
    Ok(packs > 0 || wildcard_delta.values().iter().any(|(_, value)| *value > 0))
}

async fn accrue_rewards(
    connection: &mut SqliteConnection,
    config: &LeagueConfig,
    now: i64,
    auto_start: bool,
) -> Result<(), String> {
    let mut current = state(connection, config).await?;
    ensure_pack_queue(connection, config, current).await?;
    if let Some(existing) = current {
        reconcile_reward_entitlements(connection, config, existing).await?;
    }
    if current.is_none() {
        if !auto_start {
            return Ok(());
        }
        if now < config.started_at {
            return Err(format!(
                "This league begins on {}.",
                timestamp(config.started_at)?
            ));
        }
        sqlx::query("INSERT INTO league_state(id,started_at,available_packs,last_claimed_period) VALUES(1,?,?,0)")
            .bind(config.started_at).bind(config.starting_packs).execute(&mut *connection).await.map_err(|e| e.to_string())?;
        enqueue_packs(
            connection,
            "starting",
            &pack_set_at(config, 0)?,
            "general",
            0,
            0,
            config.starting_packs,
        )
        .await?;
        add_wildcards(connection, &config.starting_wildcards).await?;
        store_reward_entitlements(connection, &RewardEntitlements::current(config)).await?;
        current = Some(LeagueState {
            started_at: config.started_at,
            available_packs: config.starting_packs,
            last_claimed_period: 0,
        });
    }
    let current = current.unwrap();
    let elapsed = period(config.started_at, now);
    let (packs, wildcards) = rewards_between(config, current.last_claimed_period, elapsed)?;
    let credited = elapsed.max(current.last_claimed_period);
    let changed = sqlx::query("UPDATE league_state SET available_packs=available_packs+?,last_claimed_period=? WHERE id=1 AND available_packs<=?")
        .bind(packs).bind(credited).bind(MAX_BALANCE - packs).execute(&mut *connection).await.map_err(|e| e.to_string())?.rows_affected();
    if changed != 1 {
        return Err("The accumulated booster balance is full.".into());
    }
    add_wildcards(connection, &wildcards).await?;
    enqueue_weekly(connection, config, current.last_claimed_period, elapsed).await?;
    grant_expansion_rewards(connection, config, now).await?;
    Ok(())
}

pub async fn automatic_status_pool(pool: &SqlitePool, now: i64) -> Result<LeagueStatus, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let config = config(&mut transaction).await?;
    // First use grants the same persisted entitlements as a first opening.
    // Keep pre-launch status readable without granting rewards early.
    accrue_rewards(&mut transaction, &config, now, now >= config.started_at).await?;
    let result = status_connection(&mut transaction, now).await?;
    transaction.commit().await.map_err(|e| e.to_string())?;
    Ok(result)
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
        enqueue_packs(
            connection,
            &format!("expansion:{code}"),
            &code,
            "bonus",
            expansion.week,
            0,
            amount,
        )
        .await?;
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
            "discovery" => balances.discovery = quantity,
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
    let (join_weekly_packs, mut join_wildcards) = accumulated_rewards(&config, current)?;
    join_wildcards.add(&config.starting_wildcards);
    if join_wildcards
        .values()
        .iter()
        .any(|(_, quantity)| *quantity > MAX_BALANCE)
    {
        return Err("The catch-up wildcard balance exceeds the supported range.".into());
    }
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
        openable_packs: if state.is_some() {
            available_packs
                .checked_add(claimable_packs)
                .ok_or("The openable pack balance exceeds the supported range.")?
        } else {
            join_packs
        },
        preview_weeks: crate::league_clock::preview_weeks(),
        effective_now: timestamp(now)?,
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

#[cfg(test)]
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
    let existing = state(&mut transaction, &config).await?;
    if existing.is_none() {
        accrue_rewards(&mut transaction, &config, now, true).await?;
    } else {
        ensure_pack_queue(&mut transaction, &config, existing).await?;
        reconcile_reward_entitlements(&mut transaction, &config, existing.unwrap()).await?;
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
    ensure_pack_queue(&mut transaction, &config, Some(state)).await?;
    let adjusted = reconcile_reward_entitlements(&mut transaction, &config, state).await?;
    let current = period(config.started_at, now);
    let bonuses = unclaimed_expansion_rewards(&mut transaction, &config, now).await?;
    if current < 1 && bonuses.is_empty() && !adjusted {
        return Err(
            "The first weekly reward becomes available seven days after the league begins.".into(),
        );
    }
    if current <= state.last_claimed_period && bonuses.is_empty() && !adjusted {
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
    enqueue_weekly(
        &mut transaction,
        &config,
        state.last_claimed_period,
        current,
    )
    .await?;
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
    crate::card_policy::eligible(metadata, card)
        && matches!(
            card.rarity.as_str(),
            "common" | "uncommon" | "rare" | "mythic"
        )
        && !metadata
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
    if slots.basic_lands != 0 {
        return Err(
            "Basic lands are freely available in decks and must not occupy booster slots.".into(),
        );
    }
    for (count, size, label) in [
        (slots.commons, pools.common.len(), "common cards"),
        (slots.uncommons, pools.uncommon.len(), "uncommon cards"),
        (slots.rare_slots, pools.rare.len(), "rare cards"),
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

fn is_nonbasic_booster_land(card: &CatalogCard) -> bool {
    !is_unlimited_basic(card)
        && card
            .type_line
            .split(" // ")
            .next()
            .unwrap_or_default()
            .split('—')
            .next()
            .unwrap_or_default()
            .split_whitespace()
            .any(|kind| kind.eq_ignore_ascii_case("Land"))
}

fn draw_protected_card<R: Rng + ?Sized>(
    pool: &[CatalogCard],
    rarity: &str,
    slots: &BoosterConfig,
    owned: &mut HashMap<String, i64>,
    pack: &mut PackContents,
    rng: &mut R,
) {
    // Weight identities, then choose artwork, so variants cannot skew the recipe.
    let mut seen = HashSet::new();
    let mut available: Vec<_> = pool
        .iter()
        .filter(|card| {
            !is_unlimited_basic(card)
                && owned.get(&card.oracle_id).copied().unwrap_or(0) < COLLECTION_COPY_LIMIT
                && seen.insert(card.oracle_id.as_str())
        })
        .collect();
    if available.is_empty() {
        pack.duplicate_wildcards.add_rarity(rarity);
        return;
    }
    let lands = pack
        .cards
        .iter()
        .filter(|card| is_nonbasic_booster_land(card))
        .count();
    // Both restrictions are preferences, never reasons to mint an early wildcard.
    if lands >= slots.preferred_land_limit as usize
        && available.iter().any(|card| !is_nonbasic_booster_land(card))
    {
        available.retain(|card| !is_nonbasic_booster_land(card));
    }
    let in_pack: HashSet<_> = pack
        .cards
        .iter()
        .map(|card| card.oracle_id.as_str())
        .collect();
    if available
        .iter()
        .any(|card| !in_pack.contains(card.oracle_id.as_str()))
    {
        available.retain(|card| !in_pack.contains(card.oracle_id.as_str()));
    }
    let selected = available
        .choose_weighted(rng, |card| {
            if rarity == "common" && is_nonbasic_booster_land(card) {
                slots.common_land_weight
            } else {
                1.0
            }
        })
        .expect("validated booster weights and a nonempty eligible pool");
    let oracle_id = selected.oracle_id.as_str();
    let printings: Vec<_> = pool
        .iter()
        .filter(|card| card.oracle_id.as_str() == oracle_id)
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
    // Choose higher-rarity lands first without forcing a land hit or changing
    // the rarity roll. Multiple custom rare slots prioritize rolled mythics.
    let mut rare_slots: Vec<_> = (0..config.booster.rare_slots)
        .map(|_| !pools.mythic.is_empty() && rng.gen_bool(config.mythic_probability))
        .collect();
    rare_slots.sort_by_key(|mythic| !*mythic);
    for mythic in rare_slots {
        if mythic {
            draw_protected_card(
                &pools.mythic,
                "mythic",
                &config.booster,
                owned,
                &mut pack,
                rng,
            );
        } else {
            draw_protected_card(&pools.rare, "rare", &config.booster, owned, &mut pack, rng);
        }
    }
    for _ in 0..config.booster.uncommons {
        draw_protected_card(
            &pools.uncommon,
            "uncommon",
            &config.booster,
            owned,
            &mut pack,
            rng,
        );
    }
    for _ in 0..config.booster.commons {
        draw_protected_card(
            &pools.common,
            "common",
            &config.booster,
            owned,
            &mut pack,
            rng,
        );
    }
    // Selection priority is independent of the familiar display/history order.
    pack.cards.sort_by_key(|card| match card.rarity.as_str() {
        "common" => 0,
        "uncommon" => 1,
        "rare" => 2,
        "mythic" => 3,
        _ => 4,
    });
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
    ensure_pack_queue(&mut transaction, &config, Some(state)).await?;
    reconcile_reward_entitlements(&mut transaction, &config, state).await?;
    let state = self::state(&mut transaction, &config)
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
    consume_queued_source(&mut transaction, "bonus", &set_code, use_reserved).await?;
    consume_queued_source(&mut transaction, "general", "", use_general).await?;
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
        per_set_packs: BTreeMap::from([(set_code.clone(), count)]),
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

pub async fn open_next_pool_boosters(
    pool: &SqlitePool,
    requested: i64,
    request_id: &str,
    now: i64,
) -> Result<BoosterOpening, String> {
    const MAX_OPENING: i64 = 10_000;
    valid_request_id(request_id)?;
    if !(0..=MAX_OPENING).contains(&requested) {
        return Err("Open between one and 10,000 packs, or use Open all.".into());
    }
    let request = serde_json::json!({ "count": requested }).to_string();
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    if let Some(result) = receipt(&mut transaction, request_id, "open", &request).await? {
        transaction.commit().await.map_err(|e| e.to_string())?;
        return Ok(result);
    }
    let config = config(&mut transaction).await?;
    accrue_rewards(&mut transaction, &config, now, true).await?;
    let queued = sqlx::query("SELECT id,set_code,source,remaining FROM booster_pack_queue WHERE remaining>0 ORDER BY earned_period,priority,id")
        .fetch_all(&mut *transaction).await.map_err(|e| e.to_string())?;
    let available = queued
        .iter()
        .try_fold(0_i64, |sum, row| {
            sum.checked_add(row.get::<i64, _>("remaining"))
        })
        .ok_or("The pack queue exceeds the supported range.")?;
    let count = if requested == 0 { available } else { requested };
    if count == 0 {
        return Err("No booster packs are available yet.".into());
    }
    if count > available {
        return Err(format!("You have {available} booster packs available."));
    }
    if count > MAX_OPENING {
        return Err(
            "This opening exceeds the 10,000-pack transaction limit. Open a smaller group first."
                .into(),
        );
    }
    let mut remaining = count;
    let mut plan = Vec::new();
    for row in queued {
        if remaining == 0 {
            break;
        }
        let quantity = remaining.min(row.get("remaining"));
        plan.push((
            row.get::<String, _>("id"),
            row.get::<String, _>("set_code"),
            row.get::<String, _>("source"),
            quantity,
        ));
        remaining -= quantity;
    }
    let unlocked = enabled_sets(&config, None, now);
    let mut pools_by_set = HashMap::new();
    for (_, code, _, _) in &plan {
        if !unlocked.contains(code) {
            return Err(format!(
                "{} packs are not unlocked yet.",
                code.to_uppercase()
            ));
        }
        if !pools_by_set.contains_key(code) {
            let pools = booster_pools(&mut transaction, code).await?;
            validate_pools(&pools, &config.booster, code)?;
            pools_by_set.insert(code.clone(), pools);
        }
    }
    let mut rng = OsRng;
    let mut owned = owned_totals(&mut transaction).await?;
    let mut cards = Vec::new();
    let mut rewards = WildcardBalances::default();
    let mut duplicates = WildcardBalances::default();
    let mut outcomes = Vec::new();
    let mut per_set_packs = BTreeMap::<String, i64>::new();
    for (id, code, source, quantity) in plan {
        let pools = &pools_by_set[&code];
        for _ in 0..quantity {
            let pack = generate_pack(pools, &config, &mut owned, &mut rng);
            duplicates.add(&pack.duplicate_wildcards);
            rewards.add(&pack.duplicate_wildcards);
            outcomes.push((code.clone(), pack.cards.len(), pack.duplicate_wildcards));
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
        *per_set_packs.entry(code.clone()).or_default() += quantity;
        let changed = sqlx::query(
            "UPDATE booster_pack_queue SET remaining=remaining-? WHERE id=? AND remaining>=?",
        )
        .bind(quantity)
        .bind(&id)
        .bind(quantity)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
        if changed != 1 {
            return Err("The queued pack balance changed. Retry the same opening.".into());
        }
        let changed = if source == "general" {
            sqlx::query("UPDATE league_state SET available_packs=available_packs-? WHERE id=1 AND available_packs>=?")
                .bind(quantity).bind(quantity).execute(&mut *transaction).await.map_err(|e| e.to_string())?.rows_affected()
        } else {
            sqlx::query("UPDATE set_booster_balances SET quantity=quantity-? WHERE set_code=? AND quantity>=?")
                .bind(quantity).bind(&code).bind(quantity).execute(&mut *transaction).await.map_err(|e| e.to_string())?.rows_affected()
        };
        if changed != 1 {
            return Err("The saved pack balance changed. Retry the same opening.".into());
        }
    }
    add_cards(&mut transaction, &mut cards).await?;
    add_wildcards(&mut transaction, &rewards).await?;
    let mut offset = 0;
    for (index, (code, size, duplicate_wildcards)) in outcomes.into_iter().enumerate() {
        let contents = PackContents {
            cards: cards[offset..offset + size].to_vec(),
            duplicate_wildcards,
        };
        offset += size;
        sqlx::query(
            "INSERT INTO booster_history(id,set_code,opened_at,contents_json) VALUES(?,?,?,?)",
        )
        .bind(format!("{request_id}:{index}"))
        .bind(code)
        .bind(timestamp(now)?)
        .bind(serde_json::to_string(&contents).map_err(|e| e.to_string())?)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    let result = BoosterOpening {
        id: request_id.into(),
        packs: count,
        set_code: if per_set_packs.len() == 1 {
            per_set_packs.keys().next().unwrap().clone()
        } else {
            "mixed".into()
        },
        per_set_packs,
        cards,
        wildcards: balances(&mut transaction).await?,
        duplicate_wildcards: duplicates,
    };
    save_receipt(&mut transaction, request_id, "open", &request, &result, now).await?;
    transaction
        .commit()
        .await
        .map_err(|e| format!("The booster opening was not saved: {e}"))?;
    Ok(result)
}

/// Reconcile a pending opening without granting rewards or creating an opening.
/// The immediate transaction waits for any active writer before inspecting its receipt.
pub async fn resolve_pool_booster_opening(
    pool: &SqlitePool,
    request_id: &str,
    count: i64,
    set_code: Option<&str>,
) -> Result<Option<BoosterOpening>, String> {
    valid_request_id(request_id)?;
    let request = if let Some(set_code) = set_code {
        if !(1..=100).contains(&count) {
            return Err("Open between 1 and 100 booster packs at a time.".into());
        }
        serde_json::json!({ "setCode": set_code.trim().to_lowercase(), "count": count }).to_string()
    } else {
        if !(0..=10_000).contains(&count) {
            return Err("Open between one and 10,000 packs, or use Open all.".into());
        }
        serde_json::json!({ "count": count }).to_string()
    };
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| error.to_string())?;
    let result = receipt(&mut transaction, request_id, "open", &request).await?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn resolve_booster_opening(
    app: AppHandle,
    request_id: String,
    count: i64,
    set_code: Option<String>,
) -> Result<Option<BoosterOpening>, String> {
    let _operation = database_mutation_guard()?;
    resolve_pool_booster_opening(
        &open_pool(&app).await?,
        &request_id,
        count,
        set_code.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn open_next_boosters(
    app: AppHandle,
    count: i64,
    request_id: String,
) -> Result<BoosterOpening, String> {
    let _operation = database_mutation_guard()?;
    open_next_pool_boosters(
        &open_pool(&app).await?,
        count,
        &request_id,
        crate::league_clock::effective_now(),
    )
    .await
}

#[cfg(test)]
pub async fn craft_pool(
    pool: &SqlitePool,
    card_id: &str,
    request_id: &str,
    now: i64,
) -> Result<CraftingResult, String> {
    craft_with_kind_pool(pool, card_id, request_id, now, None).await
}

pub async fn craft_with_kind_pool(
    pool: &SqlitePool,
    card_id: &str,
    request_id: &str,
    now: i64,
    wildcard_kind: Option<&str>,
) -> Result<CraftingResult, String> {
    valid_request_id(request_id)?;
    if wildcard_kind
        .is_some_and(|kind| !["common", "uncommon", "rare", "mythic", "discovery"].contains(&kind))
    {
        return Err("Choose a valid wildcard kind.".into());
    }
    let legacy_request = serde_json::json!({ "cardId": card_id }).to_string();
    let request = match wildcard_kind {
        Some(kind) => serde_json::json!({ "cardId": card_id, "wildcardKind": kind }).to_string(),
        None => legacy_request.clone(),
    };
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    // Replay successful pre-Discovery crafts even if the card is now owned or
    // at its limit. Explicit currency requests remain bound to their original kind.
    if let Some(saved) =
        sqlx::query("SELECT kind,request_json,result_json FROM progression_operations WHERE id=?")
            .bind(request_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?
    {
        let result: CraftingResult = serde_json::from_str(saved.get("result_json"))
            .map_err(|e| format!("Cannot read the saved operation receipt: {e}"))?;
        let saved_request: &str = saved.get("request_json");
        let legacy_retry = saved_request == legacy_request
            && wildcard_kind != Some("discovery")
            && wildcard_kind.is_none_or(|kind| kind == result.card.rarity);
        if saved.get::<&str, _>("kind") != "craft" || (saved_request != request && !legacy_retry) {
            return Err("This operation identifier was already used for a different request. Start a new action instead of changing a retry.".into());
        }
        transaction.commit().await.map_err(|e| e.to_string())?;
        return Ok(result);
    }
    let config = config(&mut transaction).await?;
    let state = state(&mut transaction, &config)
        .await?
        .ok_or("Begin your league before crafting cards.")?;
    reconcile_reward_entitlements(&mut transaction, &config, state).await?;
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
    let currency = wildcard_kind.unwrap_or(&card.rarity);
    if currency == "discovery" {
        if card.oracle_owned > 0 {
            return Err(
                "Discovery wildcards can only acquire the first copy of a card you do not own."
                    .into(),
            );
        }
    } else {
        if currency != card.rarity {
            return Err("Use a wildcard matching this printing's rarity.".into());
        }
        if card.oracle_owned < 1 {
            return Err("You must own this card before copying it with a rarity wildcard. Use a Discovery wildcard for its first copy.".into());
        }
    }
    let changed =
        sqlx::query("UPDATE wildcards SET quantity=quantity-1 WHERE rarity=? AND quantity>=1")
            .bind(currency)
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?
            .rows_affected();
    if changed != 1 {
        return Err(format!(
            "You need one {} wildcard to craft this printing.",
            currency
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
    automatic_status_pool(
        &open_pool(&app).await?,
        crate::league_clock::effective_now(),
    )
    .await
}
#[tauri::command]
pub async fn begin_league(app: AppHandle) -> Result<LeagueStatus, String> {
    let _operation = database_mutation_guard()?;
    begin_pool(
        &open_pool(&app).await?,
        crate::league_clock::effective_now(),
    )
    .await
}
#[tauri::command]
pub async fn claim_weekly_reward(app: AppHandle) -> Result<LeagueStatus, String> {
    let _operation = database_mutation_guard()?;
    claim_pool(
        &open_pool(&app).await?,
        crate::league_clock::effective_now(),
    )
    .await
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
        crate::league_clock::effective_now(),
    )
    .await
}
#[tauri::command]
pub async fn craft_card(
    app: AppHandle,
    card_id: String,
    request_id: String,
    wildcard_kind: Option<String>,
) -> Result<CraftingResult, String> {
    let _operation = database_mutation_guard()?;
    craft_with_kind_pool(
        &open_pool(&app).await?,
        &card_id,
        &request_id,
        crate::league_clock::effective_now(),
        wildcard_kind.as_deref(),
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
        sqlx::raw_sql(include_str!("../migrations/007_pack_queue.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../migrations/008_discovery_wildcards.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let settings = serde_json::json!({ "league": { "startedAt": NOW, "startingPacks": 2, "startingWildcards": {"common":0,"uncommon":0,"rare":0,"mythic":0}, "weeklyPacks": 4, "weeklyWildcards": { "common": 0, "uncommon": 0, "rare": 2, "mythic": 0 }, "enabledSets": ["tst"], "mythicProbability": 0.125 } });
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
        // Existing chronology fixtures intentionally retain the published legacy
        // amounts. Dedicated entitlement tests exercise the new production amounts.
        rules.starting_packs = 12;
        rules.weekly_packs = 4;
        rules.starting_wildcards = WildcardBalances::default();
        rules.weekly_wildcards.discovery = 0;
        rules.wildcard_reward_offsets = WildcardBalances::default();
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
    fn automatic_status_credits_four_weeks_once_and_keeps_shared_anchor() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            open_next_pool_boosters(&db.pool, 0, "initial-open", NOW)
                .await
                .unwrap();
            let before = status_pool(&db.pool, NOW).await.unwrap();
            let now = NOW + 4 * WEEK_SECONDS;
            let next = automatic_status_pool(&db.pool, now).await.unwrap();
            assert_eq!(next.available_packs, 24);
            assert_eq!(next.openable_packs, 24);
            assert_eq!(next.claimable_packs, 0);
            assert_eq!(next.started_at, NOW);
            assert_eq!(next.effective_now, timestamp(now).unwrap());
            assert_eq!(next.week, 5);
            assert!(next.enabled_sets.contains(&"blb".into()));
            assert_eq!(next.wildcards.common - before.wildcards.common, 16);
            assert_eq!(next.wildcards.uncommon - before.wildcards.uncommon, 8);
            assert_eq!(next.wildcards.rare - before.wildcards.rare, 2);
            assert_eq!(next.wildcards.mythic - before.wildcards.mythic, 1);
            let again = automatic_status_pool(&db.pool, now).await.unwrap();
            assert_eq!(again.available_packs, next.available_packs);
            assert_eq!(again.wildcards, next.wildcards);
        });
    }

    #[test]
    fn chronological_opening_spends_old_foundations_before_bloomburrow_bonus() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            open_next_pool_boosters(&db.pool, 0, "starting-open", NOW)
                .await
                .unwrap();
            let now = NOW + 4 * WEEK_SECONDS;
            automatic_status_pool(&db.pool, now).await.unwrap();
            let first = open_next_pool_boosters(&db.pool, 1, "first-weekly", now)
                .await
                .unwrap();
            assert_eq!(first.set_code, "fdn");
            let rest_old = open_next_pool_boosters(&db.pool, 11, "old-weeklies", now)
                .await
                .unwrap();
            assert_eq!(rest_old.per_set_packs, BTreeMap::from([("fdn".into(), 11)]));
            let first_new = open_next_pool_boosters(&db.pool, 1, "first-bonus", now)
                .await
                .unwrap();
            assert_eq!(first_new.set_code, "blb");
            let status = status_pool(&db.pool, now).await.unwrap();
            assert_eq!(status.general_packs, 4);
            assert_eq!(status.set_packs.get("blb"), Some(&7));
            let rest = open_next_pool_boosters(&db.pool, 0, "all-new", now)
                .await
                .unwrap();
            assert_eq!(rest.packs, 11);
            assert_eq!(rest.per_set_packs, BTreeMap::from([("blb".into(), 11)]));
        });
    }

    async fn reconciliation_snapshot(pool: &SqlitePool) -> Vec<(String, Vec<String>)> {
        let mut snapshot = Vec::new();
        for table in [
            "settings",
            "cards",
            "collection",
            "decks",
            "deck_cards",
            "wildcards",
            "booster_history",
            "league_state",
            "progression_operations",
            "booster_pack_queue",
            "set_booster_balances",
            "expansion_reward_claims",
        ] {
            let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
                .fetch_all(pool)
                .await
                .unwrap()
                .iter()
                .map(|row| format!("quote(\"{}\")", row.get::<String, _>("name")))
                .collect::<Vec<_>>()
                .join(" || '|' || ");
            let rows = sqlx::query_scalar::<_, String>(&format!(
                "SELECT {columns} FROM {table} ORDER BY 1"
            ))
            .fetch_all(pool)
            .await
            .unwrap();
            snapshot.push((table.to_owned(), rows));
        }
        snapshot
    }

    #[test]
    fn resolve_opening_replays_committed_open_all_without_new_week_accrual() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let opened = open_next_pool_boosters(&db.pool, 0, "resolve-all", NOW)
                .await
                .unwrap();
            let future = status_pool(&db.pool, NOW + WEEK_SECONDS).await.unwrap();
            assert!(future.can_claim_weekly);
            assert_eq!(future.available_packs, 0);
            let before = reconciliation_snapshot(&db.pool).await;
            let result = resolve_pool_booster_opening(&db.pool, "resolve-all", 0, None)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                serde_json::to_value(opened).unwrap()
            );
            assert_eq!(reconciliation_snapshot(&db.pool).await, before);
            let after = status_pool(&db.pool, NOW + WEEK_SECONDS).await.unwrap();
            assert_eq!(after.available_packs, 0);
            assert_eq!(after.wildcards, future.wildcards);
            assert!(after.can_claim_weekly);
        });
    }

    #[test]
    fn resolve_opening_matches_legacy_request_and_preserves_plain_mismatch_errors() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            let opened = open_pool_boosters(&db.pool, "TST", 1, "resolve-legacy", NOW)
                .await
                .unwrap();
            let before = reconciliation_snapshot(&db.pool).await;
            let result = resolve_pool_booster_opening(&db.pool, "resolve-legacy", 1, Some(" TST "))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                serde_json::to_value(opened).unwrap()
            );
            assert!(
                resolve_pool_booster_opening(&db.pool, "resolve-legacy", 1, None)
                    .await
                    .unwrap_err()
                    .contains("different request")
            );
            assert!(
                resolve_pool_booster_opening(&db.pool, "resolve-legacy", 2, Some("tst"))
                    .await
                    .unwrap_err()
                    .contains("different request")
            );
            assert_eq!(reconciliation_snapshot(&db.pool).await, before);
        });
    }

    #[test]
    fn resolve_opening_missing_receipt_never_starts_league_or_grants_packs() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let before = reconciliation_snapshot(&db.pool).await;
            assert!(
                resolve_pool_booster_opening(&db.pool, "resolve-missing", 0, None)
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(resolve_pool_booster_opening(
                &db.pool,
                "resolve-missing-legacy",
                1,
                Some("TST")
            )
            .await
            .unwrap()
            .is_none());
            assert_eq!(reconciliation_snapshot(&db.pool).await, before);
        });
    }

    #[test]
    fn resolve_opening_waits_for_inflight_commit_or_rollback() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        tauri::async_runtime::block_on(async {
            for commit in [false, true] {
                let db = fixture().await;
                let before = reconciliation_snapshot(&db.pool).await;
                let request_id = "resolve-inflight";
                let saved = BoosterOpening {
                    id: request_id.into(),
                    packs: 1,
                    per_set_packs: BTreeMap::new(),
                    set_code: "tst".into(),
                    cards: Vec::new(),
                    wildcards: WildcardBalances::default(),
                    duplicate_wildcards: WildcardBalances::default(),
                };
                let mut transaction = db.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
                save_receipt(
                    &mut transaction,
                    request_id,
                    "open",
                    &serde_json::json!({"count": 1}).to_string(),
                    &saved,
                    NOW,
                )
                .await
                .unwrap();
                let pool = db.pool.clone();
                let finished = Arc::new(AtomicBool::new(false));
                let finished_task = finished.clone();
                let (started, ready) = tokio::sync::oneshot::channel();
                let task = tauri::async_runtime::spawn(async move {
                    started.send(()).unwrap();
                    let result = resolve_pool_booster_opening(&pool, request_id, 1, None).await;
                    finished_task.store(true, Ordering::SeqCst);
                    result
                });
                ready.await.unwrap();
                std::thread::sleep(Duration::from_millis(80));
                assert!(
                    !finished.load(Ordering::SeqCst),
                    "reconciliation must wait for the writer"
                );
                if commit {
                    transaction.commit().await.unwrap();
                } else {
                    transaction.rollback().await.unwrap();
                }
                let settled = reconciliation_snapshot(&db.pool).await;
                let result = task.await.unwrap().unwrap();
                if commit {
                    assert_eq!(
                        serde_json::to_value(result.unwrap()).unwrap(),
                        serde_json::to_value(saved).unwrap()
                    );
                } else {
                    assert!(result.is_none());
                    assert_eq!(settled, before);
                }
                assert_eq!(reconciliation_snapshot(&db.pool).await, settled);
            }
        });
    }

    #[test]
    fn chronological_open_all_over_one_hundred_is_atomic_and_receipt_replays_mode() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let now = NOW + 30 * WEEK_SECONDS;
            let opened = open_next_pool_boosters(&db.pool, 0, "large-all", now)
                .await
                .unwrap();
            assert_eq!(opened.packs, 122);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM booster_history")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                122
            );
            assert_eq!(status_pool(&db.pool, now).await.unwrap().available_packs, 0);
            assert_eq!(
                serde_json::to_string(&opened).unwrap(),
                serde_json::to_string(
                    &open_next_pool_boosters(&db.pool, 0, "large-all", now + WEEK_SECONDS)
                        .await
                        .unwrap()
                )
                .unwrap()
            );
            assert_eq!(
                status_pool(&db.pool, now + WEEK_SECONDS)
                    .await
                    .unwrap()
                    .general_packs,
                0
            );
            assert_eq!(
                automatic_status_pool(&db.pool, now + WEEK_SECONDS)
                    .await
                    .unwrap()
                    .available_packs,
                4
            );
            assert!(open_next_pool_boosters(&db.pool, 1, "large-all", now)
                .await
                .is_err());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(quantity),0) FROM collection")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                4
            );
        });
    }

    #[test]
    fn chronological_open_failure_rolls_back_join_rewards_queue_and_history() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            sqlx::query("DELETE FROM cards WHERE set_code='blb' AND rarity='rare'")
                .execute(&db.pool)
                .await
                .unwrap();
            let now = NOW + 4 * WEEK_SECONDS;
            assert!(
                open_next_pool_boosters(&db.pool, 0, "repair-and-retry", now)
                    .await
                    .unwrap_err()
                    .contains("rare cards")
            );
            for table in [
                "league_state",
                "collection",
                "booster_history",
                "progression_operations",
                "booster_pack_queue",
                "expansion_reward_claims",
            ] {
                assert_eq!(
                    sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table}"))
                        .fetch_one(&db.pool)
                        .await
                        .unwrap(),
                    0,
                    "{table}"
                );
            }
            assert_eq!(
                status_pool(&db.pool, now).await.unwrap().wildcards,
                WildcardBalances::default()
            );
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,type_line) SELECT 'blb-' || id,'blb-' || oracle_id,name,'blb',collector_number,rarity,metadata_json,type_line FROM cards WHERE set_code='tst' AND rarity='rare'").execute(&db.pool).await.unwrap();
            let opened = open_next_pool_boosters(&db.pool, 0, "repair-and-retry", now)
                .await
                .unwrap();
            assert_eq!(opened.packs, 36);
            assert_eq!(opened.set_code, "mixed");
            assert_eq!(
                opened.per_set_packs,
                BTreeMap::from([("fdn".into(), 24), ("blb".into(), 12)])
            );
        });
    }

    #[test]
    fn legacy_pack_balances_backfill_without_losing_history_or_double_credit() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            sqlx::query("INSERT INTO league_state(id,started_at,available_packs,last_claimed_period) VALUES(1,?,3,4)").bind(NOW).execute(&db.pool).await.unwrap();
            sqlx::query("INSERT INTO set_booster_balances(set_code,quantity) VALUES('blb',2)")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO expansion_reward_claims(set_code,week,quantity,claimed_at) VALUES('blb',4,8,'old')").execute(&db.pool).await.unwrap();
            sqlx::query("INSERT INTO booster_history(id,set_code,opened_at,contents_json) VALUES('old-history','fdn','old','[]')").execute(&db.pool).await.unwrap();
            let now = NOW + 4 * WEEK_SECONDS;
            assert_eq!(
                automatic_status_pool(&db.pool, now)
                    .await
                    .unwrap()
                    .available_packs,
                5
            );
            assert_eq!(
                automatic_status_pool(&db.pool, now)
                    .await
                    .unwrap()
                    .available_packs,
                5
            );
            let first = open_next_pool_boosters(&db.pool, 1, "legacy-first", now)
                .await
                .unwrap();
            assert_eq!(first.set_code, "fdn");
            let rest = open_next_pool_boosters(&db.pool, 0, "legacy-rest", now)
                .await
                .unwrap();
            assert_eq!(
                rest.per_set_packs,
                BTreeMap::from([("fdn".into(), 2), ("blb".into(), 2)])
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM booster_history")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                6
            );
        });
    }

    #[test]
    fn concurrent_chronological_open_all_cannot_spend_the_same_packs_twice() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            let a = db.pool.clone();
            let b = db.pool.clone();
            let one = tokio::spawn(async move {
                open_next_pool_boosters(&a, 0, "concurrent-next-a", NOW).await
            });
            let two = tokio::spawn(async move {
                open_next_pool_boosters(&b, 0, "concurrent-next-b", NOW).await
            });
            let results = [one.await.unwrap(), two.await.unwrap()];
            assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM booster_history")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                2
            );
        });
    }

    #[test]
    fn legacy_and_chronological_openers_share_one_queue_balance() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            open_pool_boosters(&db.pool, "tst", 1, "old-api", NOW)
                .await
                .unwrap();
            let result = open_next_pool_boosters(&db.pool, 0, "new-api", NOW)
                .await
                .unwrap();
            assert_eq!(result.packs, 1);
            assert_eq!(status_pool(&db.pool, NOW).await.unwrap().available_packs, 0);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT SUM(remaining) FROM booster_pack_queue")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
        });
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
            assert!(validate_pools(&pools, &config.booster, "tst").is_ok());
            config.booster.basic_lands = 1;
            assert!(validate_pools(&pools, &config.booster, "tst")
                .unwrap_err()
                .contains("freely available"));
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
            sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('r',1)")
                .execute(&db.pool)
                .await
                .unwrap();
            let result = craft_pool(&db.pool, "r", "craft-once", NOW).await.unwrap();
            assert_eq!(result.card.owned, 2);
            assert_eq!(result.wildcards.rare, 0);
            assert_eq!(
                craft_pool(&db.pool, "r", "craft-once", NOW + 1)
                    .await
                    .unwrap()
                    .card
                    .owned,
                2
            );
            assert!(craft_pool(&db.pool, "r", "craft-no-wildcards", NOW)
                .await
                .is_err());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='r'")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                2
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
    fn exhausted_mythics_keep_their_rarity_and_basic_slots_are_rejected_without_spending() {
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
                ..BoosterConfig::default()
            };
            config.mythic_probability = 1.0;
            let mut owned = HashMap::from([("m".into(), 4)]);
            let pack = generate_pack(&pools, &config, &mut owned, &mut StdRng::seed_from_u64(3));
            assert!(pack.cards.is_empty());
            assert_eq!(pack.duplicate_wildcards.mythic, 1);
            assert_eq!(pack.duplicate_wildcards.rare, 0);
            drop(connection);
            begin_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("UPDATE settings SET value=json_set(value,'$.league.booster.commons',0,'$.league.booster.uncommons',0,'$.league.booster.rareSlots',0,'$.league.booster.basicLands',5) WHERE key='app'").execute(&db.pool).await.unwrap();
            let error = open_pool_boosters(&db.pool, "tst", 1, "free-land-slots", NOW)
                .await
                .unwrap_err();
            assert!(error.contains("freely available"));
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT available_packs FROM league_state WHERE id=1")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                2
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM booster_history")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collection")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
        });
    }

    fn recipe_card(id: &str, rarity: &str, kind: &str) -> CatalogCard {
        CatalogCard {
            id: id.into(),
            oracle_id: id.into(),
            name: id.into(),
            set_code: "tst".into(),
            set_name: "Test".into(),
            collector_number: id.into(),
            rarity: rarity.into(),
            mana_cost: String::new(),
            cmc: 0.0,
            type_line: kind.into(),
            oracle_text: String::new(),
            colors: Vec::new(),
            image_uri: None,
            back_image_uri: None,
            owned: 0,
            oracle_owned: 0,
            forge_set_code: None,
        }
    }

    fn current_reward_rules() -> LeagueConfig {
        let mut rules = crate::league_rules::builtin_rules().unwrap();
        rules.started_at = NOW;
        rules.enabled_sets = vec!["tst".into()];
        rules.expansion_schedule.clear();
        rules.auto_unlock = AutoUnlock::default();
        rules
    }

    async fn set_reward_rules(pool: &SqlitePool, rules: &LeagueConfig) {
        sqlx::query("UPDATE settings SET value=? WHERE key='app'")
            .bind(serde_json::json!({"league":rules}).to_string())
            .execute(pool)
            .await
            .unwrap();
    }

    async fn legacy_reward_profile() -> TestDatabase {
        let db = fixture().await;
        let mut old = current_reward_rules();
        old.starting_packs = 12;
        old.weekly_packs = 4;
        old.starting_wildcards = WildcardBalances::default();
        old.weekly_wildcards.discovery = 0;
        old.wildcard_reward_offsets = WildcardBalances::default();
        set_reward_rules(&db.pool, &old).await;
        begin_pool(&db.pool, NOW).await.unwrap();
        claim_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
        open_pool_boosters(&db.pool, "tst", 1, "already-spent", NOW + 4 * WEEK_SECONDS)
            .await
            .unwrap();
        sqlx::query("INSERT INTO decks(id,name) VALUES('preserved-deck','Preserve this deck')")
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO deck_cards(deck_id,card_id,section,quantity) VALUES('preserved-deck','c','main',1)").execute(&db.pool).await.unwrap();
        // A released legacy binary had no entitlement ledger.
        sqlx::query("DELETE FROM settings WHERE key=?")
            .bind(REWARD_ENTITLEMENTS_KEY)
            .execute(&db.pool)
            .await
            .unwrap();
        db
    }

    async fn owned_reward_snapshot(
        pool: &SqlitePool,
    ) -> (Vec<(String, i64)>, String, String, String) {
        let cards = sqlx::query_as("SELECT card_id,quantity FROM collection ORDER BY card_id")
            .fetch_all(pool)
            .await
            .unwrap();
        let history = sqlx::query_scalar("SELECT COALESCE(json_group_array(contents_json),'[]') FROM (SELECT contents_json FROM booster_history ORDER BY id)").fetch_one(pool).await.unwrap();
        let receipts = sqlx::query_scalar("SELECT COALESCE(json_group_array(result_json),'[]') FROM (SELECT result_json FROM progression_operations ORDER BY id)").fetch_one(pool).await.unwrap();
        let decks = sqlx::query_scalar("SELECT COALESCE(json_group_array(json_object('id',d.id,'name',d.name,'card',dc.card_id,'section',dc.section,'quantity',dc.quantity)),'[]') FROM decks d LEFT JOIN deck_cards dc ON dc.deck_id=d.id ORDER BY d.id,dc.card_id").fetch_one(pool).await.unwrap();
        (cards, history, receipts, decks)
    }

    #[test]
    fn reward_upgrade_adds_only_missing_entitlements_once_without_rewriting_spends() {
        tauri::async_runtime::block_on(async {
            let db = legacy_reward_profile().await;
            let old = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            let preserved = owned_reward_snapshot(&db.pool).await;
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            let updated = automatic_status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(updated.general_packs, old.general_packs + 8 + 2 * 4);
            assert_eq!(updated.wildcards.common, old.wildcards.common + 10);
            assert_eq!(updated.wildcards.uncommon, old.wildcards.uncommon + 5);
            assert_eq!(updated.wildcards.rare, old.wildcards.rare + 2);
            assert_eq!(updated.wildcards.mythic, old.wildcards.mythic + 1);
            assert_eq!(owned_reward_snapshot(&db.pool).await, preserved);
            let again = automatic_status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(again.general_packs, updated.general_packs);
            assert_eq!(again.wildcards, updated.wildcards);
            assert_eq!(
                begin_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap()
                    .general_packs,
                updated.general_packs
            );
            let ledger: String = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
                .bind(REWARD_ENTITLEMENTS_KEY)
                .fetch_one(&db.pool)
                .await
                .unwrap();
            let ledger: RewardEntitlements = serde_json::from_str(&ledger).unwrap();
            assert_eq!(ledger.starting_packs, 20);
            assert_eq!(ledger.weekly_packs, 6);
            assert_eq!(
                ledger.starting_wildcards,
                WildcardBalances {
                    common: 10,
                    uncommon: 5,
                    rare: 2,
                    mythic: 1,
                    discovery: 1,
                }
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT SUM(remaining) FROM booster_pack_queue WHERE source='general'"
                )
                .fetch_one(&db.pool)
                .await
                .unwrap(),
                updated.general_packs
            );
        });
    }

    #[test]
    fn current_new_and_late_players_receive_identical_entitlements_and_initial_preview() {
        tauri::async_runtime::block_on(async {
            let early = fixture().await;
            let late = fixture().await;
            let rules = current_reward_rules();
            for db in [&early, &late] {
                set_reward_rules(&db.pool, &rules).await;
            }
            let preview = status_pool(&late.pool, NOW).await.unwrap();
            assert_eq!(preview.join_packs, 20);
            assert_eq!(preview.join_wildcards, rules.starting_wildcards);
            let started = automatic_status_pool(&early.pool, NOW).await.unwrap();
            assert!(started.started);
            assert_eq!(started.general_packs, 20);
            assert_eq!(started.wildcards, rules.starting_wildcards);
            assert!(started.history.is_empty());
            assert!(owned_reward_snapshot(&early.pool).await.0.is_empty());
            for week in 1..=4 {
                automatic_status_pool(&early.pool, NOW + week * WEEK_SECONDS)
                    .await
                    .unwrap();
            }
            let preview = status_pool(&late.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(preview.join_packs, 44);
            assert_eq!(
                preview.join_wildcards,
                WildcardBalances {
                    common: 26,
                    uncommon: 13,
                    rare: 4,
                    mythic: 2,
                    discovery: 2,
                }
            );
            let late = automatic_status_pool(&late.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            let early = automatic_status_pool(&early.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(late.general_packs, 44);
            assert_eq!(late.general_packs, early.general_packs);
            assert_eq!(late.wildcards, early.wildcards);
        });
    }

    #[test]
    fn first_use_allows_crafting_before_opening_and_does_not_refill_spent_rewards_on_restart() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            automatic_status_pool(&db.pool, NOW).await.unwrap();
            let crafted =
                craft_with_kind_pool(&db.pool, "c", "first-use-craft", NOW, Some("discovery"))
                    .await
                    .unwrap();
            assert_eq!(crafted.wildcards.common, 10);
            assert_eq!(crafted.wildcards.discovery, 0);
            let before = reconciliation_snapshot(&db.pool).await;
            db.pool.close().await;
            let reopened = SqlitePoolOptions::new()
                .connect_with(
                    SqliteConnectOptions::new()
                        .filename(db._directory.path().join("league.db"))
                        .foreign_keys(true),
                )
                .await
                .unwrap();
            let again = automatic_status_pool(&reopened, NOW).await.unwrap();
            assert_eq!(again.general_packs, 20);
            assert_eq!(again.wildcards, crafted.wildcards);
            assert!(again.history.is_empty());
            assert_eq!(reconciliation_snapshot(&reopened).await, before);
            reopened.close().await;
        });
    }

    #[test]
    fn first_use_preserves_existing_first_opening_grant_spends_and_receipts_exactly() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let mut rules = current_reward_rules();
            rules.mythic_probability = 0.0;
            set_reward_rules(&db.pool, &rules).await;
            // Reproduce the released app: the first opening granted rewards.
            open_next_pool_boosters(&db.pool, 1, "released-first-opening", NOW)
                .await
                .unwrap();
            craft_pool(&db.pool, "r", "spent-starting-rare", NOW)
                .await
                .unwrap();
            let before = status_pool(&db.pool, NOW).await.unwrap();
            let snapshot = reconciliation_snapshot(&db.pool).await;
            for _ in 0..3 {
                let after = automatic_status_pool(&db.pool, NOW).await.unwrap();
                assert_eq!(after.general_packs, 19);
                assert_eq!(after.wildcards, before.wildcards);
                assert_eq!(reconciliation_snapshot(&db.pool).await, snapshot);
            }
        });
    }

    #[test]
    fn first_use_with_production_rules_catches_up_every_due_reward_without_a_catalog() {
        tauri::async_runtime::block_on(async {
            let early = fixture().await;
            sqlx::query("DELETE FROM settings WHERE key='test.allow-league-settings'")
                .execute(&early.pool)
                .await
                .unwrap();
            let rules = crate::league_rules::builtin_rules().unwrap();
            for week in [0, 1, 2, 3, 4, 8, 12, 53] {
                let late = fixture().await;
                sqlx::query("DELETE FROM settings WHERE key='test.allow-league-settings'")
                    .execute(&late.pool)
                    .await
                    .unwrap();
                sqlx::query("DELETE FROM cards")
                    .execute(&late.pool)
                    .await
                    .unwrap();
                let now = rules.started_at + week * WEEK_SECONDS;
                let veteran = automatic_status_pool(&early.pool, now).await.unwrap();
                let newcomer = automatic_status_pool(&late.pool, now).await.unwrap();
                let expected_sets: BTreeMap<String, i64> = rules
                    .expansion_schedule
                    .iter()
                    .filter(|entry| entry.week <= week && entry.bonus_packs > 0)
                    .map(|entry| (entry.code.to_lowercase(), entry.bonus_packs))
                    .collect();
                assert!(newcomer.started);
                assert_eq!(newcomer.started_at, rules.started_at);
                assert_eq!(newcomer.general_packs, 20 + 6 * week);
                assert_eq!(newcomer.set_packs, expected_sets);
                assert_eq!(
                    newcomer.available_packs,
                    20 + 6 * week + expected_sets.values().sum::<i64>()
                );
                assert_eq!(
                    newcomer.wildcards,
                    WildcardBalances {
                        common: 10 + 4 * week,
                        uncommon: 5 + 2 * week,
                        rare: 2 + week / 2,
                        mythic: 1 + (week + 2) / 4,
                        discovery: 1 + week / 4,
                    }
                );
                assert_eq!(newcomer.available_packs, veteran.available_packs);
                assert_eq!(newcomer.wildcards, veteran.wildcards);
                assert_eq!(newcomer.enabled_sets, veteran.enabled_sets);
                assert!(newcomer.history.is_empty());
                let snapshot = reconciliation_snapshot(&late.pool).await;
                automatic_status_pool(&late.pool, now).await.unwrap();
                assert_eq!(reconciliation_snapshot(&late.pool).await, snapshot);
            }
        });
    }

    #[test]
    fn concurrent_first_use_grants_once_and_failed_initial_grant_rolls_back_before_retry() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            sqlx::raw_sql("CREATE TRIGGER reject_initial_ledger BEFORE INSERT ON settings WHEN NEW.key='league_reward_entitlements_v1' BEGIN SELECT RAISE(ABORT,'test initial grant failure'); END;")
                .execute(&db.pool).await.unwrap();
            let before = reconciliation_snapshot(&db.pool).await;
            assert!(automatic_status_pool(&db.pool, NOW)
                .await
                .unwrap_err()
                .contains("test initial grant failure"));
            assert_eq!(reconciliation_snapshot(&db.pool).await, before);
            sqlx::raw_sql("DROP TRIGGER reject_initial_ledger")
                .execute(&db.pool)
                .await
                .unwrap();
            let first = db.pool.clone();
            let second = db.pool.clone();
            let a = tokio::spawn(async move { automatic_status_pool(&first, NOW).await });
            let b = tokio::spawn(async move { automatic_status_pool(&second, NOW).await });
            for result in [a.await.unwrap().unwrap(), b.await.unwrap().unwrap()] {
                assert_eq!(result.general_packs, 20);
                assert_eq!(result.wildcards, current_reward_rules().starting_wildcards);
                assert!(result.history.is_empty());
            }
        });
    }

    #[test]
    fn automatic_first_use_waits_for_the_shared_start_without_an_error_or_early_grant() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            let before = automatic_status_pool(&db.pool, NOW - 1).await.unwrap();
            assert!(!before.started);
            assert_eq!(before.available_packs, 0);
            assert_eq!(before.wildcards, WildcardBalances::default());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM settings WHERE key=?")
                    .bind(REWARD_ENTITLEMENTS_KEY)
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                0
            );
            let started = automatic_status_pool(&db.pool, NOW).await.unwrap();
            assert!(started.started);
            assert_eq!(started.general_packs, 20);
            assert_eq!(started.wildcards, current_reward_rules().starting_wildcards);
        });
    }

    #[test]
    fn direct_legacy_open_reconciles_spent_balance_before_checking_packs_and_replays_once() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let mut old = current_reward_rules();
            old.starting_packs = 12;
            old.weekly_packs = 4;
            old.starting_wildcards = WildcardBalances::default();
            set_reward_rules(&db.pool, &old).await;
            begin_pool(&db.pool, NOW).await.unwrap();
            open_pool_boosters(&db.pool, "tst", 12, "spent-starting-packs", NOW)
                .await
                .unwrap();
            sqlx::query("DELETE FROM settings WHERE key=?")
                .bind(REWARD_ENTITLEMENTS_KEY)
                .execute(&db.pool)
                .await
                .unwrap();
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            let opened = open_pool_boosters(&db.pool, "tst", 1, "first-upgraded-open", NOW)
                .await
                .unwrap();
            assert_eq!(opened.packs, 1);
            let after = status_pool(&db.pool, NOW).await.unwrap();
            assert_eq!(after.general_packs, 7);
            let snapshot = reconciliation_snapshot(&db.pool).await;
            let replay = open_pool_boosters(&db.pool, "tst", 1, "first-upgraded-open", NOW)
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(opened).unwrap(),
                serde_json::to_value(replay).unwrap()
            );
            assert_eq!(reconciliation_snapshot(&db.pool).await, snapshot);
        });
    }

    #[test]
    fn direct_legacy_claim_commits_reward_adjustments_without_another_week_due() {
        tauri::async_runtime::block_on(async {
            for credited_weeks in [0, 4] {
                let db = fixture().await;
                let mut old = current_reward_rules();
                old.starting_packs = 12;
                old.weekly_packs = 4;
                old.starting_wildcards = WildcardBalances::default();
                set_reward_rules(&db.pool, &old).await;
                begin_pool(&db.pool, NOW).await.unwrap();
                let now = NOW + credited_weeks * WEEK_SECONDS;
                if credited_weeks > 0 {
                    claim_pool(&db.pool, now).await.unwrap();
                }
                sqlx::query("DELETE FROM settings WHERE key=?")
                    .bind(REWARD_ENTITLEMENTS_KEY)
                    .execute(&db.pool)
                    .await
                    .unwrap();
                let before = status_pool(&db.pool, now).await.unwrap();
                set_reward_rules(&db.pool, &current_reward_rules()).await;
                let updated = claim_pool(&db.pool, now).await.unwrap();
                assert_eq!(
                    updated.general_packs,
                    before.general_packs + 8 + 2 * credited_weeks
                );
                assert_eq!(updated.wildcards.common, before.wildcards.common + 10);
                assert!(claim_pool(&db.pool, now).await.is_err());
                let again = status_pool(&db.pool, now).await.unwrap();
                assert_eq!(again.general_packs, updated.general_packs);
                assert_eq!(again.wildcards, updated.wildcards);
            }
        });
    }

    #[test]
    fn concurrent_reward_upgrade_claims_share_one_adjustment() {
        tauri::async_runtime::block_on(async {
            let db = legacy_reward_profile().await;
            let before = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            let first = db.pool.clone();
            let second = db.pool.clone();
            let a =
                tokio::spawn(
                    async move { automatic_status_pool(&first, NOW + 4 * WEEK_SECONDS).await },
                );
            let b = tokio::spawn(async move {
                automatic_status_pool(&second, NOW + 4 * WEEK_SECONDS).await
            });
            let a = a.await.unwrap().unwrap();
            let b = b.await.unwrap().unwrap();
            assert_eq!(a.general_packs, b.general_packs);
            assert_eq!(a.general_packs, before.general_packs + 16);
            assert_eq!(a.wildcards, b.wildcards);
        });
    }

    #[test]
    fn reward_upgrade_failure_rolls_back_balances_queue_and_ledger_then_retries() {
        tauri::async_runtime::block_on(async {
            let db = legacy_reward_profile().await;
            let before = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            let queued: i64 = sqlx::query_scalar("SELECT SUM(remaining) FROM booster_pack_queue")
                .fetch_one(&db.pool)
                .await
                .unwrap();
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            sqlx::raw_sql("CREATE TRIGGER reject_reward_ledger BEFORE INSERT ON settings WHEN NEW.key='league_reward_entitlements_v1' BEGIN SELECT RAISE(ABORT,'test ledger failure'); END;").execute(&db.pool).await.unwrap();
            assert!(automatic_status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap_err()
                .contains("test ledger failure"));
            let after = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            assert_eq!(after.general_packs, before.general_packs);
            assert_eq!(after.wildcards, before.wildcards);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT SUM(remaining) FROM booster_pack_queue")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                queued
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM settings WHERE key='league_reward_entitlements_v1'"
                )
                .fetch_one(&db.pool)
                .await
                .unwrap(),
                0
            );
            sqlx::raw_sql("DROP TRIGGER reject_reward_ledger")
                .execute(&db.pool)
                .await
                .unwrap();
            assert_eq!(
                automatic_status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap()
                    .general_packs,
                before.general_packs + 16
            );
        });
    }

    #[test]
    fn reward_upgrade_rejects_corrupt_ledger_and_never_subtracts_lower_entitlements() {
        tauri::async_runtime::block_on(async {
            let db = legacy_reward_profile().await;
            let before = status_pool(&db.pool, NOW + 4 * WEEK_SECONDS).await.unwrap();
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            for value in [
                "not-json",
                "{}",
                r#"{"version":2,"startingPacks":12,"weeklyPacks":4,"startingWildcards":{"common":0,"uncommon":0,"rare":0,"mythic":0}}"#,
            ] {
                sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(REWARD_ENTITLEMENTS_KEY).bind(value).execute(&db.pool).await.unwrap();
                assert!(automatic_status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap_err()
                    .contains("ledger is invalid"));
                assert_eq!(
                    status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                        .await
                        .unwrap()
                        .general_packs,
                    before.general_packs
                );
            }
            sqlx::query("DELETE FROM settings WHERE key=?")
                .bind(REWARD_ENTITLEMENTS_KEY)
                .execute(&db.pool)
                .await
                .unwrap();
            let mut lower = current_reward_rules();
            lower.starting_packs = 0;
            lower.weekly_packs = 0;
            lower.starting_wildcards = WildcardBalances::default();
            lower.weekly_wildcards.discovery = 0;
            lower.wildcard_reward_offsets = WildcardBalances::default();
            set_reward_rules(&db.pool, &lower).await;
            let same = automatic_status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(same.general_packs, before.general_packs);
            assert_eq!(same.wildcards, before.wildcards);
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            assert_eq!(
                automatic_status_pool(&db.pool, NOW + 4 * WEEK_SECONDS)
                    .await
                    .unwrap()
                    .general_packs,
                before.general_packs + 16
            );
        });
    }

    #[test]
    fn reward_upgrade_queue_retains_historical_set_assignment_and_bonus_balances() {
        tauri::async_runtime::block_on(async {
            let db = scheduled_fixture().await;
            begin_pool(&db.pool, NOW).await.unwrap();
            let old = claim_pool(&db.pool, NOW + 6 * WEEK_SECONDS).await.unwrap();
            sqlx::query("DELETE FROM settings WHERE key=?")
                .bind(REWARD_ENTITLEMENTS_KEY)
                .execute(&db.pool)
                .await
                .unwrap();
            let mut rules = crate::league_rules::builtin_rules().unwrap();
            rules.started_at = NOW;
            set_reward_rules(&db.pool, &rules).await;
            let updated = automatic_status_pool(&db.pool, NOW + 6 * WEEK_SECONDS)
                .await
                .unwrap();
            assert_eq!(updated.general_packs, old.general_packs + 20);
            assert_eq!(updated.set_packs, old.set_packs);
            let adjustments: Vec<(String,i64,i64,i64)> = sqlx::query_as("SELECT set_code,earned_period,priority,remaining FROM booster_pack_queue WHERE id LIKE 'reward-adjustment:%' ORDER BY earned_period,priority,id").fetch_all(&db.pool).await.unwrap();
            assert_eq!(
                adjustments,
                vec![
                    ("fdn".into(), 0, 0, 8),
                    ("fdn".into(), 1, 1, 6),
                    ("blb".into(), 4, 1, 6)
                ]
            );
        });
    }

    fn recipe_config(commons: i64, uncommons: i64, rare_slots: i64) -> LeagueConfig {
        LeagueConfig {
            booster: BoosterConfig {
                commons,
                uncommons,
                rare_slots,
                ..BoosterConfig::default()
            },
            ..LeagueConfig::default()
        }
    }

    #[test]
    fn booster_land_weight_and_limits_validate_without_allowing_basic_slots() {
        let mut config = recipe_config(10, 4, 1);
        for weight in [f64::NAN, f64::INFINITY, 0.0, -0.5, 1.01] {
            config.booster.common_land_weight = weight;
            assert!(validate_config(&config).is_err());
        }
        for weight in [0.5, 1.0] {
            config.booster.common_land_weight = weight;
            assert!(validate_config(&config).is_ok());
        }
        for limit in [-1, 101] {
            config.booster.preferred_land_limit = limit;
            assert!(validate_config(&config).is_err());
        }
        for limit in [0, 1, 100] {
            config.booster.preferred_land_limit = limit;
            assert!(validate_config(&config).is_ok());
        }
        config.booster.basic_lands = 1;
        assert!(validate_config(&config)
            .unwrap_err()
            .contains("freely available"));
    }

    #[test]
    fn booster_land_classification_uses_front_card_type_and_keeps_typed_nonbasics() {
        for kind in [
            "Land — Island Swamp",
            "Legendary Snow Land",
            "Artifact Land",
            "Land Creature — Dryad",
        ] {
            assert!(
                is_nonbasic_booster_land(&recipe_card("land", "common", kind)),
                "{kind}"
            );
        }
        for kind in [
            "Basic Land — Forest",
            "Basic Snow Land — Island",
            "Sorcery // Land",
            "Creature — Human",
        ] {
            assert!(
                !is_nonbasic_booster_land(&recipe_card("spell", "common", kind)),
                "{kind}"
            );
        }
    }

    #[test]
    fn weighted_land_identities_ignore_artwork_variant_counts() {
        let common = vec![
            recipe_card("spell", "common", "Creature"),
            recipe_card("land", "common", "Land"),
        ];
        let mut variants = common.clone();
        for index in 0..40 {
            let mut variant = common[1].clone();
            variant.id = format!("land-art-{index}");
            variants.push(variant);
        }
        let pools = BoosterPools {
            common,
            ..BoosterPools::default()
        };
        let variants = BoosterPools {
            common: variants,
            ..BoosterPools::default()
        };
        let config = recipe_config(1, 0, 0);
        let mut lands = 0;
        for seed in 0..3000 {
            let first = generate_pack(
                &pools,
                &config,
                &mut HashMap::new(),
                &mut StdRng::seed_from_u64(seed),
            );
            let artwork = generate_pack(
                &variants,
                &config,
                &mut HashMap::new(),
                &mut StdRng::seed_from_u64(seed),
            );
            assert_eq!(first.cards[0].oracle_id, artwork.cards[0].oracle_id);
            lands += usize::from(is_nonbasic_booster_land(&first.cards[0]));
        }
        assert!(
            (800..1200).contains(&lands),
            "half weight should select a land about one-third of one-slot packs: {lands}"
        );
    }

    #[test]
    fn global_recipe_keeps_fifteen_slots_and_reduces_foundations_shaped_land_pool() {
        let mut pools = BoosterPools::default();
        for index in 0..80 {
            pools
                .common
                .push(recipe_card(&format!("c-{index}"), "common", "Creature"));
        }
        for index in 0..10 {
            pools
                .common
                .push(recipe_card(&format!("land-{index}"), "common", "Land"));
        }
        for index in 0..20 {
            pools
                .uncommon
                .push(recipe_card(&format!("u-{index}"), "uncommon", "Creature"));
        }
        pools
            .rare
            .push(recipe_card("rare-spell", "rare", "Creature"));
        pools
            .mythic
            .push(recipe_card("mythic-spell", "mythic", "Creature"));
        let config = recipe_config(10, 4, 1);
        let mut common_lands = 0;
        let mut mythics = 0;
        for seed in 0..2000 {
            let pack = generate_pack(
                &pools,
                &config,
                &mut HashMap::new(),
                &mut StdRng::seed_from_u64(seed),
            );
            assert_eq!(pack.cards.len(), 15);
            assert_eq!(pack.duplicate_wildcards, WildcardBalances::default());
            assert_eq!(
                pack.cards
                    .iter()
                    .map(|card| &card.oracle_id)
                    .collect::<HashSet<_>>()
                    .len(),
                15
            );
            let lands = pack
                .cards
                .iter()
                .filter(|card| card.rarity == "common" && is_nonbasic_booster_land(card))
                .count();
            assert!(lands <= 1);
            common_lands += lands;
            assert_eq!(
                pack.cards
                    .iter()
                    .filter(|card| matches!(card.rarity.as_str(), "rare" | "mythic"))
                    .count(),
                1
            );
            mythics += usize::from(pack.cards.iter().any(|card| card.rarity == "mythic"));
        }
        let mean = common_lands as f64 / 2000.0;
        assert!(
            (0.40..0.55).contains(&mean),
            "common lands per pack: {mean}"
        );
        assert!(
            (190..310).contains(&mythics),
            "mythic rarity roll must stay near 12.5%: {mythics}"
        );
        eprintln!("seeded 2000-pack Foundations-shaped pool: {mean:.4} common lands/pack, {mythics} mythics");
    }

    #[test]
    fn nonbasic_land_preference_is_shared_by_commons_and_uncommons() {
        let mut pools = BoosterPools::default();
        for rarity in ["common", "uncommon"] {
            for index in 0..20 {
                let pool = if rarity == "common" {
                    &mut pools.common
                } else {
                    &mut pools.uncommon
                };
                pool.push(recipe_card(
                    &format!("{rarity}-{index}"),
                    rarity,
                    if index < 5 { "Land" } else { "Creature" },
                ));
            }
        }
        for limit in [0, 1] {
            let mut config = recipe_config(4, 4, 0);
            config.booster.preferred_land_limit = limit;
            for seed in 0..200 {
                let pack = generate_pack(
                    &pools,
                    &config,
                    &mut HashMap::new(),
                    &mut StdRng::seed_from_u64(seed),
                );
                assert_eq!(pack.cards.len(), 8);
                assert!(
                    pack.cards
                        .iter()
                        .filter(|card| is_nonbasic_booster_land(card))
                        .count()
                        <= limit as usize
                );
            }
        }
    }

    #[test]
    fn land_and_pack_diversity_preferences_never_award_wildcards_before_rarity_completion() {
        let pools = BoosterPools {
            common: vec![
                recipe_card("land", "common", "Land"),
                recipe_card("spell", "common", "Creature"),
            ],
            ..BoosterPools::default()
        };
        let config = recipe_config(10, 0, 0);
        let mut owned = HashMap::from([("spell".into(), 4)]);
        let pack = generate_pack(&pools, &config, &mut owned, &mut StdRng::seed_from_u64(4));
        assert_eq!(pack.cards.len(), 4);
        assert!(pack.cards.iter().all(is_nonbasic_booster_land));
        assert_eq!(pack.duplicate_wildcards.common, 6);
        assert_eq!(owned["land"], 4);
        let mut owned = HashMap::new();
        let pack = generate_pack(&pools, &config, &mut owned, &mut StdRng::seed_from_u64(5));
        assert_eq!(pack.cards.len(), 8);
        assert_eq!(pack.duplicate_wildcards.common, 2);
        assert!(owned.values().all(|quantity| *quantity == 4));
    }

    #[test]
    fn uncommon_land_identity_odds_remain_normal_while_commons_are_half_weighted() {
        let pools = BoosterPools {
            common: vec![
                recipe_card("c-land", "common", "Land"),
                recipe_card("c-spell", "common", "Creature"),
            ],
            uncommon: vec![
                recipe_card("u-land", "uncommon", "Land"),
                recipe_card("u-spell", "uncommon", "Creature"),
            ],
            ..BoosterPools::default()
        };
        let mut common_lands = 0;
        let mut uncommon_lands = 0;
        for seed in 0..3000 {
            for (config, lands) in [
                (recipe_config(1, 0, 0), &mut common_lands),
                (recipe_config(0, 1, 0), &mut uncommon_lands),
            ] {
                let pack = generate_pack(
                    &pools,
                    &config,
                    &mut HashMap::new(),
                    &mut StdRng::seed_from_u64(seed),
                );
                *lands += usize::from(is_nonbasic_booster_land(&pack.cards[0]));
            }
        }
        assert!(
            (800..1200).contains(&common_lands),
            "common land hits: {common_lands}"
        );
        assert!(
            (1350..1650).contains(&uncommon_lands),
            "uncommon land hits: {uncommon_lands}"
        );
    }

    #[test]
    fn rare_and_mythic_lands_get_the_shared_land_preference_before_lower_rarities() {
        let mut pools = BoosterPools::default();
        for (rarity, count) in [("common", 20), ("uncommon", 10)] {
            for index in 0..count {
                let card = recipe_card(
                    &format!("{rarity}-{index}"),
                    rarity,
                    if index < 5 { "Land" } else { "Creature" },
                );
                if rarity == "common" {
                    pools.common.push(card);
                } else {
                    pools.uncommon.push(card);
                }
            }
        }
        pools.rare.push(recipe_card("rare-land", "rare", "Land"));
        pools
            .mythic
            .push(recipe_card("mythic-land", "mythic", "Land"));
        for probability in [0.0, 1.0] {
            let mut config = recipe_config(10, 4, 1);
            config.mythic_probability = probability;
            for seed in 0..100 {
                let pack = generate_pack(
                    &pools,
                    &config,
                    &mut HashMap::new(),
                    &mut StdRng::seed_from_u64(seed),
                );
                assert_eq!(pack.cards.len(), 15);
                let lands: Vec<_> = pack
                    .cards
                    .iter()
                    .filter(|card| is_nonbasic_booster_land(card))
                    .collect();
                assert_eq!(lands.len(), 1);
                assert_eq!(
                    lands[0].rarity,
                    if probability == 1.0 { "mythic" } else { "rare" }
                );
                let ranks: Vec<_> = pack
                    .cards
                    .iter()
                    .map(|card| match card.rarity.as_str() {
                        "common" => 0,
                        "uncommon" => 1,
                        "rare" => 2,
                        _ => 3,
                    })
                    .collect();
                assert!(ranks.windows(2).all(|pair| pair[0] <= pair[1]));
            }
        }
    }

    #[test]
    fn uncommon_land_gets_priority_over_common_lands_without_weight_reduction() {
        let mut pools = BoosterPools {
            uncommon: vec![recipe_card("uncommon-land", "uncommon", "Land")],
            ..BoosterPools::default()
        };
        for index in 0..10 {
            pools
                .common
                .push(recipe_card(&format!("spell-{index}"), "common", "Creature"));
            pools
                .common
                .push(recipe_card(&format!("land-{index}"), "common", "Land"));
        }
        for seed in 0..100 {
            let pack = generate_pack(
                &pools,
                &recipe_config(3, 1, 0),
                &mut HashMap::new(),
                &mut StdRng::seed_from_u64(seed),
            );
            assert_eq!(pack.cards.len(), 4);
            assert_eq!(
                pack.cards
                    .iter()
                    .filter(|card| is_nonbasic_booster_land(card))
                    .count(),
                1
            );
            assert_eq!(pack.cards.last().unwrap().id, "uncommon-land");
        }
    }

    #[test]
    fn multiple_rare_slots_prioritize_rolled_mythic_lands_before_rare_lands() {
        let pools = BoosterPools {
            rare: vec![
                recipe_card("rare-land", "rare", "Land"),
                recipe_card("rare-spell", "rare", "Creature"),
            ],
            mythic: vec![recipe_card("mythic-land", "mythic", "Land")],
            ..BoosterPools::default()
        };
        let mut config = recipe_config(0, 0, 2);
        config.mythic_probability = 0.5;
        let mut mixed = 0;
        for seed in 0..400 {
            let pack = generate_pack(
                &pools,
                &config,
                &mut HashMap::new(),
                &mut StdRng::seed_from_u64(seed),
            );
            assert_eq!(pack.cards.len(), 2);
            assert_eq!(pack.duplicate_wildcards, WildcardBalances::default());
            if pack
                .cards
                .iter()
                .filter(|card| card.rarity == "mythic")
                .count()
                == 1
            {
                mixed += 1;
                assert_eq!(pack.cards[0].id, "rare-spell");
                assert_eq!(pack.cards[1].id, "mythic-land");
            }
        }
        assert!(mixed > 150, "mixed rare/mythic packs sampled: {mixed}");
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
            sqlx::query("UPDATE wildcards SET quantity=1 WHERE rarity='discovery'")
                .execute(&db.pool)
                .await
                .unwrap();
            sqlx::raw_sql("CREATE TRIGGER reject_test_card BEFORE INSERT ON collection WHEN NEW.card_id='r' BEGIN SELECT RAISE(ABORT,'test insert failure'); END;").execute(&db.pool).await.unwrap();
            assert!(
                craft_with_kind_pool(&db.pool, "r", "failed-insert", NOW, Some("discovery"))
                    .await
                    .unwrap_err()
                    .contains("test insert failure")
            );
            assert_eq!(
                status_pool(&db.pool, NOW)
                    .await
                    .unwrap()
                    .wildcards
                    .discovery,
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
            assert_eq!(joined.available_packs, 32);
            assert_eq!(
                joined.wildcards,
                WildcardBalances {
                    common: 18,
                    uncommon: 9,
                    rare: 3,
                    mythic: 2,
                    discovery: 1,
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
                    mythic: 1,
                    discovery: 0,
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
                    mythic: 3,
                    discovery: 0,
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
            assert_eq!(status.join_packs, 20 + 52 * 6 + 13 * 8);
            let joined = begin_pool(&db.pool, now).await.unwrap();
            assert_eq!(joined.general_packs, 332);
            assert_eq!(joined.available_packs, 436);
            assert_eq!(
                joined.wildcards,
                WildcardBalances {
                    common: 218,
                    uncommon: 109,
                    rare: 28,
                    mythic: 14,
                    discovery: 14,
                }
            );
            assert_eq!(
                begin_pool(&db.pool, now).await.unwrap().available_packs,
                436
            );
        });
    }

    #[test]
    fn wildcard_cadence_uses_calendar_boundaries_for_rare_and_mythic_rewards() {
        let rules = crate::league_rules::builtin_rules().unwrap();
        for week in 0..=12 {
            let (packs, rewards) = accumulated_rewards(&rules, week).unwrap();
            assert_eq!(packs, week * 6);
            assert_eq!(
                rewards,
                WildcardBalances {
                    common: 4 * week,
                    uncommon: 2 * week,
                    rare: week / 2,
                    mythic: (week + 2) / 4,
                    discovery: week / 4,
                }
            );
            if week > 0 {
                let (_, grant) = rewards_between(&rules, week - 1, week).unwrap();
                assert_eq!(grant.mythic, i64::from(week % 4 == 2));
                assert_eq!(grant.discovery, i64::from(week % 4 == 0));
                assert!(grant.mythic == 0 || grant.discovery == 0);
            }
        }
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
                    mythic: 0,
                    discovery: 0,
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
                    mythic: 0,
                    discovery: 0,
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
                    mythic: 0,
                    discovery: 0,
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
                    mythic: 1,
                    discovery: 0,
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
                    mythic: 1,
                    discovery: 0,
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
            sqlx::query("UPDATE wildcards SET quantity=CASE rarity WHEN 'common' THEN 5 WHEN 'uncommon' THEN 6 WHEN 'rare' THEN 7 WHEN 'mythic' THEN 8 ELSE quantity END").execute(&db.pool).await.unwrap();
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
                    mythic: 8,
                    discovery: 0,
                }
            );
            let paid = claim_pool(&db.pool, NOW + 2 * WEEK_SECONDS).await.unwrap();
            assert_eq!(
                paid.wildcards,
                WildcardBalances {
                    common: 13,
                    uncommon: 10,
                    rare: 8,
                    mythic: 8,
                    discovery: 0,
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
    #[test]
    fn discovery_first_copies_and_normal_copies_use_explicit_atomic_currencies() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            automatic_status_pool(&db.pool, NOW).await.unwrap();
            let before = reconciliation_snapshot(&db.pool).await;
            assert!(craft_pool(&db.pool, "r", "unowned-normal", NOW)
                .await
                .unwrap_err()
                .contains("must own"));
            assert_eq!(reconciliation_snapshot(&db.pool).await, before);
            let discovered =
                craft_with_kind_pool(&db.pool, "r", "discover-r", NOW, Some("discovery"))
                    .await
                    .unwrap();
            assert_eq!(discovered.card.oracle_owned, 1);
            assert_eq!(discovered.wildcards.discovery, 0);
            assert_eq!(discovered.wildcards.rare, 2);
            let replay = craft_with_kind_pool(&db.pool, "r", "discover-r", NOW, Some("discovery"))
                .await
                .unwrap();
            assert_eq!(replay.card.oracle_owned, 1);
            assert!(
                craft_with_kind_pool(&db.pool, "r", "discover-r", NOW, Some("rare"))
                    .await
                    .is_err()
            );
            assert!(
                craft_with_kind_pool(&db.pool, "r", "discover-owned", NOW, Some("discovery"))
                    .await
                    .unwrap_err()
                    .contains("first copy")
            );
            assert!(
                craft_with_kind_pool(&db.pool, "r", "wrong-rarity", NOW, Some("common"))
                    .await
                    .unwrap_err()
                    .contains("matching")
            );
            sqlx::query("INSERT INTO cards(id,oracle_id,name,set_code,collector_number,rarity,metadata_json,type_line) SELECT 'r-alt',oracle_id,name,set_code,'alt',rarity,metadata_json,type_line FROM cards WHERE id='r'").execute(&db.pool).await.unwrap();
            let copied = craft_with_kind_pool(&db.pool, "r-alt", "copy-r-alt", NOW, Some("rare"))
                .await
                .unwrap();
            assert_eq!(copied.card.oracle_owned, 2);
            assert_eq!(copied.wildcards.rare, 1);
            assert_eq!(copied.wildcards.discovery, 0);
            assert!(craft_with_kind_pool(
                &db.pool,
                "r-alt",
                "discover-alt",
                NOW,
                Some("discovery")
            )
            .await
            .unwrap_err()
            .contains("first copy"));
            let snapshot = reconciliation_snapshot(&db.pool).await;
            assert!(
                craft_with_kind_pool(&db.pool, "m", "empty-discovery", NOW, Some("discovery"))
                    .await
                    .unwrap_err()
                    .contains("need one discovery")
            );
            assert_eq!(reconciliation_snapshot(&db.pool).await, snapshot);
        });
    }

    #[test]
    fn concurrent_discoveries_grant_only_one_first_copy_and_never_spend_normal_currency() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            automatic_status_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("UPDATE wildcards SET quantity=2 WHERE rarity='discovery'")
                .execute(&db.pool)
                .await
                .unwrap();
            let first = db.pool.clone();
            let second = db.pool.clone();
            let a = tokio::spawn(async move {
                craft_with_kind_pool(&first, "r", "discovery-race-a", NOW, Some("discovery")).await
            });
            let b = tokio::spawn(async move {
                craft_with_kind_pool(&second, "r", "discovery-race-b", NOW, Some("discovery")).await
            });
            assert_ne!(a.await.unwrap().is_ok(), b.await.unwrap().is_ok());
            let status = status_pool(&db.pool, NOW).await.unwrap();
            assert_eq!(status.wildcards.discovery, 1);
            assert_eq!(status.wildcards.rare, 2);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT quantity FROM collection WHERE card_id='r'")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
                1
            );
        });
    }

    #[test]
    fn released_profiles_receive_missing_discovery_and_shifted_mythic_entitlements_once() {
        tauri::async_runtime::block_on(async {
            for week in [0, 1, 2, 4, 6, 8, 13] {
                let db = fixture().await;
                let current = current_reward_rules();
                let mut old = current.clone();
                old.starting_wildcards.discovery = 0;
                old.weekly_wildcards.discovery = 0;
                old.wildcard_reward_offsets = WildcardBalances::default();
                set_reward_rules(&db.pool, &old).await;
                let now = NOW + week * WEEK_SECONDS;
                automatic_status_pool(&db.pool, now).await.unwrap();
                // The released v1 ledger has neither discovery nor the schedule marker.
                sqlx::query("UPDATE settings SET value=json_remove(value,'$.startingWildcards.discovery','$.alternatingRewardsApplied') WHERE key=?").bind(REWARD_ENTITLEMENTS_KEY).execute(&db.pool).await.unwrap();
                // Model all old mythics as spent; an upgrade must not refill them.
                sqlx::query("UPDATE wildcards SET quantity=0 WHERE rarity='mythic'")
                    .execute(&db.pool)
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO collection(card_id,quantity) VALUES('c',2)")
                    .execute(&db.pool)
                    .await
                    .unwrap();
                let old_status = status_pool(&db.pool, now).await.unwrap();
                let preserved = owned_reward_snapshot(&db.pool).await;
                set_reward_rules(&db.pool, &current).await;
                let first = db.pool.clone();
                let second = db.pool.clone();
                let a = tokio::spawn(async move { automatic_status_pool(&first, now).await });
                let b = tokio::spawn(async move { automatic_status_pool(&second, now).await });
                for result in [a.await.unwrap().unwrap(), b.await.unwrap().unwrap()] {
                    assert_eq!(result.available_packs, old_status.available_packs);
                    assert_eq!(result.wildcards.common, old_status.wildcards.common);
                    assert_eq!(result.wildcards.uncommon, old_status.wildcards.uncommon);
                    assert_eq!(result.wildcards.rare, old_status.wildcards.rare);
                    assert_eq!(result.wildcards.mythic, (week + 2) / 4 - week / 4);
                    assert_eq!(result.wildcards.discovery, 1 + week / 4);
                }
                assert_eq!(owned_reward_snapshot(&db.pool).await, preserved);
                // Spending Discovery must survive repeated status and restart paths.
                sqlx::query("UPDATE wildcards SET quantity=0 WHERE rarity='discovery'")
                    .execute(&db.pool)
                    .await
                    .unwrap();
                assert_eq!(
                    automatic_status_pool(&db.pool, now)
                        .await
                        .unwrap()
                        .wildcards
                        .discovery,
                    0
                );
                assert_eq!(
                    begin_pool(&db.pool, now).await.unwrap().wildcards.discovery,
                    0
                );
                let later = automatic_status_pool(&db.pool, NOW + (week + 4) * WEEK_SECONDS)
                    .await
                    .unwrap();
                assert_eq!(later.wildcards.discovery, 1);
                assert_eq!(later.wildcards.mythic, 1 + (week + 2) / 4 - week / 4);
            }
        });
    }

    #[test]
    fn discovery_upgrade_rolls_back_with_ledger_failure_and_preserves_legacy_craft_receipts() {
        tauri::async_runtime::block_on(async {
            let db = fixture().await;
            let mut old = current_reward_rules();
            old.starting_wildcards.discovery = 0;
            old.weekly_wildcards.discovery = 0;
            old.wildcard_reward_offsets = WildcardBalances::default();
            set_reward_rules(&db.pool, &old).await;
            automatic_status_pool(&db.pool, NOW).await.unwrap();
            sqlx::query("UPDATE settings SET value=json_remove(value,'$.startingWildcards.discovery','$.alternatingRewardsApplied') WHERE key=?").bind(REWARD_ENTITLEMENTS_KEY).execute(&db.pool).await.unwrap();
            set_reward_rules(&db.pool, &current_reward_rules()).await;
            let before = reconciliation_snapshot(&db.pool).await;
            sqlx::raw_sql("CREATE TRIGGER reject_discovery_ledger BEFORE UPDATE ON settings WHEN NEW.key='league_reward_entitlements_v1' BEGIN SELECT RAISE(ABORT,'ledger test failure'); END;").execute(&db.pool).await.unwrap();
            assert!(automatic_status_pool(&db.pool, NOW)
                .await
                .unwrap_err()
                .contains("ledger test failure"));
            assert_eq!(reconciliation_snapshot(&db.pool).await, before);
            sqlx::raw_sql("DROP TRIGGER reject_discovery_ledger")
                .execute(&db.pool)
                .await
                .unwrap();
            assert_eq!(
                automatic_status_pool(&db.pool, NOW)
                    .await
                    .unwrap()
                    .wildcards
                    .discovery,
                1
            );
            // Historical results without discovery deserialize and replay before new rules.
            let card = recipe_card("r", "rare", "Creature");
            let result=serde_json::json!({"card":card,"wildcards":{"common":0,"uncommon":0,"rare":0,"mythic":0}}).to_string();
            sqlx::query("INSERT INTO progression_operations(id,kind,request_json,result_json,created_at) VALUES('legacy-craft','craft',?,?,?)")
                .bind(serde_json::json!({"cardId":"r"}).to_string()).bind(result).bind(timestamp(NOW).unwrap()).execute(&db.pool).await.unwrap();
            let before = reconciliation_snapshot(&db.pool).await;
            assert_eq!(
                craft_pool(&db.pool, "r", "legacy-craft", NOW)
                    .await
                    .unwrap()
                    .wildcards
                    .discovery,
                0
            );
            craft_with_kind_pool(&db.pool, "r", "legacy-craft", NOW, Some("rare"))
                .await
                .unwrap();
            assert!(
                craft_with_kind_pool(&db.pool, "r", "legacy-craft", NOW, Some("discovery"))
                    .await
                    .is_err()
            );
            assert_eq!(reconciliation_snapshot(&db.pool).await, before);
        });
    }
}
