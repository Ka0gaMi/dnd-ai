import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { addJournalEntry, readJournal } from '../../core/story.js';

/** The journal is the player's: their window writes it, the DM only ever reads it. */
export default function registerJournalRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/journal', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
    res.json(readJournal(db, id, limit));
  });

  app.post('/api/campaigns/:id/journal', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    try {
      res.status(201).json(addJournalEntry(db, { campaign_id: id, text: text.trim() }));
    } catch {
      res.status(404).json({ error: 'no such campaign' });
    }
  });
}
