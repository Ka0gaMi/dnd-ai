-- Monster portraits hang on the creature name, not on a combatant row, so the same goblin keeps its
-- face across encounters. campaign_id NULL means a portrait shared by every campaign.
CREATE TABLE creature_portrait (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  creature    TEXT NOT NULL COLLATE NOCASE,
  campaign_id INTEGER REFERENCES campaign(id),
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_creature_portrait_creature ON creature_portrait(creature);
