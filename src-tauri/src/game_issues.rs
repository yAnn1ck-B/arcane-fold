use crate::catalog::{database_mutation_guard, open_pool};
use serde_json::Value;
use sqlx::SqlitePool;
use tauri::AppHandle;

#[tauri::command]
pub async fn save_game_issue(app: AppHandle, report: Value) -> Result<(), String> {
    let _operation = database_mutation_guard()?;
    store(&open_pool(&app).await?, &report).await
}

async fn store(pool: &SqlitePool, report: &Value) -> Result<(), String> {
    let text = |key: &str| {
        report[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("The report is missing {key}."))
    };
    let id = text("id")?;
    let match_id = text("matchId")?;
    let captured_at = text("capturedAt")?;
    if report["schemaVersion"] != 1
        || !matches!(text("mode")?, "forge" | "manual")
        || !matches!(text("viewer")?, "player" | "opponent")
        || !report["history"].is_array()
        || !report["actions"].is_array()
        || !report["expectedBehavior"].as_str().is_some_and(|s| s.chars().count() <= 1000)
    {
        return Err("The game issue report could not be read.".into());
    }
    let payload = report.to_string();
    // The same frozen submission may be retried after losing its acknowledgement.
    let saved = sqlx::query(
        "INSERT INTO game_issue_reports(id,match_id,captured_at,report_json) VALUES(?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET id=excluded.id WHERE game_issue_reports.report_json=excluded.report_json",
    )
    .bind(id)
    .bind(match_id)
    .bind(captured_at)
    .bind(payload)
    .execute(pool)
    .await
    .map_err(|e| format!("Could not save the game issue report: {e}"))?;
    if saved.rows_affected() != 1 {
        return Err("A different report already uses this report ID.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn game_issue_save_preserves_evidence_and_accepts_an_identical_retry() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
            sqlx::raw_sql(include_str!("../migrations/009_game_issue_reports.sql"))
                .execute(&pool).await.unwrap();
            let mut report = json!({
                "id":"report", "matchId":"match", "capturedAt":"2026-11-19T00:00:00Z",
                "schemaVersion":1, "mode":"forge", "viewer":"opponent", "revision":8,
                "expectedBehavior":"Let me respond.", "actions":[{"label":"Pass"}],
                "history":[{"turn":3,"text":"Player 1 cast Shock."}], "board":{"stack":["Shock"]}
            });
            store(&pool, &report).await.unwrap();
            store(&pool, &report).await.unwrap();
            let original = report.clone();
            report["history"] = json!([]);
            assert!(store(&pool, &report).await.is_err());
            let rows: Vec<String> = sqlx::query_scalar("SELECT report_json FROM game_issue_reports")
                .fetch_all(&pool).await.unwrap();
            assert_eq!(rows, vec![original.to_string()]);
        });
    }
}
