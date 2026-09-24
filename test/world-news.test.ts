import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { importRegion, type RegionView, type WorldPlace } from '../src/core/region.js';
import { MILES_PER_HEX, placeDistance } from '../src/core/region-graph.js';
import { deliverNews, emitPacket, MILES_PER_DAY, newsRadiusDays, travelDays } from '../src/core/world-news.js';
import { insertEvent, type WorldEvent } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let db: Db;
let campaignId: number;
let view: RegionView;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  view = importRegion(db, campaignId, safe, { source: 'generated' });
});

function place(name: string): WorldPlace {
  const found = view.places.find((p) => p.name === name);
  if (!found) throw new Error(`No place named ${name}`);
  return found;
}

function event(
  placeId: number | null,
  severity: number,
  day: number,
  visibility: WorldEvent['visibility'] = 'public',
): WorldEvent {
  return insertEvent(db, campaignId, {
    day,
    kind: 'disaster',
    text: 'A fire in the market.',
    severity,
    place_id: placeId,
    faction_id: null,
    agenda_id: null,
    causes: [],
    effects: {},
    visibility,
  });
}

function arrivalDays(packetId: number): Record<string, number> {
  const rows = db
    .prepare('SELECT place_id, day FROM world_packet_arrival WHERE packet_id = ?')
    .all(packetId) as Array<{ place_id: number; day: number }>;
  return Object.fromEntries(rows.map((row) => [view.places.find((p) => p.id === row.place_id)!.name, row.day]));
}

describe('newsRadiusDays', () => {
  it('maps each severity to its reach in days', () => {
    expect([1, 2, 3, 4, 5].map(newsRadiusDays)).toEqual([2, 5, 10, 20, 40]);
  });
});

describe('travelDays', () => {
  it('is zero within the same place', () => {
    expect(travelDays(view, place('Redham'), place('Redham'))).toBe(0);
  });

  it('follows a road at 24 miles a day', () => {
    expect(travelDays(view, place('Stormcourtby'), place('Redham'))).toBe(1);
    expect(travelDays(view, place('Redham'), place('Ficengwind'))).toBe(4);
  });

  it('slows off-road travel by half again', () => {
    const from = place('Redham');
    const to = place('Ironfall Fens');
    const expected = Math.ceil((placeDistance(from, to) * MILES_PER_HEX * 1.5) / MILES_PER_DAY);
    expect(travelDays(view, from, to)).toBe(expected);
    expect(expected).toBe(1);
  });
});

describe('emitPacket', () => {
  it('writes one arrival per settlement inside a severity-1 radius', () => {
    const result = emitPacket(db, campaignId, event(place('Redham').id, 1, 100));

    expect(result.packet_id).not.toBeNull();
    expect(result.arrivals).toBe(2);
    expect(arrivalDays(result.packet_id!)).toEqual({ Redham: 100, Stormcourtby: 101 });
  });

  it('reaches every settlement at severity 5', () => {
    const result = emitPacket(db, campaignId, event(place('Redham').id, 5, 100));
    const settlements = view.places.filter((p) => p.kind === 'settlement').map((p) => p.name);

    expect(result.arrivals).toBe(settlements.length);
    expect(Object.keys(arrivalDays(result.packet_id!)).sort()).toEqual(settlements.sort());
  });

  it('writes nothing for an event with no place', () => {
    const result = emitPacket(db, campaignId, event(null, 3, 100));

    expect(result).toEqual({ packet_id: null, arrivals: 0 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM world_packet').get() as { n: number }).n).toBe(0);
  });

  it('writes nothing for a campaign without a region', () => {
    const other = createCampaign(db, { name: 'No Region', story_shape: 'structured' }).campaign_id;
    const orphan: WorldEvent = { ...event(place('Redham').id, 3, 100) };

    expect(emitPacket(db, other, orphan)).toEqual({ packet_id: null, arrivals: 0 });
  });

  it('writes no packet or arrival for a secret event', () => {
    const result = emitPacket(db, campaignId, event(place('Redham').id, 3, 100, 'secret'));

    expect(result).toEqual({ packet_id: null, arrivals: 0 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM world_packet').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM world_packet_arrival').get() as { n: number }).n).toBe(0);
  });

  it('still emits for a discreet event', () => {
    const result = emitPacket(db, campaignId, event(place('Redham').id, 1, 100, 'discreet'));

    expect(result.packet_id).not.toBeNull();
    expect(result.arrivals).toBe(2);
  });
});

describe('deliverNews', () => {
  it('turns an arrived packet into a heard rumour once, at the right scope', () => {
    const stormcourtby = place('Stormcourtby');
    const result = emitPacket(db, campaignId, event(place('Redham').id, 1, 100));

    expect(deliverNews(db, campaignId, stormcourtby.id, 100)).toEqual([]);

    const created = deliverNews(db, campaignId, stormcourtby.id, 101);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ text: 'A fire in the market.', truth: 'true' });
    const rumour = db
      .prepare('SELECT scope, truth, source_kind, heard_at FROM rumour WHERE id = ?')
      .get(created[0].rumour_id) as { scope: string; truth: string; source_kind: string; heard_at: string | null };
    expect(rumour).toMatchObject({ scope: 'region', truth: 'true', source_kind: 'world' });
    expect(rumour.heard_at).not.toBeNull();

    const arrival = db
      .prepare('SELECT heard FROM world_packet_arrival WHERE packet_id = ? AND place_id = ?')
      .get(result.packet_id, stormcourtby.id) as { heard: number };
    expect(arrival.heard).toBe(1);

    expect(deliverNews(db, campaignId, stormcourtby.id, 101)).toEqual([]);
  });

  it('marks a packet from the origin as a location rumour', () => {
    const redham = place('Redham');
    emitPacket(db, campaignId, event(redham.id, 1, 100));

    const created = deliverNews(db, campaignId, redham.id, 100);
    expect(created).toHaveLength(1);
    const rumour = db.prepare('SELECT scope FROM rumour WHERE id = ?').get(created[0].rumour_id) as { scope: string };
    expect(rumour.scope).toBe('location');
  });

  it('makes one campaign-wide rumour when a packet reached two settlements', () => {
    const redham = place('Redham');
    const stormcourtby = place('Stormcourtby');
    const packet = emitPacket(db, campaignId, event(redham.id, 1, 100));

    const first = deliverNews(db, campaignId, redham.id, 100);
    const second = deliverNews(db, campaignId, stormcourtby.id, 101);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    const rumours = db
      .prepare('SELECT COUNT(*) AS n FROM rumour WHERE campaign_id = ?')
      .get(campaignId) as { n: number };
    expect(rumours.n).toBe(1);
    const arrivals = db
      .prepare('SELECT COUNT(*) AS n, SUM(heard) AS heard FROM world_packet_arrival WHERE packet_id = ?')
      .get(packet.packet_id) as { n: number; heard: number };
    expect(arrivals).toEqual({ n: 2, heard: 2 });
  });
});
