import express, { type Express, type Request, type Response } from 'express';
import type { Db } from '../../db/connection.js';
import { creaturePortraitPath, portraitsEnabled, savePortraitUpload, type PortraitSubject } from '../../core/portraits.js';

/** The player drops a file on the companion window; it arrives here as raw image bytes. */
const rawImage = express.raw({ type: ['image/png', 'image/jpeg'], limit: '5mb' });

function imageBody(req: Request, res: Response): Buffer | null {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(415).json({ error: 'post the raw image bytes with content-type image/png or image/jpeg' });
    return null;
  }
  return req.body;
}

function store(req: Request, res: Response, db: Db, campaignId: number, subject: PortraitSubject): void {
  const bytes = imageBody(req, res);
  if (!bytes) return;
  try {
    res.json(savePortraitUpload({ db, campaign_id: campaignId, subject, bytes }));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

export default function registerPortraitRoutes(app: Express, db: Db): void {
  app.get('/api/portraits/status', (_req, res) => {
    res.json({ enabled: portraitsEnabled() });
  });

  app.post('/api/characters/:id/portrait', rawImage, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad character id' });
      return;
    }
    const row = db.prepare('SELECT campaign_id FROM character WHERE id = ?').get(id) as
      | { campaign_id: number }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'no such character' });
      return;
    }
    store(req, res, db, row.campaign_id, { character_id: id });
  });

  app.post('/api/portraits/creature/:name', rawImage, (req, res) => {
    const campaignId = Number(req.query.campaign_id);
    if (!Number.isInteger(campaignId)) {
      res.status(400).json({ error: 'campaign_id query parameter required' });
      return;
    }
    store(req, res, db, campaignId, { creature: req.params.name });
  });

  app.get('/api/portraits/creature/:name', (req, res) => {
    const wanted = req.query.campaign_id;
    const campaignId = wanted === undefined ? null : Number(wanted);
    if (campaignId !== null && !Number.isInteger(campaignId)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const path = creaturePortraitPath(db, campaignId, req.params.name);
    if (!path) {
      res.status(404).json({ error: 'no portrait for that creature' });
      return;
    }
    res.json({ path });
  });
}
