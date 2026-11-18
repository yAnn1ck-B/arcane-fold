-- Preserve all earned balances while extending the currency constraint.
CREATE TABLE wildcards_with_discovery (
    rarity TEXT PRIMARY KEY NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'mythic', 'discovery')),
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0)
);
INSERT INTO wildcards_with_discovery (rarity, quantity) SELECT rarity, quantity FROM wildcards;
INSERT INTO wildcards_with_discovery (rarity, quantity) VALUES ('discovery', 0);
DROP TABLE wildcards;
ALTER TABLE wildcards_with_discovery RENAME TO wildcards;
