-- The purse by denomination: cp, sp, ep, gp and pp. The gold column stays as the derived total in gp,
-- rounded down, so every older reader keeps working; a row with no coins yet is seeded from it on read.
ALTER TABLE character ADD COLUMN coins_json TEXT;
