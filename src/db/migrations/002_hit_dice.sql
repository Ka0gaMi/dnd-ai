-- Hit dice are spent on short rests and regained on long rests; the other columns come from 001.
ALTER TABLE character ADD COLUMN hit_dice_json TEXT;
