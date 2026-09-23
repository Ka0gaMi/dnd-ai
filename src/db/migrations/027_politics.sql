-- A realm (kingdom or similar) in a campaign's region map, seated at a place.
CREATE TABLE world_realm (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id       INTEGER NOT NULL REFERENCES campaign(id),
  name              TEXT NOT NULL,
  capital_place_id  INTEGER REFERENCES world_place(id)
);
-- A county of a realm, seated at a place and covering a list of hexes.
CREATE TABLE world_county (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    INTEGER NOT NULL REFERENCES campaign(id),
  realm_id       INTEGER NOT NULL REFERENCES world_realm(id),
  seat_place_id  INTEGER NOT NULL REFERENCES world_place(id),
  name           TEXT NOT NULL,
  hexes_json     TEXT NOT NULL
);
CREATE INDEX idx_world_realm_campaign ON world_realm(campaign_id);
CREATE INDEX idx_world_county_campaign ON world_county(campaign_id);
