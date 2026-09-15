CREATE TABLE campaign (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  story_shape        TEXT NOT NULL CHECK (story_shape IN ('structured', 'sandbox')),
  premise            TEXT,
  luck_bias          REAL NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  current_session_id INTEGER,
  current_scene_id   INTEGER,
  settings_json      TEXT
);

CREATE TABLE session (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  number      INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  recap_text  TEXT
);
CREATE INDEX idx_session_campaign ON session(campaign_id);

CREATE TABLE scene (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES session(id),
  campaign_id   INTEGER NOT NULL REFERENCES campaign(id),
  title         TEXT,
  summary       TEXT,
  location_name TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);
CREATE INDEX idx_scene_campaign ON scene(campaign_id);
CREATE INDEX idx_scene_session ON scene(session_id);

-- Filled in by WP2 (SRD character rules); WP1 only reads the PC row.
CREATE TABLE character (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id        INTEGER NOT NULL REFERENCES campaign(id),
  name               TEXT NOT NULL,
  is_pc              INTEGER NOT NULL DEFAULT 0,
  species            TEXT,
  class              TEXT,
  subclass           TEXT,
  background         TEXT,
  level              INTEGER NOT NULL DEFAULT 1,
  xp                 INTEGER NOT NULL DEFAULT 0,
  hp_current         INTEGER,
  hp_max             INTEGER,
  temp_hp            INTEGER NOT NULL DEFAULT 0,
  ac                 INTEGER,
  speed              INTEGER,
  abilities_json     TEXT,
  saves_json         TEXT,
  skills_json        TEXT,
  proficiencies_json TEXT,
  features_json      TEXT,
  spells_json        TEXT,
  spell_slots_json   TEXT,
  inventory_json     TEXT,
  conditions_json    TEXT,
  death_saves_json   TEXT,
  exhaustion         INTEGER NOT NULL DEFAULT 0,
  gold               INTEGER NOT NULL DEFAULT 0,
  portrait_path      TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dead', 'retired', 'npc')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_character_campaign ON character(campaign_id);

CREATE TABLE quest (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'side' CHECK (kind IN ('main', 'side', 'personal')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'failed')),
  summary     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_quest_campaign ON quest(campaign_id);

CREATE TABLE quest_step (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  quest_id INTEGER NOT NULL REFERENCES quest(id),
  text     TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  done_at  TEXT,
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_quest_step_quest ON quest_step(quest_id);

CREATE TABLE canon_fact (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id         INTEGER NOT NULL REFERENCES campaign(id),
  subject             TEXT NOT NULL,
  fact                TEXT NOT NULL,
  established_scene_id INTEGER REFERENCES scene(id),
  active              INTEGER NOT NULL DEFAULT 1,
  superseded_by       INTEGER REFERENCES canon_fact(id),
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_canon_fact_campaign ON canon_fact(campaign_id);

-- campaign_id IS NULL marks bundled SRD entries.
CREATE TABLE glossary_entry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaign(id),
  term        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'campaign' CHECK (source IN ('srd', 'campaign')),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_glossary_campaign ON glossary_entry(campaign_id);
CREATE UNIQUE INDEX idx_glossary_campaign_term ON glossary_entry(campaign_id, term);

-- Append-only ground truth.
CREATE TABLE event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaign(id),
  session_id   INTEGER REFERENCES session(id),
  scene_id     INTEGER REFERENCES scene(id),
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX idx_event_campaign ON event(campaign_id, id);

CREATE TABLE roll (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id       INTEGER REFERENCES campaign(id),
  event_id          INTEGER REFERENCES event(id),
  expr              TEXT NOT NULL,
  results_json      TEXT NOT NULL,
  total             INTEGER NOT NULL,
  purpose           TEXT,
  dc                INTEGER,
  outcome           TEXT,
  luck_bias_applied REAL NOT NULL DEFAULT 0,
  ts                TEXT NOT NULL
);
CREATE INDEX idx_roll_campaign ON roll(campaign_id, id);
