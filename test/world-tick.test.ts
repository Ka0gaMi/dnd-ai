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
let saveWorldState: (typeof import('../src/core/world-store.js'))['saveWorldState'];
let HOLD_TIMEOUT_DAYS: (typeof import('../src/core/world-resolve.js'))['HOLD_TIMEOUT_DAYS'];

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may have cached dice.ts without the stub, so
  // drop the module cache and import the world modules fresh under the mock.
  vi.resetModules();
  ({ tickTo } = await import('../src/core/world-tick.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, findPlace } = await import('../src/core/region.js'));
  ({ updateSettings } = await import('../src/core/settings.js'));
  ({
    currentGameDay,
    getWorldState,
    listFactions,
    listAgendas,
    listEvents,
    insertAgenda,
    updateAgenda,
    updateFaction,
    saveWorldState,
  } = await import('../src/core/world-store.js'));
  ({ HOLD_TIMEOUT_DAYS } = await import('../src/core/world-resolve.js'));
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

describe('tickTo and the storyteller event cap', () => {
  const styles = [
    { style: 'calm' as const, eventsPerDay: 1 },
    { style: 'steady' as const, eventsPerDay: 2 },
    { style: 'chaotic' as const, eventsPerDay: 4 },
  ];

  for (const { style, eventsPerDay } of styles) {
    it(`keeps every day at or under ${eventsPerDay} events for ${style}, both realms and many seeds`, () => {
      for (const realm of [safe, dangerous]) {
        for (let seed = 1; seed <= 15; seed += 1) {
          const campaignId = withWorld(realm);
          const today = currentGameDay(db, campaignId);
          saveWorldState(db, campaignId, { ...getWorldState(db, campaignId)!, seed });
          updateSettings(db, campaignId, { storyteller: style });

          for (let call = 1; call <= 3; call += 1) tickTo(db, campaignId, today + 60 * call);

          const perDay = db
            .prepare('SELECT day, COUNT(*) AS n FROM world_event WHERE campaign_id = ? GROUP BY day')
            .all(campaignId) as Array<{ day: number; n: number }>;
          expect(perDay.filter(({ n }) => n > eventsPerDay)).toEqual([]);
        }
      }
    }, 120000);
  }
});

describe('tickTo and the quiet window after a major event', () => {
  const cases = [
    { style: 'calm' as const, quietDays: 7 },
    { style: 'steady' as const, quietDays: 4 },
  ];

  for (const { style, quietDays } of cases) {
    it(`gives exactly ${quietDays} quiet days after a major ${style} resolution`, () => {
      const campaignId = withWorld(safe);
      const today = currentGameDay(db, campaignId);
      updateSettings(db, campaignId, { storyteller: style });

      // Clear the seeded agendas so only the forced major resolution can move the quiet window.
      for (const agenda of listAgendas(db, campaignId)) {
        updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
      }

      const faction = listFactions(db, campaignId).find((entry) => entry.type === 'realm')!;
      insertAgenda(db, campaignId, {
        faction_id: faction.id,
        template: 'expand_territory',
        target_kind: 'neighbour_county',
        target_id: null,
        target_name: 'The next county',
        clock_size: 8,
        clock_filled: 8,
        portents: [],
        status: 'active',
        started_day: today,
      });

      const day = today + 1;
      tickTo(db, campaignId, day);

      const quietUntil = getWorldState(db, campaignId)!.quiet_until_day;
      expect(quietUntil).toBe(day + quietDays + 1);
      for (let offset = 1; offset <= quietDays; offset += 1) expect(day + offset).toBeLessThan(quietUntil);
      expect(day + quietDays + 1).toBeGreaterThanOrEqual(quietUntil);
    });
  }
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
    // Stop before the hold times out, so this still exercises the hold rather than the timeout.
    tickTo(db, campaignId, today + HOLD_TIMEOUT_DAYS - 5);

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

  it('resolves a held agenda on its own once the hold times out', () => {
    const campaignId = withWorld(dangerous);
    const today = currentGameDay(db, campaignId);
    for (const existing of listAgendas(db, campaignId)) {
      updateAgenda(db, campaignId, existing.id, { status: 'abandoned' });
    }
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
      clock_filled: 6,
      portents: Array.from({ length: 5 }, (_, index) => ({
        text: `Omen ${index}`,
        fired_day: today,
        heard: false,
      })),
      status: 'held',
      started_day: today,
    });

    updateSettings(db, campaignId, { storyteller: 'steady' });
    tickTo(db, campaignId, today + HOLD_TIMEOUT_DAYS - 1);
    expect(listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!.status).toBe('held');

    tickTo(db, campaignId, today + HOLD_TIMEOUT_DAYS);

    expect(listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!.status).toBe('won');
    expect(listEvents(db, campaignId).some((event) => event.kind === 'agenda_won' && event.agenda_id === agenda.id)).toBe(
      true,
    );
  });
});

