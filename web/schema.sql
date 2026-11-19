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
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES web_rooms(id);
ALTER TABLE web_rooms ADD COLUMN IF NOT EXISTS paused_at timestamptz;
DROP INDEX IF EXISTS web_one_open_game_per_host;
DROP INDEX IF EXISTS web_one_playing_game_per_pair;

-- One primary key covers both seats, so a player cannot occupy different live
-- rooms as host and guest. The room remains the source of truth for history.
CREATE TABLE IF NOT EXISTS web_live_room_seats (
  player_id uuid PRIMARY KEY REFERENCES web_players,
  room_id uuid NOT NULL REFERENCES web_rooms ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS web_live_room_seats_room ON web_live_room_seats(room_id);

DO $$
DECLARE
  game record;
  occupied_room uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='web_rooms'::regclass AND tgname='web_sync_room_seats') THEN
    LOCK TABLE web_rooms IN SHARE ROW EXCLUSIVE MODE;
    DELETE FROM web_live_room_seats;
    -- Preserve the visible game before considering older overlapping rooms.
    -- Paused boards and closed invitations remain saved and are never promoted.
    FOR game IN
      SELECT r.id,r.host,r.guest,r.status FROM web_rooms r
      LEFT JOIN web_accounts h ON h.player_id=r.host
      LEFT JOIN web_accounts g ON g.player_id=r.guest
      WHERE r.archived_at IS NULL AND r.superseded_by IS NULL AND r.paused_at IS NULL
        AND ((r.status='waiting' AND r.guest IS NULL) OR (r.status='playing' AND r.guest IS NOT NULL))
      ORDER BY CASE
        WHEN h.player_id IS NOT NULL AND g.player_id IS NOT NULL THEN 0
        WHEN r.status='waiting' AND h.player_id IS NOT NULL THEN 1
        WHEN r.status='playing' THEN 2 ELSE 3 END,r.updated_at DESC,r.id
    LOOP
      SELECT room_id INTO occupied_room FROM web_live_room_seats
        WHERE player_id IN (game.host,game.guest) ORDER BY room_id LIMIT 1;
      IF occupied_room IS NULL THEN
        INSERT INTO web_live_room_seats(player_id,room_id)
          SELECT player_id,game.id FROM unnest(ARRAY[game.host,game.guest]) AS members(player_id)
          WHERE player_id IS NOT NULL;
      ELSIF game.status='playing' THEN
        UPDATE web_rooms SET paused_at=now() WHERE id=game.id;
      ELSE
        UPDATE web_rooms SET superseded_by=occupied_room WHERE id=game.id;
      END IF;
    END LOOP;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION web_sync_room_seats() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.host,NEW.guest,NEW.status,NEW.archived_at,NEW.superseded_by,NEW.paused_at) IS NOT DISTINCT FROM
        ROW(OLD.host,OLD.guest,OLD.status,OLD.archived_at,OLD.superseded_by,OLD.paused_at) THEN
      RETURN NEW;
    END IF;
    DELETE FROM web_live_room_seats WHERE room_id=NEW.id;
  END IF;
  IF NEW.archived_at IS NULL AND NEW.superseded_by IS NULL AND NEW.paused_at IS NULL
      AND ((NEW.status='waiting' AND NEW.guest IS NULL) OR (NEW.status='playing' AND NEW.guest IS NOT NULL)) THEN
    INSERT INTO web_live_room_seats(player_id,room_id)
      SELECT player_id,NEW.id FROM unnest(ARRAY[NEW.host,NEW.guest]) AS members(player_id)
      WHERE player_id IS NOT NULL ORDER BY player_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER web_sync_room_seats
  AFTER INSERT OR UPDATE OF host,guest,status,archived_at,superseded_by,paused_at ON web_rooms
  FOR EACH ROW EXECUTE FUNCTION web_sync_room_seats();

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
