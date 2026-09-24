// The world-timeline route: what a codex faction or place has actually done, as far as the party has
// heard. Unheard and secret events stay out, and the route never writes.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldPlace } from '../src/core/region.js';
import type { WorldEvent } from '../src/core/world-store.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let base: string;
let db: Db;
let stop: () => Promise<void>;
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];
let currentGameDay: (typeof import('../src/core/world-store.js'))['currentGameDay'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let insertEvent: (typeof import('../src/core/world-store.js'))['insertEvent'];
let emitPacket: (typeof import('../src/core/world-news.js'))['emitPacket'];
let deliverNews: (typeof import('../src/core/world-news.js'))['deliverNews'];
let upsertEntity: (typeof import('../src/core/codex.js'))['upsertEntity'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached these modules, so import them fresh here.
  vi.resetModules();
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ tickTo } = await import('../src/core/world-tick.js'));
  ({ currentGameDay, listFactions, insertEvent } = await import('../src/core/world-store.js'));
  ({ emitPacket, deliverNews } = await import('../src/core/world-news.js'));
  ({ upsertEntity } = await import('../src/core/codex.js'));
  const { openDb } = await import('../src/db/connection.js');
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'worldtimeline0123456789abcdef01' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

function newCampaign(name = 'Timeline Campaign'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

/** A campaign with the safe realm imported and its living world seeded, plus its settlements. */
function withWorld(): { id: number; settlements: WorldPlace[] } {
  const id = newCampaign();
  const view = importRegion(db, id, safe, { source: 'generated' });
  ensureWorld(db, id);
  return { id, settlements: view.places.filter((place) => place.kind === 'settlement') };
}

function worldEvent(
  campaignId: number,
  opts: {
    day: number;
    text: string;
    factionId?: number;
    placeId?: number;
    visibility?: WorldEvent['visibility'];
  },
): WorldEvent {
  return insertEvent(db, campaignId, {
    day: opts.day,
    kind: 'agenda',
    text: opts.text,
    severity: 2,
    place_id: opts.placeId ?? null,
    faction_id: opts.factionId ?? null,
    agenda_id: null,
    causes: [],
    effects: {},
    visibility: opts.visibility ?? 'public',
  });
}

/** Emits the event's news packet and marks every arrival as heard. */
function hearPacket(campaignId: number, event: WorldEvent): void {
  const { packet_id } = emitPacket(db, campaignId, event);
  if (packet_id === null) throw new Error('expected a news packet for this event');
  db.prepare('UPDATE world_packet_arrival SET heard = 1 WHERE packet_id = ?').run(packet_id);
}

/** Inserts a heard packet for a secret event, which emitPacket refuses to make. */
function hearSecretPacket(campaignId: number, event: WorldEvent, placeId: number, day: number): void {
  const packetId = Number(
    db
      .prepare('INSERT INTO world_packet (campaign_id, event_id, origin_place_id, truth, text) VALUES (?, ?, ?, ?, ?)')
      .run(campaignId, event.id, placeId, 'true', event.text).lastInsertRowid,
  );
  db.prepare('INSERT INTO world_packet_arrival (packet_id, place_id, day, heard) VALUES (?, ?, ?, 1)').run(
    packetId,
    placeId,
    day,
  );
}

function entityOf(campaignId: number, kind: 'faction' | 'place' | 'npc', name: string): number {
  return upsertEntity(db, { campaign_id: campaignId, kind, name }).entity.id;
}

function getTimeline(campaignId: number | string, eid: number | string): Promise<Response> {
  return fetch(`${base}/api/campaigns/${campaignId}/entities/${eid}/timeline`);
}

describe('GET /api/campaigns/:id/entities/:eid/timeline refusals', () => {
  it('400s a non-integer campaign id', async () => {
    const res = await getTimeline('abc', 1);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad campaign id' });
  });

  it('400s a non-integer entity id', async () => {
    const res = await getTimeline(1, 'abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad entity id' });
  });

  it('404s an unknown campaign', async () => {
    const res = await getTimeline(999999, 1);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such entity' });
  });

  it('404s an entity that does not exist in this campaign', async () => {
    const id = newCampaign();
    const res = await getTimeline(id, 999999);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such entity' });
  });

  it('404s an entity hidden from the player, one belonging to another campaign', async () => {
    const mine = newCampaign('Timeline Mine');
    const other = newCampaign('Timeline Other');
    const hidden = entityOf(other, 'faction', 'The Hidden Court');

    const res = await getTimeline(mine, hidden);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such entity' });
  });

  it('answers an empty timeline for an entity that is neither a faction nor a place', async () => {
    const { id } = withWorld();
    const npc = entityOf(id, 'npc', 'Mira Vance');

    const res = await getTimeline(id, npc);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ timeline: [] });
  });
});

