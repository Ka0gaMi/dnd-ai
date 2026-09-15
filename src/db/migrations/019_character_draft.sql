-- The half-filled character the wizard sends when the player leaves some of it to the DM, and the
-- appearance the DM writes when they finish the sheet.
ALTER TABLE campaign ADD COLUMN character_draft_json TEXT;
ALTER TABLE character ADD COLUMN appearance TEXT;
