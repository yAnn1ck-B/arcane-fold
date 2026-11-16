CREATE TABLE league_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    started_at INTEGER NOT NULL,
    available_packs INTEGER NOT NULL DEFAULT 0 CHECK (available_packs >= 0),
    last_claimed_period INTEGER NOT NULL DEFAULT 0 CHECK (last_claimed_period >= 0)
);

CREATE TABLE progression_operations (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('open', 'craft')),
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX booster_history_opened_at ON booster_history(opened_at DESC);
