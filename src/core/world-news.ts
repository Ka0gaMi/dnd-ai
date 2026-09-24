// News of a world event travels the region's roads and sea routes at a fixed pace, becoming a
// rumour the party hears once they are at a settlement the packet has reached.
import type { Db } from '../db/connection.js';
import { MILES_PER_HEX, placeDistance, routeBetween } from './region-graph.js';
import { getRegion, type RegionView, type WorldPlace } from './region.js';
import { addRumour, type RumourScope, type RumourTruth } from './story.js';
import type { WorldEvent } from './world-store.js';

export const MILES_PER_DAY = 24;

/** Off-road travel is half again as slow as a road or sea route. */
const OFF_ROAD_FACTOR = 1.5;

const NEWS_RADIUS_DAYS: Record<number, number> = { 1: 2, 2: 5, 3: 10, 4: 20, 5: 40 };

export function newsRadiusDays(severity: number): number {
  return NEWS_RADIUS_DAYS[severity] ?? 0;
}

export function travelDays(view: RegionView, from: WorldPlace, to: WorldPlace): number {
  if (from.id === to.id) return 0;
  const route = routeBetween(view, from, to);
  const miles = route ? route.hexes * MILES_PER_HEX : placeDistance(from, to) * MILES_PER_HEX * OFF_ROAD_FACTOR;
  return Math.ceil(miles / MILES_PER_DAY);
}

interface ArrivalRow {
  packet_id: number;
  origin_place_id: number | null;
  truth: string;
  text: string;
}

export function emitPacket(
  db: Db,
  campaignId: number,
  event: WorldEvent,
  options: { truth?: 'true' | 'twisted' | 'false'; text?: string } = {},
): { packet_id: number | null; arrivals: number } {
  if (event.visibility === 'secret') return { packet_id: null, arrivals: 0 };
  const originPlaceId = event.place_id;
  const view = getRegion(db, campaignId);
  if (originPlaceId === null || view === null) return { packet_id: null, arrivals: 0 };
  const origin = view.places.find((place) => place.id === originPlaceId);
  if (!origin) return { packet_id: null, arrivals: 0 };

  const radius = newsRadiusDays(event.severity);
  const targets = view.places
    .filter((place) => place.kind === 'settlement')
    .map((place) => ({ place, days: travelDays(view, origin, place) }))
    .filter((entry) => entry.days <= radius);

  return db.transaction(() => {
    const packetId = Number(
      db
        .prepare(
          'INSERT INTO world_packet (campaign_id, event_id, origin_place_id, truth, text) VALUES (?, ?, ?, ?, ?)',
        )
        .run(campaignId, event.id, originPlaceId, options.truth ?? 'true', options.text ?? event.text).lastInsertRowid,
    );
    const insertArrival = db.prepare(
      'INSERT INTO world_packet_arrival (packet_id, place_id, day, heard) VALUES (?, ?, ?, 0)',
    );
    for (const entry of targets) insertArrival.run(packetId, entry.place.id, event.day + entry.days);
    return { packet_id: packetId, arrivals: targets.length };
  })();
}

export function deliverNews(
  db: Db,
  campaignId: number,
  placeId: number,
  today: number,
): Array<{ rumour_id: number; text: string; truth: string }> {
  const rows = db
    .prepare(
      `SELECT a.packet_id, p.origin_place_id, p.truth, p.text
         FROM world_packet_arrival a
         JOIN world_packet p ON p.id = a.packet_id
        WHERE p.campaign_id = ? AND a.place_id = ? AND a.day <= ? AND a.heard = 0
        ORDER BY a.day, a.packet_id`,
    )
    .all(campaignId, placeId, today) as ArrivalRow[];
  if (rows.length === 0) return [];

  return db.transaction(() => {
    const markHeard = db.prepare('UPDATE rumour SET heard_at = ? WHERE id = ? AND heard_at IS NULL');
    const markArrival = db.prepare('UPDATE world_packet_arrival SET heard = 1 WHERE packet_id = ?');
    const created: Array<{ rumour_id: number; text: string; truth: string }> = [];
    for (const row of rows) {
      const scope: RumourScope = row.origin_place_id === placeId ? 'location' : 'region';
      const rumour = addRumour(db, {
        campaign_id: campaignId,
        text: row.text,
        scope,
        truth: row.truth as RumourTruth,
        source_kind: 'world',
      });
      markHeard.run(new Date().toISOString(), rumour.id);
      markArrival.run(row.packet_id);
      created.push({ rumour_id: rumour.id, text: row.text, truth: row.truth });
    }
    return created;
  })();
}
