CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY NOT NULL,
    oracle_id TEXT NOT NULL,
    name TEXT NOT NULL,
    set_code TEXT NOT NULL,
    collector_number TEXT NOT NULL,
    rarity TEXT NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'mythic', 'special', 'bonus')),
    metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_oracle_id ON cards(oracle_id);
CREATE INDEX IF NOT EXISTS cards_name ON cards(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS collection (
    card_id TEXT PRIMARY KEY NOT NULL REFERENCES cards(id),
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0)
);

CREATE TABLE IF NOT EXISTS decks (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deck_cards (
    deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES cards(id),
    section TEXT NOT NULL CHECK (section IN ('main', 'sideboard')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (deck_id, card_id, section)
);

CREATE TABLE IF NOT EXISTS wildcards (
    rarity TEXT PRIMARY KEY NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'mythic')),
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0)
);
INSERT OR IGNORE INTO wildcards (rarity, quantity) VALUES
    ('common', 0), ('uncommon', 0), ('rare', 0), ('mythic', 0);

CREATE TABLE IF NOT EXISTS booster_history (
    id TEXT PRIMARY KEY NOT NULL,
    set_code TEXT NOT NULL,
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    contents_json TEXT NOT NULL
);
