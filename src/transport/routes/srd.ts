import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { spellOptionDetails } from '../../core/progression.js';

/** More than a level-up window's worth of spells is not a tooltip request. */
const MAX_NAMES = 60;

/** Spell tooltips for the window outside the level-up panel: the SRD's plus the campaign's own. */
export default function registerSrdRoutes(app: Express, db: Db): void {
  app.get('/api/srd/spells', (req, res) => {
    const names = String(req.query.names ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, MAX_NAMES);
    const campaignId = Number(req.query.campaign_id);
    res.json({ details: spellOptionDetails(names, db, Number.isInteger(campaignId) ? campaignId : undefined) });
  });
}
