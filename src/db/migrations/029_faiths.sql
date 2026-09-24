-- A faith that spans realms, with its own fervor and an optional parent it broke from.
CREATE TABLE world_faith (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id       INTEGER NOT NULL REFERENCES campaign(id),
  name              TEXT NOT NULL,
  aspect            TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  head_place_id     INTEGER REFERENCES world_place(id),
  fervor            INTEGER NOT NULL DEFAULT 50 CHECK (fervor BETWEEN 0 AND 100),
  heresy_of         INTEGER REFERENCES world_faith(id),
  last_heresy_day   INTEGER,
  created_day       INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_world_faith_name ON world_faith(campaign_id, lower(name));
-- A temple faction is a faith's branch, with the influence it holds there.
ALTER TABLE world_faction ADD COLUMN faith_id INTEGER REFERENCES world_faith(id);
ALTER TABLE world_faction ADD COLUMN influence TEXT CHECK (influence IS NULL OR influence IN ('minor', 'strong', 'dominant'));
-- A church-versus-crown clock per realm, filling toward excommunication.
CREATE TABLE world_contest (
  campaign_id  INTEGER NOT NULL REFERENCES campaign(id),
  realm_id     INTEGER NOT NULL REFERENCES world_realm(id),
  faith_id     INTEGER NOT NULL REFERENCES world_faith(id),
  filled       INTEGER NOT NULL DEFAULT 0,
  size         INTEGER NOT NULL DEFAULT 6,
  PRIMARY KEY (campaign_id, realm_id, faith_id)
);
-- A realm's excommunication, which lapses after the given day.
ALTER TABLE world_realm ADD COLUMN excommunicated_until INTEGER;
