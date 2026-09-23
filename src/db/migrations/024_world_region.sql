-- One Perilous Shores region per campaign: the header row the map and its places hang off.
CREATE TABLE world_region (
  campaign_id  INTEGER PRIMARY KEY REFERENCES campaign(id),
  name         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('generated', 'uploaded')),
  seed         INTEGER NOT NULL,
  tags_json    TEXT NOT NULL,
  origin_url   TEXT NOT NULL,
  raw_json     TEXT NOT NULL,
  imported_at  TEXT NOT NULL
);
-- Every named settlement, area or danger the region holds, with the hexes it covers.
CREATE TABLE world_place (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaign(id),
  kind            TEXT NOT NULL CHECK (kind IN ('settlement', 'area', 'danger')),
  name            TEXT NOT NULL,
  q               INTEGER NOT NULL,
  r               INTEGER NOT NULL,
  hexes_json      TEXT NOT NULL,
  tags_json       TEXT NOT NULL,
  info            TEXT NOT NULL DEFAULT '',
  link            TEXT,
  seed            INTEGER,
  known_to_party  INTEGER NOT NULL DEFAULT 0,
  entity_id       INTEGER REFERENCES entity(id),
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_world_place_name ON world_place(campaign_id, kind, lower(name));
-- A road or sea route between two places, as the list of hexes it crosses.
CREATE TABLE world_route (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaign(id),
  kind         TEXT NOT NULL CHECK (kind IN ('road', 'searoute')),
  from_hex     TEXT NOT NULL,
  to_hex       TEXT NOT NULL,
  hexes_json   TEXT NOT NULL
);
CREATE INDEX idx_world_route_campaign ON world_route(campaign_id);
