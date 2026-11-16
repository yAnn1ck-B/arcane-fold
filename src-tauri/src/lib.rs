mod catalog;
mod decks;
mod forge;
mod images;
mod league_rules;
mod maintenance;
mod progression;

use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:eternal-league.db",
                    vec![
                        Migration {
                            version: 1,
                            description: "initial_schema",
                            sql: include_str!("../migrations/001_initial.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 2,
                            description: "searchable_card_catalog",
                            sql: include_str!("../migrations/002_catalog.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 3,
                            description: "league_progression",
                            sql: include_str!("../migrations/003_progression.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 4,
                            description: "free_basic_lands",
                            sql: include_str!("../migrations/004_land_policy.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 5,
                            description: "scheduled_expansion_rewards",
                            sql: include_str!("../migrations/005_expansion_rewards.sql"),
                            kind: MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            forge::detect_forge_paths,
            forge::test_forge_integration,
            forge::read_cached_image,
            forge::export_test_deck,
            catalog::catalog_status,
            catalog::ensure_catalog,
            catalog::get_banner_card,
            catalog::get_card,
            catalog::query_cards,
            catalog::list_sets,
            catalog::import_catalog,
            images::resolve_card_image,
            decks::list_decks,
            decks::load_deck,
            decks::save_deck,
            decks::save_deck_to_forge,
            decks::migrate_forge_decks,
            decks::duplicate_deck,
            decks::delete_deck,
            decks::validate_deck,
            decks::export_deck,
            progression::league_status,
            league_rules::league_rules,
            progression::begin_league,
            progression::claim_weekly_reward,
            progression::open_boosters,
            progression::craft_card,
            maintenance::database_info,
            maintenance::save_app_settings,
            maintenance::backup_database,
            maintenance::restore_database,
            maintenance::clear_image_cache,
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start Eternal League");
}
