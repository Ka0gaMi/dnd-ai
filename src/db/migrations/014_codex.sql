-- The codex: everyone and everything the story has named, and how they are tied to one another.
-- hidden_notes are the DM's own; they never leave the server unless the player turned secrets on.
CREATE TABLE entity (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id           INTEGER NOT NULL REFERENCES campaign(id),
  kind                  TEXT NOT NULL CHECK (kind IN ('npc', 'faction', 'place', 'item', 'deity', 'event')),
  name                  TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  notes                 TEXT NOT NULL DEFAULT '',
  hidden_notes          TEXT NOT NULL DEFAULT '',
  voice_json            TEXT,
  portrait_path         TEXT,
  status                TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('alive', 'dead', 'unknown')),
  -- No foreign key: the chapter table arrives with the story migration, which may not be installed.
  first_seen_chapter_id INTEGER,
  character_id          INTEGER REFERENCES character(id),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_entity_campaign_name ON entity(campaign_id, lower(name));
CREATE INDEX idx_entity_campaign_kind ON entity(campaign_id, kind);

-- One row per edge. Symmetric types (spouse, sibling, ally, enemy, rival, lover, knows) are read from
-- both ends by the query instead of being stored twice.
CREATE TABLE relationship (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id          INTEGER NOT NULL REFERENCES campaign(id),
  from_id              INTEGER NOT NULL REFERENCES entity(id),
  to_id                INTEGER NOT NULL REFERENCES entity(id),
  type                 TEXT NOT NULL CHECK (type IN ('parent', 'child', 'spouse', 'sibling', 'ally', 'enemy',
                                                     'member_of', 'owns', 'rules', 'serves', 'knows', 'rival', 'lover')),
  notes                TEXT NOT NULL DEFAULT '',
  established_scene_id INTEGER REFERENCES scene(id),
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_relationship_from ON relationship(from_id);
CREATE INDEX idx_relationship_to ON relationship(to_id);
