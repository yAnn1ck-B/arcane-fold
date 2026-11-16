ALTER TABLE cards ADD COLUMN league_eligible INTEGER NOT NULL DEFAULT 0 CHECK (league_eligible IN (0, 1));

-- Keep browsing on a compact index instead of reading full Scryfall metadata
-- for every card, filter, and page. Eligibility is derived from that metadata
-- once per policy version and maintained when printings are imported.
CREATE INDEX cards_league_browser ON cards (
    league_eligible,
    oracle_id,
    name COLLATE NOCASE,
    set_code,
    collector_number,
    id,
    type_line,
    cmc,
    colors_json,
    rarity,
    set_name,
    oracle_text
);
