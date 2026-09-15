-- Progression: homebrew the DM writes for this campaign or keeps in the personal library,
-- the play notes the play profile is built from, and decisions the player has to answer.
CREATE TABLE homebrew (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL once the entry is saved to the library, which belongs to no single campaign.
  campaign_id       INTEGER REFERENCES campaign(id),
  scope             TEXT NOT NULL DEFAULT 'campaign' CHECK (scope IN ('campaign', 'library')),
  kind              TEXT NOT NULL CHECK (kind IN ('background', 'feat', 'feature', 'subclass')),
  name              TEXT NOT NULL,
  schema_json       TEXT NOT NULL,
  power_report_json TEXT,
  power_label       TEXT NOT NULL DEFAULT 'within' CHECK (power_label IN ('within', 'over_budget')),
  created_by        TEXT NOT NULL DEFAULT 'dm' CHECK (created_by IN ('dm', 'player')),
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_homebrew_campaign ON homebrew(campaign_id, id);
CREATE INDEX idx_homebrew_scope ON homebrew(scope, kind);

-- How the player plays, in the DM's words: tags plus the line that earned them.
CREATE TABLE play_note (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaign(id),
  character_id INTEGER REFERENCES character(id),
  tags_json    TEXT NOT NULL DEFAULT '[]',
  text         TEXT NOT NULL,
  scene_id     INTEGER REFERENCES scene(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_play_note_campaign ON play_note(campaign_id, id);

-- A question only the player can answer, pushed to their window like a pending roll.
CREATE TABLE pending_decision (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   INTEGER NOT NULL REFERENCES campaign(id),
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  decision_json TEXT
);
CREATE INDEX idx_pending_decision_campaign ON pending_decision(campaign_id, id);

-- The level-up window the DM prepared: SRD options plus their suggestions with power reports.
ALTER TABLE character ADD COLUMN pending_level_up_json TEXT;
