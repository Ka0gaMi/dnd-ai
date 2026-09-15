-- One pre-call snapshot per mutating combat tool, so undo_last_combat_action can take the last one back.
CREATE TABLE combat_undo (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id  INTEGER NOT NULL REFERENCES encounter(id),
  tool          TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  ts            TEXT NOT NULL
);
CREATE INDEX idx_combat_undo_encounter ON combat_undo(encounter_id, id);
