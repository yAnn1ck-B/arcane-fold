CREATE TABLE IF NOT EXISTS web_decks (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES web_players,
  name text NOT NULL,
  cards jsonb NOT NULL CHECK (jsonb_typeof(cards) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Keep only the creation receipt when a player deletes the deck. A delayed
-- autosave retry for that request must never restore a removed deck.
CREATE TABLE IF NOT EXISTS web_deck_creations (
  player_id uuid NOT NULL REFERENCES web_players,
  request_id text NOT NULL,
  deck_id uuid NOT NULL,
  PRIMARY KEY (player_id, request_id)
);
CREATE INDEX IF NOT EXISTS web_decks_player ON web_decks(player_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS web_cards_set ON web_cards((data->>'setCode'));
