use crate::progression::WildcardBalances;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BoosterConfig {
    pub commons: i64,
    pub uncommons: i64,
    pub rare_slots: i64,
    pub basic_lands: i64,
    #[serde(alias = "lowRarityLandWeight")]
    pub common_land_weight: f64,
    #[serde(alias = "preferredLowRarityLandLimit")]
    pub preferred_land_limit: i64,
}

impl Default for BoosterConfig {
    fn default() -> Self {
        Self {
            commons: 10,
            uncommons: 3,
            rare_slots: 1,
            basic_lands: 0,
            common_land_weight: 0.5,
            preferred_land_limit: 1,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AutoUnlock {
    pub interval_weeks: i64,
    pub set_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct DeckRestrictions {
    pub minimum_main_deck: i64,
    pub maximum_sideboard: i64,
    pub normal_copy_limit: i64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExpansionScheduleEntry {
    pub week: i64,
    pub code: String,
    pub name: String,
    pub description: String,
    pub bonus_packs: i64,
}

impl Default for ExpansionScheduleEntry {
    fn default() -> Self {
        Self {
            week: 0,
            code: String::new(),
            name: String::new(),
            description: String::new(),
            bonus_packs: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WildcardRewardIntervals {
    pub common: i64,
    pub uncommon: i64,
    pub rare: i64,
    pub mythic: i64,
}

impl Default for WildcardRewardIntervals {
    fn default() -> Self {
        Self {
            common: 1,
            uncommon: 1,
            rare: 1,
            mythic: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LeagueRules {
    pub started_at: i64,
    pub starting_packs: i64,
    pub starting_wildcards: WildcardBalances,
    pub weekly_packs: i64,
    pub weekly_wildcards: WildcardBalances,
    pub wildcard_reward_intervals: WildcardRewardIntervals,
    pub mythic_probability: f64,
    pub enabled_sets: Vec<String>,
    pub booster: BoosterConfig,
    pub wildcard_drop_probability: f64,
    pub auto_unlock: AutoUnlock,
    pub deck_restrictions: DeckRestrictions,
    pub expansion_schedule: Vec<ExpansionScheduleEntry>,
}

impl Default for LeagueRules {
    fn default() -> Self {
        Self {
            started_at: 1_794_801_597,
            starting_packs: 20,
            starting_wildcards: WildcardBalances {
                common: 10,
                uncommon: 5,
                rare: 2,
                mythic: 1,
            },
            weekly_packs: 6,
            weekly_wildcards: WildcardBalances::default(),
            wildcard_reward_intervals: WildcardRewardIntervals::default(),
            mythic_probability: 0.125,
            enabled_sets: Vec::new(),
            booster: BoosterConfig::default(),
            wildcard_drop_probability: 0.0,
            auto_unlock: AutoUnlock::default(),
            deck_restrictions: DeckRestrictions::default(),
            expansion_schedule: Vec::new(),
        }
    }
}

/// This file is part of the application build, not user-editable settings.
pub fn builtin_rules() -> Result<LeagueRules, String> {
    serde_json::from_str(include_str!("../league-rules.json"))
        .map_err(|error| format!("The built-in league rules are invalid: {error}"))
}

#[tauri::command]
pub fn league_rules() -> Result<LeagueRules, String> {
    builtin_rules()
}

#[cfg(test)]
mod tests {
    use super::BoosterConfig;

    #[test]
    fn older_land_rule_keys_load_but_serialize_with_current_names() {
        let slots: BoosterConfig = serde_json::from_value(serde_json::json!({
            "lowRarityLandWeight": 0.25,
            "preferredLowRarityLandLimit": 2
        }))
        .unwrap();
        assert_eq!(slots.common_land_weight, 0.25);
        assert_eq!(slots.preferred_land_limit, 2);
        let current = serde_json::to_value(slots).unwrap();
        assert_eq!(current["commonLandWeight"], 0.25);
        assert_eq!(current["preferredLandLimit"], 2);
        assert!(current.get("lowRarityLandWeight").is_none());
        assert!(current.get("preferredLowRarityLandLimit").is_none());
    }
}
