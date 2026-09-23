-- The downloaded map export of a region place: a settlement's city or village, or a danger's dungeon.
CREATE TABLE world_place_map (
  place_id     INTEGER PRIMARY KEY REFERENCES world_place(id),
  campaign_id  INTEGER NOT NULL REFERENCES campaign(id),
  kind         TEXT NOT NULL CHECK (kind IN ('city', 'village', 'dungeon')),
  url          TEXT NOT NULL,
  raw_json     TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);
CREATE INDEX idx_world_place_map_campaign ON world_place_map(campaign_id);
