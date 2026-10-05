-- SQLite cannot widen a CHECK in place, so world_faction is copied aside and recreated under its own name
-- with 'bandits' allowed, an ended_day column and every id kept. Rows pointing at it are checked at commit.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE world_faction_old AS SELECT * FROM world_faction;
-- DROP TABLE discards the AUTOINCREMENT high-water mark, which feeds seeded dice, so it is kept aside too.
CREATE TABLE world_faction_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'world_faction';
DROP TABLE world_faction;

CREATE TABLE world_faction (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id      INTEGER NOT NULL REFERENCES campaign(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('realm', 'house', 'church', 'guild', 'gang', 'monsters', 'off_map', 'bandits')),
  realm_id         INTEGER REFERENCES world_realm(id),
  county_id        INTEGER REFERENCES world_county(id),
  place_id         INTEGER REFERENCES world_place(id),
  secrecy          TEXT NOT NULL DEFAULT 'open' CHECK (secrecy IN ('open', 'discreet', 'secret')),
  resources        INTEGER NOT NULL DEFAULT 3,
  capacities_json  TEXT NOT NULL DEFAULT '{}',
  entity_id        INTEGER REFERENCES entity(id),
  created_day      INTEGER NOT NULL,
  faith_id         INTEGER REFERENCES world_faith(id),
  influence        TEXT CHECK (influence IS NULL OR influence IN ('minor', 'strong', 'dominant')),
  ended_day        INTEGER
);
INSERT INTO world_faction (id, campaign_id, name, type, realm_id, county_id, place_id, secrecy, resources,
                           capacities_json, entity_id, created_day, faith_id, influence)
  SELECT id, campaign_id, name, type, realm_id, county_id, place_id, secrecy, resources,
         capacities_json, entity_id, created_day, faith_id, influence FROM world_faction_old;
DELETE FROM sqlite_sequence WHERE name = 'world_faction';
INSERT INTO sqlite_sequence (name, seq) SELECT 'world_faction', seq FROM world_faction_seq;
DROP TABLE world_faction_old;
DROP TABLE world_faction_seq;
CREATE UNIQUE INDEX idx_world_faction_name ON world_faction(campaign_id, lower(name));
