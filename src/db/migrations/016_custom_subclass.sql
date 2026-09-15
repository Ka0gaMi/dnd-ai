-- Custom subclasses and custom spells: the subclass a character took when it is homebrew, and
-- room in the homebrew store for a spell the DM wrote.
ALTER TABLE character ADD COLUMN subclass_homebrew_id INTEGER NULL REFERENCES homebrew(id);

-- SQLite cannot widen a CHECK constraint in place, so the table is rebuilt with 'spell' allowed.
CREATE TABLE homebrew_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id       INTEGER REFERENCES campaign(id),
  scope             TEXT NOT NULL DEFAULT 'campaign' CHECK (scope IN ('campaign', 'library')),
  kind              TEXT NOT NULL CHECK (kind IN ('background', 'feat', 'feature', 'subclass', 'spell')),
  name              TEXT NOT NULL,
  schema_json       TEXT NOT NULL,
  power_report_json TEXT,
  power_label       TEXT NOT NULL DEFAULT 'within' CHECK (power_label IN ('within', 'over_budget')),
  created_by        TEXT NOT NULL DEFAULT 'dm' CHECK (created_by IN ('dm', 'player')),
  created_at        TEXT NOT NULL
);
INSERT INTO homebrew_new (id, campaign_id, scope, kind, name, schema_json, power_report_json, power_label, created_by, created_at)
  SELECT id, campaign_id, scope, kind, name, schema_json, power_report_json, power_label, created_by, created_at FROM homebrew;
DROP TABLE homebrew;
ALTER TABLE homebrew_new RENAME TO homebrew;
CREATE INDEX idx_homebrew_campaign ON homebrew(campaign_id, id);
CREATE INDEX idx_homebrew_scope ON homebrew(scope, kind);
