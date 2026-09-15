-- Turn flags the 2024 actions leave behind: Dash, Dodge, Disengage, Help, Hide, Ready and grapples.
ALTER TABLE combatant ADD COLUMN flags_json TEXT;
