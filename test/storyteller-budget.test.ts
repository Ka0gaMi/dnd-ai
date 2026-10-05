// The storyteller as a perception budget: only news that would reach the party's place spends the day's cap,
// distant agendas run on, portents stay local, and with no known party place the old global cap holds.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldPlace } from '../src/core/region.js';
import type { WorldAgenda, WorldFaction } from '../src/core/world-store.js';

const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;
const medium = JSON.parse(readFileSync(new URL('./fixtures/realm-medium.json', import.meta.url), 'utf8')) as unknown;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let campaign: typeof import('../src/core/campaign.js');
let region: typeof import('../src/core/region.js');
let settings: typeof import('../src/core/settings.js');
let storyteller: typeof import('../src/core/storyteller.js');
let seed: typeof import('../src/core/world-seed.js');
let store: typeof import('../src/core/world-store.js');
let news: typeof import('../src/core/world-news.js');
let resolve: typeof import('../src/core/world-resolve.js');
let faithStore: typeof import('../src/core/world-faith-store.js');
let dice: typeof import('../src/core/dice.js');
let placeMatch: typeof import('../src/core/place-match.js');
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  campaign = await import('../src/core/campaign.js');
  region = await import('../src/core/region.js');
  settings = await import('../src/core/settings.js');
  storyteller = await import('../src/core/storyteller.js');
  seed = await import('../src/core/world-seed.js');
  store = await import('../src/core/world-store.js');
  news = await import('../src/core/world-news.js');
  resolve = await import('../src/core/world-resolve.js');
  faithStore = await import('../src/core/world-faith-store.js');
  dice = await import('../src/core/dice.js');
  placeMatch = await import('../src/core/place-match.js');
  ({ tickTo } = await import('../src/core/world-tick.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

/** A world on the given map, seeded under a pinned Math.random so two calls build the same world. */
function withWorld(realm: unknown): number {
  let state = 42;
  const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  try {
    const campaignId = campaign.createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
    region.importRegion(db, campaignId, realm, { source: 'generated' });
    seed.ensureWorld(db, campaignId);
    return campaignId;
  } finally {
    spy.mockRestore();
  }
}

function partyAt(campaignId: number, location: string): void {
  campaign.saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'They make camp.', scene_location: location });
}

function placeNamed(campaignId: number, name: string): WorldPlace {
  return region.getRegion(db, campaignId)!.places.find((place) => place.name === name)!;
}

/** Days the news of a place takes to reach another, as emitPacket reckons it. */
function daysBetween(campaignId: number, from: WorldPlace, to: WorldPlace): number {
  return news.travelDays(region.getRegion(db, campaignId)!, from, to);
}

/** A settlement far off every road and beyond even a severity-4 radius from the rest of the map. */
function addFarSettlement(campaignId: number): WorldPlace {
  db.prepare(
    `INSERT INTO world_place (campaign_id, kind, name, q, r, hexes_json, tags_json, info, link, seed, created_at)
     VALUES (?, 'settlement', 'Farhold', 100, 100, '["q100_r100"]', '{}', '', NULL, NULL, ?)`,
  ).run(campaignId, new Date().toISOString());
  return placeNamed(campaignId, 'Farhold');
}

function abandonSeeded(campaignId: number): void {
  for (const agenda of store.listAgendas(db, campaignId)) {
    store.updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
  }
}

/** Moves the world's clock to `day`, away from any faith month, with no quiet window open. */
function startAt(campaignId: number, day: number): void {
  store.saveWorldState(db, campaignId, { ...store.getWorldState(db, campaignId)!, last_tick_day: day, quiet_until_day: 0 });
}

function openFactions(campaignId: number): WorldFaction[] {
  return store.listFactions(db, campaignId).filter((faction) => faction.secrecy === 'open');
}