describe('tickTo and quiet days', () => {
  /** Abandons the seeded agendas so only the agenda under test can act. */
  function abandonSeeded(campaignId: number): void {
    for (const agenda of listAgendas(db, campaignId)) {
      updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
    }
  }

  it('blocks a full major clock while the quiet window is open, then resolves on the first day after', () => {
    const campaignId = withWorld(dangerous);
    const today = currentGameDay(db, campaignId);
    updateSettings(db, campaignId, { storyteller: 'steady' });
    abandonSeeded(campaignId);

    const realm = listFactions(db, campaignId).find((entry) => entry.type === 'realm')!;
    const agenda = insertAgenda(db, campaignId, {
      faction_id: realm.id,
      template: 'expand_territory',
      target_kind: 'neighbour_county',
      target_id: null,
      target_name: 'The next county',
      clock_size: 8,
      clock_filled: 8,
      portents: [{ text: 'Levies are mustered.', fired_day: today, heard: false }],
      status: 'active',
      started_day: today,
    });

    const windowEnd = today + 4;
    saveWorldState(db, campaignId, { ...getWorldState(db, campaignId)!, quiet_until_day: windowEnd });

    tickTo(db, campaignId, windowEnd - 1);

    const quiet = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(quiet.status).toBe('active');
    expect(quiet.resolved_day).toBeNull();
    expect(quiet.clock_filled).toBe(8);

    tickTo(db, campaignId, windowEnd);

    const resolved = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(resolved.status).toBe('won');
    expect(resolved.resolved_day).toBe(windowEnd);
  });

  it('leaves a held major clock untouched during the quiet window, then resolves it after', () => {
    const campaignId = withWorld(dangerous);
    const today = currentGameDay(db, campaignId);
    updateSettings(db, campaignId, { storyteller: 'steady' });
    abandonSeeded(campaignId);

    const realm = listFactions(db, campaignId).find((entry) => entry.type === 'realm')!;
    const agenda = insertAgenda(db, campaignId, {
      faction_id: realm.id,
      template: 'expand_territory',
      target_kind: 'neighbour_county',
      target_id: null,
      target_name: 'The next county',
      clock_size: 8,
      clock_filled: 8,
      portents: [{ text: 'Levies are mustered.', fired_day: today, heard: false }],
      status: 'held',
      started_day: today,
    });

    const windowEnd = today + 4;
    saveWorldState(db, campaignId, { ...getWorldState(db, campaignId)!, quiet_until_day: windowEnd });

    tickTo(db, campaignId, windowEnd - 1);

    const still = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(still.status).toBe('held');
    expect(still.resolved_day).toBeNull();

    tickTo(db, campaignId, windowEnd);

    const resolved = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(resolved.status).toBe('won');
    expect(resolved.resolved_day).toBe(windowEnd);
  });

  it('still resolves a full minor clock while the quiet window is open', () => {
    const campaignId = withWorld(dangerous);
    const today = currentGameDay(db, campaignId);
    updateSettings(db, campaignId, { storyteller: 'steady' });
    abandonSeeded(campaignId);

    const realm = listFactions(db, campaignId).find((entry) => entry.type === 'realm')!;
    const agenda = insertAgenda(db, campaignId, {
      faction_id: realm.id,
      template: 'build',
      target_kind: 'own_seat',
      target_id: null,
      target_name: 'The seat',
      clock_size: 8,
      clock_filled: 8,
      portents: [{ text: 'Scaffolding rises.', fired_day: today, heard: false }],
      status: 'active',
      started_day: today,
    });

    saveWorldState(db, campaignId, { ...getWorldState(db, campaignId)!, quiet_until_day: today + 4 });

    tickTo(db, campaignId, today + 1);

    const resolved = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(resolved.status).toBe('won');
    expect(resolved.resolved_day).toBe(today + 1);
  });
});

describe('tickTo turn order', () => {
  it('does not always open a day with the lowest-id faction', () => {
    const campaignId = withWorld(dangerous);
    const today = currentGameDay(db, campaignId);
    // Chaotic gives enough multi-faction days in one 60-day tick to tell shuffled order from id order.
    updateSettings(db, campaignId, { storyteller: 'chaotic' });

    const events = tickTo(db, campaignId, today + 60).events;

    const byDay = new Map<number, number[]>();
    for (const event of events) {
      if (event.faction_id === null) continue;
      byDay.set(event.day, [...(byDay.get(event.day) ?? []), event.faction_id]);
    }

    let multiFactionDays = 0;
    let openedWithLowest = 0;
    for (const factions of byDay.values()) {
      if (factions.length < 2) continue;
      multiFactionDays += 1;
      if (factions[0] === Math.min(...factions)) openedWithLowest += 1;
    }

    expect(multiFactionDays).toBeGreaterThan(0);
    expect(openedWithLowest).toBeLessThan(multiFactionDays);
  });

  it('replays an identical ledger from the same seed under shuffling', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');
    const a = withWorld(dangerous, first);
    const b = withWorld(dangerous, second);
    const today = currentGameDay(first, a);

    tickTo(first, a, today + 60);
    tickTo(second, b, today + 60);

    const ledger = (target: Db, campaignId: number): unknown[] =>
      target
        .prepare(
          'SELECT day, kind, text, severity, faction_id, agenda_id FROM world_event WHERE campaign_id = ? ORDER BY day, id',
        )
        .all(campaignId);
    expect(ledger(first, a)).toEqual(ledger(second, b));
  });
});
