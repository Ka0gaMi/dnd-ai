-- A place's passing state, which lapses on until_day, and a settlement's own faith; one row per place.
CREATE TABLE world_place_state (
  campaign_id     INTEGER NOT NULL REFERENCES campaign(id),
  place_id        INTEGER NOT NULL REFERENCES world_place(id),
  state           TEXT CHECK (state IS NULL OR state IN ('raided','besieged','ruined')),
  until_day       INTEGER,
  faith_id        INTEGER REFERENCES world_faith(id),
  cause_event_id  INTEGER REFERENCES world_event(id),
  updated_day     INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, place_id),
  CHECK ((state IS NULL) = (until_day IS NULL))
);
