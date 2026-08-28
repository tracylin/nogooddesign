-- One row per entry. Deletions are a column, not an absence, so they travel to
-- every device instead of being trapped on the phone that made them.
CREATE TABLE IF NOT EXISTS entries (
  stall       TEXT    NOT NULL,        -- namespace, one per stall
  market      TEXT    NOT NULL,        -- market day, so a bad day can be cleared alone
  uid         TEXT    NOT NULL,        -- minted on the device that created the entry
  seq         INTEGER NOT NULL,        -- the friendly #12, assigned here so it is unique
  device_id   TEXT,
  created_at  TEXT,
  updated_at  TEXT    NOT NULL,        -- drives last write wins
  deleted_at  TEXT,                    -- null means alive
  rev         INTEGER NOT NULL,        -- server clock, drives the sync cursor
  body        TEXT    NOT NULL,        -- the entry as the app stores it
  PRIMARY KEY (stall, market, uid)
);

-- The only query the sync path makes: everything changed since a cursor.
CREATE INDEX IF NOT EXISTS idx_entries_rev ON entries (stall, market, rev);

-- Monotonic counters per stall and market day. rev is the sync cursor, seq hands
-- out display numbers that are never reused and never collide across phones.
CREATE TABLE IF NOT EXISTS counters (
  stall  TEXT    NOT NULL,
  market TEXT    NOT NULL,
  rev    INTEGER NOT NULL DEFAULT 0,
  seq    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stall, market)
);
