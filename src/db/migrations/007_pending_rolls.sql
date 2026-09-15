-- Player-clicked rolls: one row per roll the DM asked the player to make, resolved by the
-- companion window (or auto-rolled when the tool call times out).
CREATE TABLE pending_roll (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  expr        TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  dc          INTEGER,
  roll_type   TEXT NOT NULL DEFAULT 'other',
  advantage   TEXT NOT NULL DEFAULT 'none',
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  result_json TEXT,
  source      TEXT CHECK (source IN ('player', 'auto', 'override'))
);
CREATE INDEX idx_pending_roll_campaign ON pending_roll(campaign_id, id);

-- Cheat mode edited the result; the flag stays in the database and never reaches the DM.
ALTER TABLE roll ADD COLUMN overridden INTEGER NOT NULL DEFAULT 0;
