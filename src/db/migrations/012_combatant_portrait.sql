-- Portraits are dealt out automatically now: a combatant remembers the exact one it was given, so a
-- fight's goblins keep their faces when their type has several variants. kind tells a portrait shared
-- by a creature type from one individual's own, which is stored under that individual's name.
ALTER TABLE combatant ADD COLUMN portrait_path TEXT;
ALTER TABLE creature_portrait ADD COLUMN kind TEXT NOT NULL DEFAULT 'type';
