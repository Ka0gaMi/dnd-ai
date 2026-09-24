-- A person of the world: a ruler, their kin, a tribal elder or a rival.
CREATE TABLE world_person (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaign(id),
  name         TEXT NOT NULL,
  house        TEXT,
  sex          TEXT NOT NULL CHECK (sex IN ('male', 'female')),
  birth_day    INTEGER NOT NULL,
  death_day    INTEGER,
  died_how     TEXT,
  traits_json  TEXT NOT NULL DEFAULT '[]',
  epithet      TEXT,
  role         TEXT NOT NULL CHECK (role IN ('ruler', 'consort', 'heir', 'relative', 'elder', 'regent', 'dowager', 'first_citizen', 'rival')),
  realm_id     INTEGER REFERENCES world_realm(id),
  faction_id   INTEGER REFERENCES world_faction(id),
  entity_id    INTEGER REFERENCES entity(id),
  parent_id    INTEGER REFERENCES world_person(id),
  spouse_id    INTEGER REFERENCES world_person(id),
  created_day  INTEGER NOT NULL
);
CREATE INDEX idx_world_person_campaign_realm ON world_person(campaign_id, realm_id);
-- A realm's succession law, the people who rule or inherit it, and its regency.
ALTER TABLE world_realm ADD COLUMN succession_law TEXT;
ALTER TABLE world_realm ADD COLUMN ruler_person_id INTEGER REFERENCES world_person(id);
ALTER TABLE world_realm ADD COLUMN heir_person_id INTEGER REFERENCES world_person(id);
ALTER TABLE world_realm ADD COLUMN regent_person_id INTEGER REFERENCES world_person(id);
-- A realm ruled by a council of elders rather than one ruler.
ALTER TABLE world_realm ADD COLUMN council INTEGER NOT NULL DEFAULT 0;
-- Wild land held by a tribe, covering the hexes it claims.
CREATE TABLE world_tribal_land (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaign(id),
  realm_id     INTEGER NOT NULL REFERENCES world_realm(id),
  name         TEXT NOT NULL,
  hexes_json   TEXT NOT NULL,
  component    INTEGER NOT NULL DEFAULT 0,
  frontier     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_world_tribal_land_campaign ON world_tribal_land(campaign_id);
-- A county that was once tribal land.
ALTER TABLE world_county ADD COLUMN tribal_heritage INTEGER NOT NULL DEFAULT 0;