-- Soft delete: the player can remove a campaign from the companion window and restore it later.
ALTER TABLE campaign ADD COLUMN deleted_at TEXT NULL;
