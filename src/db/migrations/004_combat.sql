-- Combat: one active encounter per campaign, its combatants, engine-owned effects and the fight log.
CREATE TABLE encounter (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  scene_id    INTEGER REFERENCES scene(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  round       INTEGER NOT NULL DEFAULT 1,
  turn_index  INTEGER NOT NULL DEFAULT 0,
  seed        INTEGER NOT NULL,
  map_json    TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'bars' CHECK (visibility IN ('full', 'bars', 'hidden')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  outcome     TEXT
);
CREATE INDEX idx_encounter_campaign ON encounter(campaign_id, id);

-- PCs keep their hit points on the character row; companions and monsters keep them here.
CREATE TABLE combatant (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id     INTEGER NOT NULL REFERENCES encounter(id),
  kind             TEXT NOT NULL CHECK (kind IN ('pc', 'companion', 'monster')),
  character_id     INTEGER REFERENCES character(id),
  stat_block_json  TEXT,
  name             TEXT NOT NULL,
  team             TEXT NOT NULL DEFAULT 'enemy' CHECK (team IN ('party', 'enemy', 'neutral')),
  initiative       INTEGER NOT NULL DEFAULT 0,
  initiative_order INTEGER NOT NULL DEFAULT 0,
  x                INTEGER NOT NULL DEFAULT 0,
  y                INTEGER NOT NULL DEFAULT 0,
  size             TEXT NOT NULL DEFAULT 'M' CHECK (size IN ('T', 'S', 'M', 'L', 'H', 'G')),
  hp_current       INTEGER NOT NULL DEFAULT 0,
  hp_max           INTEGER NOT NULL DEFAULT 0,
  temp_hp          INTEGER NOT NULL DEFAULT 0,
  ac               INTEGER NOT NULL DEFAULT 10,
  speed            INTEGER NOT NULL DEFAULT 30,
  conditions_json  TEXT NOT NULL DEFAULT '[]',
  concentration_json TEXT,
  death_saves_json TEXT NOT NULL DEFAULT '{"successes":0,"failures":0}',
  movement_left    INTEGER NOT NULL DEFAULT 0,
  action_used      INTEGER NOT NULL DEFAULT 0,
  bonus_used       INTEGER NOT NULL DEFAULT 0,
  reaction_used    INTEGER NOT NULL DEFAULT 0,
  visible          INTEGER NOT NULL DEFAULT 1,
  alive            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_combatant_encounter ON combatant(encounter_id, initiative_order);

-- Ongoing effects the engine ticks at the start or end of the target's turn.
CREATE TABLE effect (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id     INTEGER NOT NULL REFERENCES encounter(id),
  target_id        INTEGER NOT NULL REFERENCES combatant(id),
  source_id        INTEGER REFERENCES combatant(id),
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('damage', 'condition', 'buff')),
  damage_expr      TEXT,
  damage_type      TEXT,
  save_ability     TEXT,
  save_dc          INTEGER,
  tick             TEXT NOT NULL DEFAULT 'start' CHECK (tick IN ('start', 'end')),
  ends             TEXT NOT NULL DEFAULT 'manual' CHECK (ends IN ('rounds', 'save', 'rest', 'concentration', 'manual')),
  remaining_rounds INTEGER,
  concentration_of INTEGER REFERENCES combatant(id),
  created_round    INTEGER NOT NULL DEFAULT 1,
  active           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_effect_encounter ON effect(encounter_id, active);
CREATE INDEX idx_effect_target ON effect(target_id, active);

-- One row per resolved thing: initiative, move, attack, save, damage, condition, tick, death save, kill.
CREATE TABLE combat_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id INTEGER NOT NULL REFERENCES encounter(id),
  round        INTEGER NOT NULL DEFAULT 1,
  actor_id     INTEGER REFERENCES combatant(id),
  target_id    INTEGER REFERENCES combatant(id),
  kind         TEXT NOT NULL,
  payload_json TEXT,
  text         TEXT NOT NULL,
  ts           TEXT NOT NULL
);
CREATE INDEX idx_combat_log_encounter ON combat_log(encounter_id, id);
