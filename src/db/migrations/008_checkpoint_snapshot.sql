-- Rewind: what the campaign looked like when a checkpoint was saved.
CREATE TABLE checkpoint (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   INTEGER NOT NULL REFERENCES campaign(id),
  scene_id      INTEGER REFERENCES scene(id),
  created_at    TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE INDEX idx_checkpoint_campaign ON checkpoint(campaign_id, id);

-- Events after the checkpoint a rewind restored: kept for the ledger, skipped by the briefing.
ALTER TABLE event ADD COLUMN reverted INTEGER NOT NULL DEFAULT 0;