/** An agenda at a place: a full build clock with its warnings fired, unless the patch says otherwise. */
function agendaAt(
  campaignId: number,
  faction: WorldFaction,
  place: WorldPlace,
  patch: Partial<Pick<WorldAgenda, 'template' | 'target_kind' | 'clock_filled' | 'portents' | 'status'>> = {},
): WorldAgenda {
  return store.insertAgenda(db, campaignId, {
    faction_id: faction.id,
    template: 'build',
    target_kind: 'own_seat',
    target_id: place.id,
    target_name: place.name,
    clock_size: 6,
    clock_filled: 6,
    portents: [
      { text: 'Scaffolding rises.', fired_day: 1, heard: false },
      { text: 'Masons arrive.', fired_day: 1, heard: false },
    ],
    status: 'active',
    started_day: 1,
    ...patch,
  });
}

const unfired = [
  { text: 'Scaffolding rises.', fired_day: null, heard: false },
  { text: 'Masons arrive.', fired_day: null, heard: false },
];

function agendaNow(campaignId: number, agenda: WorldAgenda): WorldAgenda {
  return store.listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
}

/** Per day, the events whose news reaches a place; a brood wiped out by a win is that win's own news. */
function perceivedPerDay(campaignId: number, placeId: number): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT e.day AS day, COUNT(*) AS n FROM world_event e
         JOIN world_packet p ON p.event_id = e.id
         JOIN world_packet_arrival a ON a.packet_id = p.id
        WHERE e.campaign_id = ? AND a.place_id = ? AND e.kind != 'faction_destroyed'
        GROUP BY e.day`,
    )
    .all(campaignId, placeId) as Array<{ day: number; n: number }>;
  return new Map(rows.map((row) => [row.day, row.n]));
}

function totalPerDay(campaignId: number): Map<number, number> {
  const rows = db
    .prepare(
      "SELECT day, COUNT(*) AS n FROM world_event WHERE campaign_id = ? AND kind != 'faction_destroyed' GROUP BY day",
    )
    .all(campaignId) as Array<{ day: number; n: number }>;
  return new Map(rows.map((row) => [row.day, row.n]));
}

/** Ticks `days` days from today in 60-day calls. */
function tickDays(campaignId: number, days: number): void {
  const today = store.currentGameDay(db, campaignId);
  for (let day = today + 60; day <= today + days; day += 60) tickTo(db, campaignId, day);
}

describe('turbulence', () => {
  it('scales threat by style and stops the world when off', () => {
    expect(storyteller.turbulence('calm')).toBe(0.5);
    expect(storyteller.turbulence('steady')).toBe(1);
    expect(storyteller.turbulence('chaotic')).toBe(1.5);
    expect(storyteller.turbulence('off')).toBe(0);
    expect(storyteller.turbulence('steady')).toBe(storyteller.STORYTELLER_CAPS.steady.threat_scale);
  });
});

describe('portent reach', () => {
  it("carries a portent two days, a discreet faction's one, and never the old five", () => {
    const campaignId = withWorld(large);
    const view = region.getRegion(db, campaignId)!;
    const origin = placeNamed(campaignId, 'Dione');
    const settlements = view.places.filter((place) => place.kind === 'settlement');

    for (const [secrecy, reach] of [
      ['open', 2],
      ['discreet', 1],
    ] as const) {
      const faction = store.listFactions(db, campaignId).find((entry) => entry.secrecy === secrecy)!;
      const agenda = agendaAt(campaignId, faction, origin, { clock_filled: 3, portents: unfired });
      const event = resolve.firePortent(db, campaignId, agenda, 0, 400);
      expect(resolve.portentRadiusDays(event.visibility)).toBe(reach);

      const arrivals = new Map(
        (
          db
            .prepare(
              'SELECT a.place_id, a.day FROM world_packet_arrival a JOIN world_packet p ON p.id = a.packet_id WHERE p.event_id = ?',
            )
            .all(event.id) as Array<{ place_id: number; day: number }>
        ).map((row) => [row.place_id, row.day]),
      );
      const inReach = settlements.filter((place) => news.travelDays(view, origin, place) <= reach);
      expect([...arrivals.keys()].sort((a, b) => a - b)).toEqual(inReach.map((place) => place.id).sort((a, b) => a - b));
      for (const place of inReach) expect(arrivals.get(place.id)).toBe(400 + news.travelDays(view, origin, place));
    }

    // Towns three to five days off would have heard it under the old severity radius.
    const days = settlements.map((place) => news.travelDays(view, origin, place));
    expect(days.some((day) => day > 2 && day <= news.newsRadiusDays(2))).toBe(true);
  });
});

describe('the perception budget', () => {
  it("lets distant agendas resolve and warn on a full day while the party's own news waits", () => {
    const campaignId = withWorld(large);
    partyAt(campaignId, 'Red Mill');
    abandonSeeded(campaignId);
    const home = placeNamed(campaignId, 'Red Mill');
    const far = placeNamed(campaignId, 'Azurefire');
    // A build's win travels five days and its portents two, so nothing from Azurefire reaches Red Mill.
    expect(daysBetween(campaignId, far, home)).toBeGreaterThan(news.newsRadiusDays(2));
    startAt(campaignId, 400);

    const [a, b, c, d, e, f] = openFactions(campaignId);
    // The three local wins are held, so they act before every active agenda and fill steady's two-event day.
    const local = [a!, b!, c!].map((faction) => agendaAt(campaignId, faction, home, { status: 'held' }));
    const distantWin = agendaAt(campaignId, d!, far);
    const distantSign = agendaAt(campaignId, e!, far, { clock_filled: 3, portents: unfired });
    const localSign = agendaAt(campaignId, f!, home, { clock_filled: 3, portents: unfired });

    tickTo(db, campaignId, 401);

    expect(perceivedPerDay(campaignId, home.id).get(401)).toBe(2);
    expect(local.map((agenda) => agendaNow(campaignId, agenda).status).sort()).toEqual(['held', 'won', 'won']);
    expect(agendaNow(campaignId, distantWin)).toMatchObject({ status: 'won', resolved_day: 401 });
    expect(agendaNow(campaignId, distantSign).portents[0]!.fired_day).toBe(401);
    expect(agendaNow(campaignId, localSign).portents[0]!.fired_day).toBeNull();
    expect(totalPerDay(campaignId).get(401)).toBeGreaterThan(2);

    // The waiting local win goes first the next day.
    tickTo(db, campaignId, 402);
    expect(local.every((agenda) => agendaNow(campaignId, agenda).status === 'won')).toBe(true);
  });

  it('opens the quiet window only after a major the party perceives, and never holds a distant one', () => {
    const campaignId = withWorld(large);
    const farhold = addFarSettlement(campaignId);
    partyAt(campaignId, 'Red Mill');
    abandonSeeded(campaignId);
    const home = placeNamed(campaignId, 'Red Mill');
    expect(daysBetween(campaignId, farhold, home)).toBeGreaterThan(news.newsRadiusDays(4));
    startAt(campaignId, 400);
    store.saveWorldState(db, campaignId, { ...store.getWorldState(db, campaignId)!, quiet_until_day: 403 });

    const [a, b] = openFactions(campaignId);
    const major = { template: 'revolt', target_kind: 'settlement' as const, status: 'held' as const };
    const distant = agendaAt(campaignId, a!, farhold, major);
    const local = agendaAt(campaignId, b!, home, major);

    tickTo(db, campaignId, 401);

    expect(agendaNow(campaignId, distant)).toMatchObject({ status: 'won', resolved_day: 401 });
    expect(agendaNow(campaignId, local).status).toBe('held');
    expect(store.getWorldState(db, campaignId)!.quiet_until_day).toBe(403);

    tickTo(db, campaignId, 403);

    expect(agendaNow(campaignId, local)).toMatchObject({ status: 'won', resolved_day: 403 });
    const steady = storyteller.STORYTELLER_CAPS.steady;
    expect(store.getWorldState(db, campaignId)!.quiet_until_day).toBe(403 + steady.quiet_days_after_major + 1);
  });

  for (const style of ['calm', 'steady', 'chaotic'] as const) {
    it(`keeps the news reaching the party within the ${style} cap over 180 days while the world runs past it`, () => {
      const campaignId = withWorld(large);
      partyAt(campaignId, 'Dione');
      settings.updateSettings(db, campaignId, { storyteller: style });
      const cap = storyteller.STORYTELLER_CAPS[style].events_per_day;

      tickDays(campaignId, 180);

      const perceived = perceivedPerDay(campaignId, placeNamed(campaignId, 'Dione').id);
      expect([...perceived.values()].reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
      expect([...perceived].filter(([, n]) => n > cap)).toEqual([]);
      expect([...totalPerDay(campaignId).values()].some((n) => n > cap)).toBe(true);
    }, 60000);
  }

  it('keeps the old global cap with no scene and with a scene that names no known place', () => {
    // Agenda picks and rolls are seeded by faction id, so each world gets a database of its own.
    const run = (location: string | null): { ledger: unknown[]; perDay: Map<number, number> } => {
      db = openDb(':memory:');
      const campaignId = withWorld(large);
      if (location !== null) {
        partyAt(campaignId, location);
        expect(placeMatch.matchPlace(db, campaignId, location)).toBeUndefined();
      }
      tickDays(campaignId, 180);
      const ledger = db
        .prepare('SELECT day, kind, text, severity, faction_id FROM world_event WHERE campaign_id = ? ORDER BY id')
        .all(campaignId);
      return { ledger, perDay: totalPerDay(campaignId) };
    };

    const none = run(null);
    const nowhere = run('A hollow in the hills');

    expect(none.ledger.length).toBeGreaterThan(0);
    expect(nowhere.ledger).toEqual(none.ledger);
    const cap = storyteller.STORYTELLER_CAPS.steady.events_per_day;
    expect([...none.perDay].filter(([, n]) => n > cap)).toEqual([]);
  }, 60000);
});

describe('the perception budget over faith news', () => {
  it("lets a faith month's distant news all speak on its own day under calm", () => {
    const campaignId = withWorld(medium);
    db.prepare('UPDATE world_faction SET faith_id = NULL, influence = NULL WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_faith WHERE campaign_id = ?').run(campaignId);
    const farhold = addFarSettlement(campaignId);
    partyAt(campaignId, 'Farhold');
    for (const place of region.getRegion(db, campaignId)!.places) {
      if (place.id !== farhold.id) expect(daysBetween(campaignId, place, farhold)).toBeGreaterThan(news.newsRadiusDays(4));
    }
    settings.updateSettings(db, campaignId, { storyteller: 'calm' });

    const realms = db
      .prepare('SELECT id, liege_realm_id, government FROM world_realm WHERE campaign_id = ? ORDER BY id')
      .all(campaignId) as Array<{ id: number; liege_realm_id: number | null; government: string | null }>;
    const root = realms.find((row) => row.liege_realm_id === null && row.government === 'theocracy')!;
    const vassal = realms.find((row) => row.liege_realm_id === root.id)!;
    const faith = faithStore.insertFaith(db, campaignId, {
      name: 'The Sunfather',
      aspect: 'sun',
      symbol: 'radiant sun',
      head_place_id: null,
      fervor: 30,
      heresy_of: null,
      last_heresy_day: null,
      created_day: 361,
    });
    const crown = store
      .listFactions(db, campaignId)
      .find((faction) => faction.type === 'realm' && faction.realm_id === root.id)!;
    faithStore.setFactionFaith(db, campaignId, crown.id, faith.id, 'dominant');
    // Day 390 owes three items, which a calm day near the party would spread over three days.
    faithStore.addContest(db, campaignId, root.id, faith.id, 6);
    faithStore.setExcommunicated(db, campaignId, vassal.id, 390);
    let spawning = 1;
    while (dice.seededRng(dice.mixSeed(spawning, 390, faith.id, 4099))() >= 0.35) spawning += 1;
    store.saveWorldState(db, campaignId, { ...store.getWorldState(db, campaignId)!, seed: spawning });

    tickTo(db, campaignId, 390);

    const faithNews = store
      .listEvents(db, campaignId)
      .filter((event) => ['heresy', 'excommunication', 'reconciled'].includes(event.kind))
      .map((event) => ({ day: event.day, kind: event.kind }));
    expect(faithNews).toEqual([
      { day: 390, kind: 'heresy' },
      { day: 390, kind: 'excommunication' },
      { day: 390, kind: 'reconciled' },
    ]);
  });
});
