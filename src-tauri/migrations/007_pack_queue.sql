CREATE TABLE booster_pack_queue (
    id TEXT PRIMARY KEY NOT NULL,
    set_code TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('general', 'bonus')),
    earned_period INTEGER NOT NULL CHECK (earned_period >= 0),
    priority INTEGER NOT NULL DEFAULT 0,
    remaining INTEGER NOT NULL CHECK (remaining >= 0)
);
CREATE INDEX booster_pack_queue_chronology ON booster_pack_queue(earned_period,priority,id) WHERE remaining > 0;
