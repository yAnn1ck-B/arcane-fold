CREATE TABLE set_booster_balances (
    set_code TEXT PRIMARY KEY NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0)
);

CREATE TABLE expansion_reward_claims (
    set_code TEXT PRIMARY KEY NOT NULL,
    week INTEGER NOT NULL CHECK (week >= 0),
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    claimed_at TEXT NOT NULL
);
