-- Cheat mode lets the player see the real roll before deciding. The preview is rolled once and kept
-- here, so accepting it records the dice that were actually rolled rather than a second roll.
ALTER TABLE pending_roll ADD COLUMN preview_json TEXT;
