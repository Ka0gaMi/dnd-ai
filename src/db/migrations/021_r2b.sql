-- When this character's last long rest ended, on the in-world clock, so the one-per-24-hours rule can
-- be enforced; and what they are concentrating on outside a fight, which the combatant row holds during one.
ALTER TABLE character ADD COLUMN last_long_rest_at TEXT;
ALTER TABLE character ADD COLUMN concentration_json TEXT;
-- The level the character stood at when a piece of homebrew was kept, and the official subclass a
-- recreation stands in for. NULL on everything written before this.
ALTER TABLE homebrew ADD COLUMN balanced_at_level INTEGER;
ALTER TABLE homebrew ADD COLUMN recreated_from TEXT;
