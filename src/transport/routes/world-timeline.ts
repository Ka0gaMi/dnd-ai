import type { Express, Request, Response } from 'express';
import type { Db } from '../../db/connection.js';
import { getEntity, showSecrets, type EntityKind } from '../../core/codex.js';
import { currentGameDay } from '../../core/world-store.js';

/** How many of an entity's heard events the window shows, newest first before reversing. */
const TIMELINE_LIMIT = 20;

interface TimelineEvent {
  id: number;
  day: number;
  days_ago: number;
  text: string;
}

interface EventRow {
  id: number;
  day: number;
  text: string;
}

/**
 * The world row an entity's timeline hangs off: the row linked by entity_id, else a name match.
 * Place name matches prefer settlement, then area, then danger, mirroring findPlace.
 */
function worldMatch(
  db: Db,
  campaignId: number,
  kind: EntityKind,
  eid: number,
  name: string,
): { column: 'faction_id' | 'place_id'; id: number } | null {
  if (kind === 'faction') {
    const linked = db
      .prepare('SELECT id FROM world_faction WHERE campaign_id = ? AND entity_id = ?')
      .get(campaignId, eid) as { id: number } | undefined;
    if (linked) return { column: 'faction_id', id: linked.id };
    const row = db
      .prepare('SELECT id FROM world_faction WHERE campaign_id = ? AND lower(name) = lower(?)')
      .get(campaignId, name) as { id: number } | undefined;
    return row ? { column: 'faction_id', id: row.id } : null;
  }
  if (kind === 'place') {
    const linked = db
      .prepare('SELECT id FROM world_place WHERE campaign_id = ? AND entity_id = ?')
      .get(campaignId, eid) as { id: number } | undefined;
    if (linked) return { column: 'place_id', id: linked.id };
    const row = db
      .prepare(
        `SELECT id FROM world_place WHERE campaign_id = ? AND lower(name) = lower(?)
          ORDER BY CASE kind WHEN 'settlement' THEN 0 WHEN 'area' THEN 1 ELSE 2 END
          LIMIT 1`,
      )
      .get(campaignId, name) as { id: number } | undefined;
    return row ? { column: 'place_id', id: row.id } : null;
  }
  return null;
}

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

/** The player-safe timeline of a codex faction or place: only events the party actually heard of. */
export default function registerWorldTimelineRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/entities/:eid/timeline', (req, res) => {
    const id = campaignId(req, res);
    if (id === null) return;
    const eid = entityId(req, res);
    if (eid === null) return;

    // The same guard as the entity route: a missing entity, or one outside this campaign, is a 404.
    let entity;
    try {
      entity = getEntity(db, id, eid, { include_hidden: showSecrets(db, id) });
    } catch {
      res.status(404).json({ error: 'no such entity' });
      return;
    }

    const match = worldMatch(db, id, entity.kind, eid, entity.name);
    if (!match) {
      res.json({ timeline: [] });
      return;
    }

    const rows = db
      .prepare(
        `SELECT e.id, e.day,
                (SELECT p.text FROM world_packet p
                   JOIN world_packet_arrival a ON a.packet_id = p.id
                  WHERE p.event_id = e.id AND a.heard = 1
                  ORDER BY p.id LIMIT 1) AS text
           FROM world_event e
          WHERE e.campaign_id = ? AND e.${match.column} = ? AND e.visibility <> 'secret'
            AND EXISTS (
              SELECT 1 FROM world_packet p
                JOIN world_packet_arrival a ON a.packet_id = p.id
               WHERE p.event_id = e.id AND a.heard = 1
            )
          ORDER BY e.day DESC, e.id DESC
          LIMIT ?`,
      )
      .all(id, match.id, TIMELINE_LIMIT) as EventRow[];

    const today = currentGameDay(db, id);
    const timeline: TimelineEvent[] = rows.reverse().map((row) => ({
      id: row.id,
      day: row.day,
      days_ago: today - row.day,
      text: row.text,
    }));
    res.json({ timeline });
  });
}
