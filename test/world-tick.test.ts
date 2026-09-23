// The living world's clock: daily agenda progress, portents, resolutions, the fair-loss hold and
// the storyteller caps, all replayed from a fixed world seed.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';

vi.mock('../src/core/dice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/dice.js')>();
  return { ...actual, randomSeed: () => 12345 };
});

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;

let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let updateSettings: (typeof import('../src/core/settings.js'))['updateSettings'];
let currentGameDay: (typeof import('../src/core/world-store.js'))['currentGameDay'];
let getWorldState: (typeof import('../src/core/world-store.js'))['getWorldState'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let listAgendas: (typeof import('../src/core/world-store.js'))['listAgendas'];
let listEvents: (typeof import('../src/core/world-store.js'))['listEvents'];
let insertAgenda: (typeof import('../src/core/world-store.js'))['insertAgenda'];
let updateAgenda: (typeof import('../src/core/world-store.js'))['updateAgenda'];
let updateFaction: (typeof import('../src/core/world-store.js'))['updateFaction'];

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may have cached dice.ts without the stub, so
  // drop the module cache and import the world modules fresh under the mock.
  vi.resetModules();
  ({ tickTo } = await import('../src/core/world-tick.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, findPlace } = await import('../src/core/region.js'));
  ({ updateSettings } = await import('../src/core/settings.js'));
  ({ currentGameDay, getWorldState, listFactions, listAgendas, listEvents, insertAgenda, updateAgenda, updateFaction } =
    await import('../src/core/world-store.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(target: Db = db): number {
  return createCampaign(target, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
}

function withRegion(realm: unknown, target: Db = db): number {
  const campaignId = newCampaign(target);
  importRegion(target, campaignId, realm, { source: 'generated' });
  return campaignId;
}

function withWorld(realm: unknown, target: Db = db): number {
  const campaignId = withRegion(realm, target);
  ensureWorld(target, campaignId);
  return campaignId;
}

function eventsByDay(events: Array<{ day: number }>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const event of events) counts.set(event.day, (counts.get(event.day) ?? 0) + 1);
  return counts;
}

describe('tickTo without a world', () => {
  it('returns an empty result and writes nothing', () => {
    const campaignId = withRegion(safe);
    const today = currentGameDay(db, campaignId);

    const result = tickTo(db, campaignId, today + 30);

    expect(result).toEqual({ from_day: today + 30, to_day: today + 30, events: [] });
    expect(getWorldState(db, campaignId)).toBeNull();
    expect(listEvents(db, campaignId)).toEqual([]);
  });
});

describe('tickTo with the steady storyteller', () => {
  it('advances to the target day and fires portents within the daily cap', () => {
    const campaignId = withWorld(safe);
    const today = currentGameDay(db, campaignId);

    const result = tickTo(db, campaignId, today + 30);

    expect(getWorldState(db, campaignId)!.last_tick_day).toBe(today + 30);
    expect(result.to_day).toBe(today + 30);
    expect(result.events.some((event) => event.kind === 'portent')).toBe(true);
    for (const count of eventsByDay(result.events).values()) expect(count).toBeLessThanOrEqual(2);
  });

  it('replays identical events from the same world seed', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');
    const a = withWorld(safe, first);
    const b = withWorld(safe, second);
    const today = currentGameDay(first, a);

    const ra = tickTo(first, a, today + 30);
    const rb = tickTo(second, b, today + 30);

    const shape = (event: { kind: string; day: number; text: string; agenda_id: number | null }): unknown => ({
      kind: event.kind,
      day: event.day,
      text: event.text,
      agenda_id: event.agenda_id,
    });
    expect(ra.events.map(shape)).toEqual(rb.events.map(shape));
  });

  it('caps a single tick at MAX_DAYS_PER_TICK and continues on the next call', () => {
    const campaignId = withWorld(safe);
    const today = currentGameDay(db, campaignId);

    tickTo(db, campaignId, today + 500);
    expect(getWorldState(db, campaignId)!.last_tick_day).toBe(today + 60);

    tickTo(db, campaignId, today + 500);
    expect(getWorldState(db, campaignId)!.last_tick_day).toBe(today + 120);
  });
});

describe('tickTo with the storyteller off', () => {
  it('moves the clock without events', () => {
    const campaignId = withWorld(safe);
    const today = currentGameDay(db, campaignId);
    updateSettings(db, campaignId, { storyteller: 'off' });

    const result = tickTo(db, campaignId, today + 30);

    expect(getWorldState(db, campaignId)!.last_tick_day).toBe(today + 30);
    expect(result.events).toEqual([]);
  });
});

describe('tickTo with the calm storyteller', () => {
  it('never puts more than one event in a day', () => {
    const campaignId = withWorld(safe);
    const today = currentGameDay(db, campaignId);
    updateSettings(db, campaignId, { storyteller: 'calm' });

    const result = tickTo(db, campaignId, today + 60);

    for (const count of eventsByDay(result.events).values()) expect(count).toBeLessThanOrEqual(1);
  });
});

describe('tickTo over many days', () => {
  it('resolves agendas and hands each resolved faction a new active agenda', () => {
    const campaignId = withWorld(safe);
    const today = currentGameDay(db, campaignId);

    const events = [];
    for (let call = 1; call <= 4; call += 1) events.push(...tickTo(db, campaignId, today + 60 * call).events);

    const won = events.filter((event) => event.kind === 'agenda_won');
    expect(won.length).toBeGreaterThan(0);

    const active = listAgendas(db, campaignId, { status: 'active' });
    const resolvedFactions = new Set(won.map((event) => event.faction_id));
    for (const factionId of resolvedFactions) {
      expect(active.some((agenda) => agenda.faction_id === factionId)).toBe(true);
    }
  });
});

describe('tickTo and the fair-loss hold', () => {
  it('holds a known irreversible clock until two portents are heard', () => {
    const campaignId = withWorld(dangerous);
    const today = currentGameDay(db, campaignId);
    const monster = listFactions(db, campaignId).find((faction) => faction.type === 'monsters')!;
    const settlement = findPlace(db, campaignId, 'Frostcot')!;
    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE id = ?').run(settlement.id);

    const agenda = insertAgenda(db, campaignId, {
      faction_id: monster.id,
      template: 'monsters_grow',
      target_kind: 'settlement',
      target_id: settlement.id,
      target_name: settlement.name,
      clock_size: 6,
      clock_filled: 5,
      portents: Array.from({ length: 5 }, (_, index) => ({
        text: `Omen ${index}`,
        fired_day: null,
        heard: false,
      })),
      status: 'active',
      started_day: today,
    });

    updateSettings(db, campaignId, { storyteller: 'chaotic' });
    updateFaction(db, campaignId, monster.id, { resources: 10 });
    tickTo(db, campaignId, today + 60);

    const held = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(held.status).toBe('held');
    expect(held.clock_filled).toBeGreaterThanOrEqual(held.clock_size);
    expect(listEvents(db, campaignId).filter((event) => event.kind === 'agenda_won' && event.agenda_id === agenda.id)).toEqual(
      [],
    );

    updateAgenda(db, campaignId, agenda.id, {
      portents: held.portents.map((portent, index) => (index < 2 ? { ...portent, heard: true } : portent)),
    });
    tickTo(db, campaignId, today + 120);

    const resolved = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(resolved.status).toBe('won');
    expect(listEvents(db, campaignId).some((event) => event.kind === 'agenda_won' && event.agenda_id === agenda.id)).toBe(
      true,
    );
  });
});
