import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { getCampaign } from '../../core/campaign.js';
import { nowState } from '../../core/calendar.js';
import { getRumours, listActs, storyArc, type RumourScope } from '../../core/story.js';

const SCOPES: RumourScope[] = ['world', 'region', 'location'];

/** The story panel's data. Hidden threads, clues and DM notes are stripped unless show_secrets is on. */
export default function registerStoryRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/story', (req, res) => {
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
    res.json({ ...storyArc(db, id, { forPlayer: true }), acts: listActs(db, id), now: nowState(db, id) });
  });

  app.get('/api/campaigns/:id/rumours', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const scope = req.query.scope as RumourScope | undefined;
    if (scope !== undefined && !SCOPES.includes(scope)) {
      res.status(400).json({ error: 'bad scope' });
      return;
    }
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 50;
    // The player's window shows what they have heard; reading it never marks anything heard.
    res.json(getRumours(db, id, { scope, limit, heard_only: true, for_player: true }));
  });
}
