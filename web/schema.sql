CREATE TABLE IF NOT EXISTS web_players (
  id uuid PRIMARY KEY,
  session_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The first authenticated visit can attach an existing browser league, including
-- its room seats and receipts, without copying or re-keying any player data.
CREATE TABLE IF NOT EXISTS web_accounts (
  email text PRIMARY KEY,
  name text NOT NULL,
  password_hash text NOT NULL,
  player_id uuid UNIQUE REFERENCES web_players
);
ALTER TABLE web_players ADD COLUMN IF NOT EXISTS priority_settings jsonb;
CREATE TABLE IF NOT EXISTS web_login_sessions (
  token_hash text PRIMARY KEY,
  email text NOT NULL REFERENCES web_accounts,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS web_cards (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS web_card_oracle ON web_cards ((data->>'oracleId'));
CREATE TABLE IF NOT EXISTS web_rooms (
  id uuid PRIMARY KEY,
  invite_code text NOT NULL UNIQUE,
  host uuid NOT NULL REFERENCES web_players,
  guest uuid REFERENCES web_players,
  host_deck text NOT NULL,
  guest_deck text,
  label text NOT NULL,
  seed bigint NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')),
  checkpoint jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (guest IS NULL OR guest <> host)
);
CREATE INDEX IF NOT EXISTS web_rooms_host ON web_rooms(host);
CREATE INDEX IF NOT EXISTS web_rooms_guest ON web_rooms(guest);
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS archived_at timestamptz;
-- Keep older, unused lobbies as records while keeping the newest one open.
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES web_rooms(id);
WITH waiting AS (
  SELECT id, first_value(id) OVER (PARTITION BY host ORDER BY updated_at DESC, id) AS newest
  FROM web_rooms WHERE archived_at IS NULL AND status='waiting' AND guest IS NULL AND superseded_by IS NULL
)
UPDATE web_rooms r SET superseded_by=w.newest FROM waiting w
WHERE r.id=w.id AND w.id<>w.newest;
CREATE UNIQUE INDEX IF NOT EXISTS web_one_visible_open_game_per_host ON web_rooms(host)
  WHERE archived_at IS NULL AND status='waiting' AND guest IS NULL AND superseded_by IS NULL;
DROP INDEX IF EXISTS web_one_open_game_per_host;
-- Keep earlier unfinished games intact. Either seat can explicitly resume one
-- after the current game ends. A restart must never promote a saved game.
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS paused_at timestamptz;
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY least(host,guest),greatest(host,guest) ORDER BY updated_at DESC,id
  ) AS place
  FROM web_rooms WHERE archived_at IS NULL AND status='playing' AND guest IS NOT NULL AND paused_at IS NULL
)
UPDATE web_rooms r SET paused_at=now() FROM ranked
WHERE r.id=ranked.id AND ranked.place>1;
CREATE UNIQUE INDEX IF NOT EXISTS web_one_visible_playing_game_per_pair
  ON web_rooms (least(host,guest),greatest(host,guest))
  WHERE archived_at IS NULL AND status='playing' AND guest IS NOT NULL AND paused_at IS NULL;
DROP INDEX IF EXISTS web_one_playing_game_per_pair;
-- The two registered accounts share one lobby. Older anonymous games keep
-- their seats and checkpoints without occupying the registered pair's lobby.
CREATE OR REPLACE VIEW web_current_game AS
SELECT r.id,r.host,r.guest,r.status
FROM web_rooms r JOIN web_accounts h ON h.player_id=r.host
LEFT JOIN web_accounts g ON g.player_id=r.guest
WHERE r.archived_at IS NULL AND r.superseded_by IS NULL AND r.paused_at IS NULL
  AND ((r.status='waiting' AND r.guest IS NULL) OR (r.status='playing' AND g.player_id IS NOT NULL))
ORDER BY (r.status='playing') DESC,r.updated_at DESC,r.id LIMIT 1;
UPDATE web_rooms r SET superseded_by=c.id FROM web_current_game c
WHERE r.archived_at IS NULL AND r.status='waiting' AND r.guest IS NULL AND r.superseded_by IS NULL AND r.id<>c.id
  AND EXISTS (SELECT 1 FROM web_accounts a WHERE a.player_id=r.host);
CREATE TABLE IF NOT EXISTS web_positions (
  room_id uuid NOT NULL REFERENCES web_rooms,
  revision integer NOT NULL,
  player jsonb NOT NULL,
  opponent jsonb NOT NULL,
  PRIMARY KEY (room_id, revision)
);
-- These server-only offsets locate a historical position in the room's append-only
-- Forge journal. Earlier captures have no recorded replay cursor.
ALTER TABLE web_positions ADD COLUMN IF NOT EXISTS replay_cursor jsonb;
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'forge' CHECK (mode IN ('forge','manual'));
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS pending_request jsonb;
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS last_resolution jsonb;
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS control_version integer NOT NULL DEFAULT 0;
ALTER TABLE web_positions ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'forge' CHECK (mode IN ('forge','manual'));
ALTER TABLE web_positions ADD COLUMN IF NOT EXISTS manual_checkpoint jsonb;
-- Results stay attached to their positions, including archived legacy timelines.
ALTER TABLE web_positions ADD COLUMN IF NOT EXISTS outcome jsonb;
ALTER TABLE web_positions ADD COLUMN IF NOT EXISTS retired_at integer;
CREATE INDEX IF NOT EXISTS web_live_history ON web_positions(room_id,mode,revision) WHERE retired_at IS NULL;
-- A report on a discarded future still refers to that future's journal and position.
CREATE TABLE IF NOT EXISTS web_forge_journals (
  room_id uuid NOT NULL REFERENCES web_rooms,
  head_revision integer NOT NULL,
  checkpoint jsonb NOT NULL,
  PRIMARY KEY (room_id, head_revision)
);
CREATE TABLE IF NOT EXISTS web_reports (
  id uuid PRIMARY KEY,
  reporter uuid NOT NULL REFERENCES web_players,
  room_id uuid NOT NULL,
  revision integer NOT NULL,
  seat text NOT NULL CHECK (seat IN ('player','opponent')),
  details text NOT NULL CHECK (length(details) <= 2000),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (room_id,revision) REFERENCES web_positions
);
