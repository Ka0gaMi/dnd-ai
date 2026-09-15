-- Companions and NPCs share the character table with the PC; role says which one a row is.
ALTER TABLE character ADD COLUMN role TEXT NOT NULL DEFAULT 'pc';
-- Heroic Inspiration (2024): you either have it or you do not.
ALTER TABLE character ADD COLUMN inspiration INTEGER NOT NULL DEFAULT 0;
-- Reserved for the sheet overrides of a later package.
ALTER TABLE character ADD COLUMN overrides_json TEXT NULL;

UPDATE character SET role = CASE WHEN is_pc = 1 THEN 'pc' ELSE 'npc' END;
