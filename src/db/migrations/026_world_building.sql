-- A named building inside a settlement of the region map, with its downloaded floor plan.
CREATE TABLE world_building (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaign(id),
  place_id        INTEGER NOT NULL REFERENCES world_place(id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  seed            INTEGER NOT NULL,
  url             TEXT NOT NULL,
  raw_json        TEXT NOT NULL,
  known_to_party  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_world_building_name ON world_building(place_id, lower(name));
CREATE INDEX idx_world_building_campaign ON world_building(campaign_id);