describe('GET /api/campaigns/:id/entities/:eid/timeline for a faction', () => {
  it('lists only the heard events, oldest first, with days_ago', async () => {
    const { id, settlements } = withWorld();
    const today = currentGameDay(db, id);
    const faction = listFactions(db, id)[0]!;
    const other = listFactions(db, id)[1]!;
    const eid = entityOf(id, 'faction', faction.name);
    const origin = settlements[0]!.id;

    const older = worldEvent(id, {
      day: today - 10,
      text: 'Bridges burn at dawn.',
      factionId: faction.id,
      placeId: origin,
    });
    hearPacket(id, older);

    const newer = worldEvent(id, {
      day: today - 4,
      text: 'The guild raises its banner.',
      factionId: faction.id,
      placeId: origin,
    });
    emitPacket(db, id, newer);
    deliverNews(db, id, origin, today);

    const unheard = worldEvent(id, {
      day: today - 2,
      text: 'Nobody in the party has heard this.',
      factionId: faction.id,
      placeId: origin,
    });
    emitPacket(db, id, unheard);

    const secret = worldEvent(id, {
      day: today - 1,
      text: 'A deed done in the dark.',
      factionId: faction.id,
      placeId: origin,
      visibility: 'secret',
    });
    hearSecretPacket(id, secret, origin, today);

    const elsewhere = worldEvent(id, {
      day: today - 3,
      text: 'Another power moves.',
      factionId: other.id,
      placeId: origin,
    });
    hearPacket(id, elsewhere);

    const res = await getTimeline(id, eid);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      timeline: [
        { id: older.id, day: today - 10, days_ago: 10, text: 'Bridges burn at dawn.' },
        { id: newer.id, day: today - 4, days_ago: 4, text: 'The guild raises its banner.' },
      ],
    });
  });

  it('keeps only the last 20 heard events, oldest first', async () => {
    const { id, settlements } = withWorld();
    const today = currentGameDay(db, id);
    const faction = listFactions(db, id)[0]!;
    const eid = entityOf(id, 'faction', faction.name);
    const origin = settlements[0]!.id;

    const ids: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const event = worldEvent(id, {
        day: today - 25 + i,
        text: `Event ${i}.`,
        factionId: faction.id,
        placeId: origin,
      });
      hearPacket(id, event);
      ids.push(event.id);
    }

    const res = await getTimeline(id, eid);
    const { timeline } = (await res.json()) as { timeline: Array<{ id: number }> };

    expect(timeline).toHaveLength(20);
    expect(timeline.map((entry) => entry.id)).toEqual(ids.slice(5));
  });
});

describe('GET /api/campaigns/:id/entities/:eid/timeline for a place', () => {
  it('lists the heard events at that place only', async () => {
    const { id, settlements } = withWorld();
    const today = currentGameDay(db, id);
    const here = settlements.find((place) => place.name === 'Redham')!;
    const there = settlements.find((place) => place.id !== here.id)!;
    const eid = entityOf(id, 'place', here.name);

    const heard = worldEvent(id, { day: today - 6, text: 'A fire in the market.', placeId: here.id });
    hearPacket(id, heard);
    const farAway = worldEvent(id, { day: today - 5, text: 'A flood elsewhere.', placeId: there.id });
    hearPacket(id, farAway);

    const res = await getTimeline(id, eid);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      timeline: [{ id: heard.id, day: today - 6, days_ago: 6, text: 'A fire in the market.' }],
    });
  });
});

describe('the world-timeline route is read-only', () => {
  it('writes nothing, even with the world ticking behind it', async () => {
    const { id, settlements } = withWorld();
    const today = currentGameDay(db, id);
    const faction = listFactions(db, id)[0]!;
    const eid = entityOf(id, 'faction', faction.name);
    const origin = settlements[0]!.id;

    const event = worldEvent(id, {
      day: today - 3,
      text: 'Something stirs in the marches.',
      factionId: faction.id,
      placeId: origin,
    });
    hearPacket(id, event);
    tickTo(db, id, today + 30);

    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const snapshot = () => ({
      entity: count('entity'),
      event: count('event'),
      world_state: db.prepare('SELECT last_tick_day, quiet_until_day FROM world_state WHERE campaign_id = ?').get(id),
      world_event: count('world_event'),
      world_packet: count('world_packet'),
      world_packet_arrival: count('world_packet_arrival'),
      world_faction: count('world_faction'),
      rumour: count('rumour'),
    });

    const before = snapshot();
    const res = await getTimeline(id, eid);

    expect(res.status).toBe(200);
    expect(snapshot()).toEqual(before);
  });
});
