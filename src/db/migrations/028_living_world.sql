-- One row per campaign: the world clock, its seed and the party's quiet period.
CREATE TABLE world_state (
  campaign_id      INTEGER PRIMARY KEY REFERENCES campaign(id),
  seed             INTEGER NOT NULL,
  last_tick_day    INTEGER NOT NULL,
  quiet_until_day  INTEGER NOT NULL DEFAULT 0
);
-- A power in the living world: a realm, house, church, guild, gang or off-map group.
CREATE TABLE world_faction (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id      INTEGER NOT NULL REFERENCES campaign(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('realm', 'house', 'church', 'guild', 'gang', 'monsters', 'off_map')),
  realm_id         INTEGER REFERENCES world_realm(id),
  county_id        INTEGER REFERENCES world_county(id),
  place_id         INTEGER REFERENCES world_place(id),
  secrecy          TEXT NOT NULL DEFAULT 'open' CHECK (secrecy IN ('open', 'discreet', 'secret')),
  resources        INTEGER NOT NULL DEFAULT 3,
  capacities_json  TEXT NOT NULL DEFAULT '{}',
  entity_id        INTEGER REFERENCES entity(id),
  created_day      INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_world_faction_name ON world_faction(campaign_id, lower(name));
-- A faction's plan, tracked as a clock that fills toward success or failure.
CREATE TABLE world_agenda (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaign(id),
  faction_id      INTEGER NOT NULL REFERENCES world_faction(id),
  template        TEXT NOT NULL,
  target_kind     TEXT NOT NULL,
  target_id       INTEGER,
  target_name     TEXT NOT NULL,
  clock_size      INTEGER NOT NULL,
  clock_filled    INTEGER NOT NULL DEFAULT 0,
  portents_json   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'won', 'lost', 'held', 'abandoned')),
  known_to_party  INTEGER NOT NULL DEFAULT 0,
  started_day     INTEGER NOT NULL,
  resolved_day    INTEGER
);
-- Append-only ledger of what the world did, and why, on a given day.
CREATE TABLE world_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   INTEGER NOT NULL REFERENCES campaign(id),
  day           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL,
  severity      INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  place_id      INTEGER REFERENCES world_place(id),
  faction_id    INTEGER REFERENCES world_faction(id),
  agenda_id     INTEGER REFERENCES world_agenda(id),
  causes_json   TEXT NOT NULL DEFAULT '[]',
  effects_json  TEXT NOT NULL DEFAULT '{}',
  visibility    TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'discreet', 'secret'))
);
CREATE INDEX idx_world_event_campaign_day ON world_event(campaign_id, day);
-- A piece of news derived from an event, true, false or twisted.
CREATE TABLE world_packet (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id      INTEGER NOT NULL REFERENCES campaign(id),
  event_id         INTEGER NOT NULL REFERENCES world_event(id),
  origin_place_id  INTEGER REFERENCES world_place(id),
  truth            TEXT NOT NULL CHECK (truth IN ('true', 'false', 'twisted')),
  text             TEXT NOT NULL
);
-- When and where a news packet reached, and whether the party heard it.
CREATE TABLE world_packet_arrival (
  packet_id  INTEGER NOT NULL REFERENCES world_packet(id),
  place_id   INTEGER NOT NULL REFERENCES world_place(id),
  day        INTEGER NOT NULL,
  heard      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (packet_id, place_id)
);
-- A fading attitude score toward a faction or entity, with the reason it changed.
CREATE TABLE world_attitude (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaign(id),
  subject_kind    TEXT NOT NULL CHECK (subject_kind IN ('faction', 'entity')),
  subject_id      INTEGER NOT NULL,
  value           INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  cause_event_id  INTEGER REFERENCES world_event(id),
  day             INTEGER NOT NULL,
  fade_days       INTEGER NOT NULL
);
CREATE INDEX idx_world_attitude_subject ON world_attitude(campaign_id, subject_kind, subject_id);
-- The last day the party was seen at a place.
CREATE TABLE world_visit (
  campaign_id    INTEGER NOT NULL REFERENCES campaign(id),
  place_id       INTEGER NOT NULL REFERENCES world_place(id),
  last_seen_day  INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, place_id)
);
-- Government and faith columns on a realm, filled by the living-world layer.
ALTER TABLE world_realm ADD COLUMN government TEXT;
ALTER TABLE world_realm ADD COLUMN realm_title TEXT;
ALTER TABLE world_realm ADD COLUMN ruler_title TEXT;
ALTER TABLE world_realm ADD COLUMN faith TEXT;
