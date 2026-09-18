import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { getCharacterSheet } from '../../core/campaign.js';

interface CharacterRow {
  id: number;
  campaign_id: number;
  is_pc: number;
  role: string;
  status: string;
}

function characterRow(db: Db, id: number): CharacterRow | undefined {
  return db
    .prepare('SELECT id, campaign_id, is_pc, role, status FROM character WHERE id = ?')
    .get(id) as CharacterRow | undefined;
}

/**
 * The player's window reads a companion's full sheet through the same mask as their own. The party
 * rule is the one party() uses: the PC, or a companion whose status is still active.
 */
export default function registerCharacterRoutes(app: Express, db: Db): void {
  app.get('/api/characters/:id/sheet', (req, res) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? characterRow(db, id) : undefined;
    const inParty = row !== undefined && (row.is_pc === 1 || (row.role === 'companion' && row.status === 'active'));
    if (!row || !inParty) {
      res.status(404).json({ error: 'no such character' });
      return;
    }
    res.json(getCharacterSheet(db, row.campaign_id, row.id, { for_player: true }));
  });
}
