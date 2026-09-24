-- A realm's kind and whether it is a vassal of another realm or seated beyond the map.
ALTER TABLE world_realm ADD COLUMN kind TEXT NOT NULL DEFAULT 'kingdom' CHECK (kind IN ('kingdom','free_city','lordship','tribe'));
ALTER TABLE world_realm ADD COLUMN off_map INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_realm ADD COLUMN liege_realm_id INTEGER REFERENCES world_realm(id);
-- A duchy inside a realm, seated at a place and holding counties.
CREATE TABLE world_duchy (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    INTEGER NOT NULL REFERENCES campaign(id),
  realm_id       INTEGER NOT NULL REFERENCES world_realm(id),
  name           TEXT NOT NULL,
  seat_place_id  INTEGER REFERENCES world_place(id),
  demesne        INTEGER NOT NULL DEFAULT 0,
  joined_how     TEXT NOT NULL DEFAULT 'core' CHECK (joined_how IN ('core','conquest','union','inheritance'))
);
CREATE INDEX idx_world_duchy_campaign ON world_duchy(campaign_id);
-- A county's seat kind, its duchy, its marches and its bound villages.
ALTER TABLE world_county ADD COLUMN seat_kind TEXT NOT NULL DEFAULT 'town' CHECK (seat_kind IN ('city','town','castle'));
ALTER TABLE world_county ADD COLUMN duchy_id INTEGER REFERENCES world_duchy(id);
ALTER TABLE world_county ADD COLUMN is_march INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_county ADD COLUMN village_ids_json TEXT NOT NULL DEFAULT '[]';
-- A realm's claim on a county it does not hold.
CREATE TABLE world_claim (
  campaign_id        INTEGER NOT NULL REFERENCES campaign(id),
  county_id          INTEGER NOT NULL REFERENCES world_county(id),
  claimant_realm_id  INTEGER NOT NULL REFERENCES world_realm(id),
  strength           TEXT NOT NULL CHECK (strength IN ('weak','strong')),
  reason             TEXT NOT NULL,
  PRIMARY KEY (campaign_id, county_id, claimant_realm_id)
);
CREATE INDEX idx_world_claim_campaign ON world_claim(campaign_id);
