-- The Wild Shape form a Druid is wearing outside a fight, timed on the world clock; the combatant's flags
-- hold it during one, and end_encounter writes it back here.
ALTER TABLE character ADD COLUMN wild_shape_json TEXT;
