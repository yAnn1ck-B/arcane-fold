CREATE TABLE IF NOT EXISTS web_players (
  id uuid PRIMARY KEY,
  session_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
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
