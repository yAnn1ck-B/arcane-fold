#![cfg(desktop)]

use serde_json::Value;
use std::path::PathBuf;
use tauri::utils::platform::Target;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

// Tauri's codegen and CLI apply JSON Merge Patch (RFC 7396): missing keys
// preserve the base value, while explicit null removes a key.
fn merge_patch(value: &mut Value, patch: &Value) {
    if let Value::Object(fields) = patch {
        if !value.is_object() {
            *value = serde_json::json!({});
        }
        let destination = value.as_object_mut().unwrap();
        for (key, child) in fields {
            if child.is_null() {
                destination.remove(key);
            } else {
                merge_patch(destination.entry(key.clone()).or_insert(Value::Null), child);
            }
        }
    } else {
        *value = patch.clone();
    }
}

fn assert_updater(config: &Value) {
    let updater: tauri_plugin_updater::Config =
        serde_json::from_value(config["plugins"]["updater"].clone())
            .expect("Cold application config must contain updater settings");
    assert!(!updater.pubkey.is_empty());
    assert!(updater.require_signed_version);
    assert!(!updater.allow_downgrades);
    assert_eq!(updater.endpoints.len(), 1);
    assert_eq!(updater.endpoints[0].scheme(), "https");
    assert_eq!(
        updater.endpoints[0].as_str(),
        "https://github.com/yAnn1ck-B/eternal-league/releases/latest/download/latest.json"
    );
}

#[test]
fn cold_platform_and_development_configs_keep_signed_updater_settings() {
    for target in [Target::Windows, Target::Linux] {
        let (base, _) = tauri::utils::config::parse::read_from(target, &root()).unwrap();
        assert_updater(&base);
        let development: Value =
            serde_json::from_slice(&std::fs::read(root().join("tauri.dev.conf.json")).unwrap())
                .unwrap();
        let preview = serde_json::json!({
            "identifier":"com.eternalleague.preview",
            "app":{"windows":[{
                "label":"main","title":"Eternal League - Week 4 preview",
                "width":1440,"height":940,"minWidth":980,"minHeight":700,
                "backgroundColor":"#f1f0ea"
            }]}
        });
        for patch in [development, preview] {
            let mut merged = base.clone();
            merge_patch(&mut merged, &patch);
            assert_updater(&merged);
            let _: tauri::Config = serde_json::from_value(merged).unwrap();
        }
    }
}

#[test]
fn freshly_generated_context_contains_updater_config_without_running_the_app() {
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let config = serde_json::to_value(context.config()).unwrap();
    assert_updater(&config);
}

#[test]
fn missing_updater_reproduces_the_reported_null_config_error() {
    let error = serde_json::from_value::<tauri_plugin_updater::Config>(Value::Null).unwrap_err();
    assert!(error.to_string().contains("invalid type: null"));
    let (mut base, _) = tauri::utils::config::parse::read_from(Target::Windows, &root()).unwrap();
    // An old override that merely lacks updater does not erase the new base.
    merge_patch(
        &mut base,
        &serde_json::json!({"plugins":{"sql":{"preload":["sqlite:eternal-league.db"]}}}),
    );
    assert_updater(&base);
}
