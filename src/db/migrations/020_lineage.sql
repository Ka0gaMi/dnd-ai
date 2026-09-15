-- The lineage inside a species - a Draconic Ancestor, an Elven Lineage, a Fiendish Legacy - chosen at
-- creation. NULL on the rows made before this, which keep every lineage's traits listed and none applied.
ALTER TABLE character ADD COLUMN lineage TEXT;
