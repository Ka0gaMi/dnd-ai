-- A server-side secret per campaign, kept out of the campaign row so no reply ever carries it: the salt
-- the player's copies hash an item's counter keys with, so a guessed name cannot be checked offline.
CREATE TABLE campaign_secret (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaign(id),
  key_salt    TEXT NOT NULL
);

INSERT INTO campaign_secret (campaign_id, key_salt) SELECT id, lower(hex(randomblob(16))) FROM campaign;
