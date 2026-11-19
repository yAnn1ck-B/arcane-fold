CREATE TABLE IF NOT EXISTS web_economy (
  player_id uuid PRIMARY KEY REFERENCES web_players,
  entitlements jsonb NOT NULL,
  wildcards jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS web_owned (
  player_id uuid NOT NULL REFERENCES web_players,
  card_id text NOT NULL REFERENCES web_cards,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 4),
  PRIMARY KEY (player_id, card_id)
);
CREATE TABLE IF NOT EXISTS web_pack_queue (
  player_id uuid NOT NULL REFERENCES web_players,
  grant_id text NOT NULL,
  set_code text NOT NULL,
  source text NOT NULL CHECK (source IN ('general','bonus')),
  period integer NOT NULL,
  priority integer NOT NULL,
  remaining integer NOT NULL CHECK (remaining >= 0),
  PRIMARY KEY (player_id, grant_id)
);
CREATE TABLE IF NOT EXISTS web_receipts (
  player_id uuid NOT NULL REFERENCES web_players,
  request_id text NOT NULL,
  kind text NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (player_id, request_id)
);
CREATE TABLE IF NOT EXISTS web_openings (
  player_id uuid NOT NULL REFERENCES web_players,
  id text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  set_code text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  contents jsonb NOT NULL,
  PRIMARY KEY (player_id, id)
);
CREATE INDEX IF NOT EXISTS web_opening_history ON web_openings (player_id, seq DESC);
