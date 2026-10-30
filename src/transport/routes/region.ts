import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { getCampaign } from '../../core/campaign.js';
import { assertReplaceable, getRegion, importRegion, playerRegionSummary } from '../../core/region.js';
import { RealmFetchError } from '../../core/realm-fetch.js';
import { regionJobFailure, regionJobRunning, startRegionJob } from '../../core/region-job.js';

const regionBody = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('generate'),
    seed: z.number().int().min(0).optional(),
    tags: z.array(z.string().regex(/^[a-z]+$/)).max(8).optional(),
    size: z.enum(['small', 'medium', 'large']).default('medium'),
    replace: z.boolean().optional(),
  }),
  z.object({
    mode: z.literal('upload'),
    realm: z.record(z.string(), z.unknown()),
    replace: z.boolean().optional(),
  }),
]);

/** Adds a region map to a campaign (generated or uploaded) and reads back its player-safe summary. */
export default function registerRegionRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/region', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    try {
      getCampaign(db, id);
    } catch {
      res.status(404).json({ error: 'no such campaign' });
      return;
    }
    const view = getRegion(db, id);
    res.json({
      region: view ? playerRegionSummary(view) : null,
      generating: regionJobRunning(db, id),
      failure: regionJobFailure(db, id),
    });
  });

  app.post('/api/campaigns/:id/region', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    try {
      getCampaign(db, id);
    } catch {
      res.status(404).json({ error: 'no such campaign' });
      return;
    }
    const parsed = regionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid region request', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    try {
      // Refuse before generating: a browser run is expensive and must not start on a doomed request.
      assertReplaceable(db, id, body.replace);
      if (body.mode === 'generate' && regionJobRunning(db, id)) {
        res.status(409).json({
          error: 'A region map is already being generated for this story (up to a minute). Upload one instead, or replace it once it is ready.',
        });
        return;
      }
      const view =
        body.mode === 'generate'
          ? await startRegionJob(db, id, { seed: body.seed, tags: body.tags, size: body.size, replace: body.replace })
          : importRegion(db, id, body.realm, { source: 'uploaded', replace: body.replace });
      res.status(201).json({ region: playerRegionSummary(view) });
    } catch (err) {
      if (err instanceof RealmFetchError) {
        res.status(502).json({ error: err.message });
        return;
      }
      // A bad file, an existing region or a party-known place is the caller's to fix.
      res.status(400).json({ error: (err as Error).message });
    }
  });
}
