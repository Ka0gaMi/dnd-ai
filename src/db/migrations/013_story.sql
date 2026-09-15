-- Story structure: the outline and its acts and chapters, the threads and clues behind them, the
-- rumours the world whispers and the journal the player writes. Hidden rows are the DM's alone.
CREATE TABLE story_outline (
  campaign_id  INTEGER PRIMARY KEY REFERENCES campaign(id),
  premise      TEXT,
  ending       TEXT,
  secret_notes TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE act (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  goal        TEXT,
  status      TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'done'))
);
CREATE INDEX idx_act_campaign ON act(campaign_id, number);

CREATE TABLE chapter (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  act_id      INTEGER REFERENCES act(id),
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  goal        TEXT,
  summary     TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  started_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE INDEX idx_chapter_campaign ON chapter(campaign_id, number);

CREATE TABLE plot_thread (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dropped')),
  hidden      INTEGER NOT NULL DEFAULT 0,
  summary     TEXT,
  chapter_id  INTEGER REFERENCES chapter(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_plot_thread_campaign ON plot_thread(campaign_id, status);

CREATE TABLE clue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id       INTEGER NOT NULL REFERENCES campaign(id),
  thread_id         INTEGER REFERENCES plot_thread(id),
  text              TEXT NOT NULL,
  hidden            INTEGER NOT NULL DEFAULT 0,
  found_at_scene_id INTEGER REFERENCES scene(id),
  planted_at        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'planted' CHECK (status IN ('planted', 'found'))
);
CREATE INDEX idx_clue_campaign ON clue(campaign_id, status);

CREATE TABLE journal_entry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  chapter_id  INTEGER REFERENCES chapter(id),
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_journal_entry_campaign ON journal_entry(campaign_id, id);

CREATE TABLE rumour (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  scope       TEXT NOT NULL DEFAULT 'location' CHECK (scope IN ('world', 'region', 'location')),
  text        TEXT NOT NULL,
  truth       TEXT NOT NULL DEFAULT 'true' CHECK (truth IN ('true', 'false', 'twisted')),
  source_kind TEXT,
  thread_id   INTEGER REFERENCES plot_thread(id),
  heard_at    TEXT,
  resolved    INTEGER NOT NULL DEFAULT 0,
  chapter_id  INTEGER REFERENCES chapter(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_rumour_campaign ON rumour(campaign_id, scope);

-- What was established where: the chapter filter the companion window puts on these lists.
ALTER TABLE canon_fact ADD COLUMN chapter_id INTEGER;
ALTER TABLE glossary_entry ADD COLUMN chapter_id INTEGER;
ALTER TABLE quest ADD COLUMN chapter_id INTEGER;
ALTER TABLE scene ADD COLUMN chapter_id INTEGER;

-- In-world date and time: {year, month, day, hour, minute, month_names[], season}.
ALTER TABLE campaign ADD COLUMN calendar_json TEXT;
