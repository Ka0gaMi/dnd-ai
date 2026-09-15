-- A creature at 0 HP that was stabilised stops rolling death saves until it takes damage again.
-- Campaign languages need no table of their own: they live in glossary_entry, marked by their definition.
ALTER TABLE character ADD COLUMN stable INTEGER NOT NULL DEFAULT 0;
