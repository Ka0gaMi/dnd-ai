import type { Express, Request, Response } from 'express';
import type { Db } from '../../db/connection.js';
import { entityTree, getCodex, getEntity, showSecrets, type EntityKind } from '../../core/codex.js';

const KINDS = ['npc', 'faction', 'place', 'item', 'deity', 'event'];

/** Returns the campaign id, or answers 400 and returns null. */
function campaignId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'bad campaign id' });
    return null;
  }
  return id;
}

function entityId(req: Request, res: Response): number | null {
  const id = Number(req.params.eid);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'bad entity id' });
    return null;
  }
  return id;
}

export default function registerCodexRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/codex', (req, res) => {
    const id = campaignId(req, res);
    if (id === null) return;
    const kind = typeof req.query.kind === 'string' && KINDS.includes(req.query.kind) ? (req.query.kind as EntityKind) : undefined;
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    try {
      res.json(getCodex(db, id, { kind, query }));
    } catch {
      res.status(404).json({ error: 'no such campaign' });
    }
  });

  // The player's window: hidden notes stay on the server unless their spoiler toggle is on.
  app.get('/api/campaigns/:id/entities/:eid', (req, res) => {
    const id = campaignId(req, res);
    if (id === null) return;
    const eid = entityId(req, res);
    if (eid === null) return;
    try {
      res.json(getEntity(db, id, eid, { include_hidden: showSecrets(db, id) }));
    } catch {
      res.status(404).json({ error: 'no such entity' });
    }
  });

  app.get('/api/campaigns/:id/entities/:eid/tree', (req, res) => {
    const id = campaignId(req, res);
    if (id === null) return;
    const eid = entityId(req, res);
    if (eid === null) return;
    try {
      res.json({ tree: entityTree(db, id, eid) });
    } catch {
      res.status(404).json({ error: 'no such entity' });
    }
  });
}
