-- A combat step the player clicks: which encounter, tool, step, actor and target the roll belongs to,
-- so the companion window can name the step and the DM's tool result can point back at it.
ALTER TABLE pending_roll ADD COLUMN context_json TEXT;
