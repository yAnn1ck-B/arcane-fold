CREATE TABLE game_issue_reports (
    id TEXT PRIMARY KEY NOT NULL,
    match_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    report_json TEXT NOT NULL
);
