// The resolution side of the living world: portents, the fair-loss hold, a won agenda and the news
// the party hears at a settlement.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENDA_TEMPLATES } from '../src/core/agenda-templates.js';
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

let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let getRegion: (typeof import('../src/core/region.js'))['getRegion'];
let getPolitics: (typeof import('../src/core/politics-store.js'))['getPolitics'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let listAgendas: (typeof import('../src/core/world-store.js'))['listAgendas'];
let insertAgenda: (typeof import('../src/core/world-store.js'))['insertAgenda'];
let updateAgenda: (typeof import('../src/core/world-store.js'))['updateAgenda'];
let currentGameDay: (typeof import('../src/core/world-store.js'))['currentGameDay'];
let listEvents: (typeof import('../src/core/world-store.js'))['listEvents'];
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];
let agendaPlaceId: (typeof import('../src/core/world-resolve.js'))['agendaPlaceId'];
let firePortent: (typeof import('../src/core/world-resolve.js'))['firePortent'];
let canResolve: (typeof import('../src/core/world-resolve.js'))['canResolve'];
let resolveAgenda: (typeof import('../src/core/world-resolve.js'))['resolveAgenda'];
let deliverWorldNews: (typeof import('../src/core/world-resolve.js'))['deliverWorldNews'];
let HOLD_TIMEOUT_DAYS: (typeof import('../src/core/world-resolve.js'))['HOLD_TIMEOUT_DAYS'];
let newsRadiusDays: (typeof import('../src/core/world-news.js'))['newsRadiusDays'];
let travelDays: (typeof import('../src/core/world-news.js'))['travelDays'];

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may have cached dice.ts without the stub, so
  // drop the module cache and import the world modules fresh under the mock.
  vi.resetModules();
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, findPlace, getRegion } = await import('../src/core/region.js'));
  ({ getPolitics } = await import('../src/core/politics-store.js'));
  ({ listFactions, listAgendas, insertAgenda, updateAgenda, currentGameDay, listEvents } = await import(
    '../src/core/world-store.js'
  ));
  ({ tickTo } = await import('../src/core/world-tick.js'));
  ({ agendaPlaceId, firePortent, canResolve, resolveAgenda, deliverWorldNews, HOLD_TIMEOUT_DAYS } = await import(
    '../src/core/world-resolve.js'
  ));
  ({ newsRadiusDays, travelDays } = await import('../src/core/world-news.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

function withRegion(realm: unknown): number {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, realm, { source: 'generated' });
  return campaignId;
}

describe('firePortent', () => {
  it('writes a portent event, marks the portent fired and sends a packet', () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const agenda = listAgendas(db, campaignId)[0]!;

    const event = firePortent(db, campaignId, agenda, 0, 100);

    expect(event.kind).toBe('portent');
    expect(event.effects).toEqual({ portent: 0 });
    const stored = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(stored.portents[0]!.fired_day).toBe(100);

    const packet = db.prepare('SELECT id FROM world_packet WHERE event_id = ?').get(event.id) as
      | { id: number }
      | undefined;
    expect(packet).toBeDefined();
    const arrivals = db
      .prepare('SELECT COUNT(*) AS n FROM world_packet_arrival WHERE packet_id = ?')
      .get(packet!.id) as { n: number };
    expect(arrivals.n).toBeGreaterThan(0);
  });
});

describe('agendaPlaceId', () => {
  it('resolves a neighbour_county agenda to that county seat', () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const faction = listFactions(db, campaignId)[0]!;
    const county = getPolitics(db, campaignId)!.counties[0]!;

    const agenda = insertAgenda(db, campaignId, {
      faction_id: faction.id,
      template: 'expand_territory',
      target_kind: 'neighbour_county',
      target_id: county.id,
      target_name: county.name,
      clock_size: 8,
      clock_filled: 0,
      portents: [{ text: 'Levies muster.', fired_day: null, heard: false }],
      status: 'active',
      started_day: 1,
    });

    expect(agendaPlaceId(db, campaignId, agenda)).toBe(county.seat_place_id);
  });
});

describe('resolveAgenda', () => {
  it('records a won agenda, moves resources and starts the next agenda', () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const agenda = listAgendas(db, campaignId)[0]!;
    const faction = listFactions(db, campaignId).find((entry) => entry.id === agenda.faction_id)!;
    const before = faction.resources;

    const first = firePortent(db, campaignId, agenda, 0, 100);
    const second = firePortent(db, campaignId, agenda, 1, 100);

    const { event, next } = resolveAgenda(db, campaignId, agenda, 101, 999);

    expect(event.kind).toBe('agenda_won');
    expect(event.causes).toEqual([first.id, second.id]);
    expect(listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!.status).toBe('won');

    const template = AGENDA_TEMPLATES.find((entry) => entry.id === agenda.template)!;
    const after = listFactions(db, campaignId).find((entry) => entry.id === faction.id)!;
    expect(after.resources).toBe(Math.max(0, Math.min(10, before + template.on_win.resources)));

    expect(next).not.toBeNull();
    expect(next!.faction_id).toBe(faction.id);
    expect(next!.status).toBe('active');
  });
});

describe('resolveAgenda on the hold timeout', () => {
  function heldAgenda(campaignId: number, heard: boolean): ReturnType<typeof insertAgenda> {
    const monster = listFactions(db, campaignId).find((faction) => faction.type === 'monsters')!;
    const settlement = findPlace(db, campaignId, 'Frostcot')!;
    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE id = ?').run(settlement.id);
    return insertAgenda(db, campaignId, {
      faction_id: monster.id,
      template: 'monsters_grow',
      target_kind: 'settlement',
      target_id: settlement.id,
      target_name: settlement.name,
      clock_size: 6,
      clock_filled: 6,
      portents: [
        { text: 'Refugees arrive.', fired_day: 100, heard },
        { text: 'Livestock vanish.', fired_day: 100, heard },
      ],
      status: 'held',
      started_day: 1,
    });
  }

  function arrivalPlaceIds(eventId: number): number[] {
    const rows = db
      .prepare(
        'SELECT place_id FROM world_packet_arrival WHERE packet_id = (SELECT id FROM world_packet WHERE event_id = ?)',
      )
      .all(eventId) as Array<{ place_id: number }>;
    return rows.map((row) => row.place_id).sort((a, b) => a - b);
  }

  /** A settlement far enough away that no severity radius reaches it, so a broadcast is visible. */
  function addFarSettlement(campaignId: number): number {
    const info = db
      .prepare(
        `INSERT INTO world_place (campaign_id, kind, name, q, r, hexes_json, tags_json, info, link, seed, created_at)
         VALUES (?, 'settlement', 'Farhold', 100, 100, '["q100_r100"]', '{}', '', NULL, NULL, ?)`,
      )
      .run(campaignId, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  it('spreads the win to every settlement when an unheard hold goes ahead', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const farhold = addFarSettlement(campaignId);
    const agenda = heldAgenda(campaignId, false);

    const { event } = resolveAgenda(db, campaignId, agenda, 100 + HOLD_TIMEOUT_DAYS, 999);

    const settlements = getRegion(db, campaignId)!
      .places.filter((place) => place.kind === 'settlement')
      .map((place) => place.id)
      .sort((a, b) => a - b);
    expect(arrivalPlaceIds(event.id)).toEqual(settlements);
    expect(arrivalPlaceIds(event.id)).toContain(farhold);
  });

  it('keeps the severity radius when the party heard the warnings', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const farhold = addFarSettlement(campaignId);
    const agenda = heldAgenda(campaignId, true);
    const settlement = findPlace(db, campaignId, 'Frostcot')!;

    const { event } = resolveAgenda(db, campaignId, agenda, 130, 999);

    const view = getRegion(db, campaignId)!;
    const origin = view.places.find((place) => place.id === settlement.id)!;
    const inRadius = view.places
      .filter((place) => place.kind === 'settlement')
      .filter((place) => travelDays(view, origin, place) <= newsRadiusDays(event.severity));
    expect(arrivalPlaceIds(event.id)).toHaveLength(inRadius.length);
    expect(arrivalPlaceIds(event.id)).not.toContain(farhold);
    expect(inRadius.length).toBeLessThan(view.places.filter((place) => place.kind === 'settlement').length);
  });
});

describe('canResolve', () => {
  it('holds an irreversible agenda the party knows until two portents are heard', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const monster = listFactions(db, campaignId).find((faction) => faction.type === 'monsters')!;
    const settlement = findPlace(db, campaignId, 'Frostcot')!;

    const agenda = insertAgenda(db, campaignId, {
      faction_id: monster.id,
      template: 'monsters_grow',
      target_kind: 'settlement',
      target_id: settlement.id,
      target_name: settlement.name,
      clock_size: 6,
      clock_filled: 6,
      portents: [
        { text: 'Refugees arrive.', fired_day: null, heard: false },
        { text: 'Livestock vanish.', fired_day: null, heard: false },
      ],
      status: 'active',
      started_day: 1,
    });

    expect(canResolve(db, campaignId, agenda, 1)).toBe(true);

    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE id = ?').run(settlement.id);
    expect(canResolve(db, campaignId, agenda, 1)).toBe(false);

    const heard = updateAgenda(db, campaignId, agenda.id, {
      portents: agenda.portents.map((portent) => ({ ...portent, heard: true })),
    });
    expect(canResolve(db, campaignId, heard, 1)).toBe(true);
  });

  it('goes ahead 30 days after the last portent when fewer than two were heard', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
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
      portents: [
        { text: 'Refugees arrive.', fired_day: 100, heard: false },
        { text: 'Livestock vanish.', fired_day: 100, heard: false },
      ],
      status: 'held',
      started_day: 1,
    });

    expect(canResolve(db, campaignId, agenda, 100 + HOLD_TIMEOUT_DAYS - 1)).toBe(false);
    expect(canResolve(db, campaignId, agenda, 100 + HOLD_TIMEOUT_DAYS)).toBe(true);
  });

  it('never holds a reversible agenda', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const realm = listFactions(db, campaignId).find((faction) => faction.type === 'realm')!;
    const seat = findPlace(db, campaignId, 'Frostcot')!;
    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE id = ?').run(seat.id);

    const agenda = insertAgenda(db, campaignId, {
      faction_id: realm.id,
      template: 'build',
      target_kind: 'own_seat',
      target_id: seat.id,
      target_name: seat.name,
      clock_size: 8,
      clock_filled: 8,
      portents: [{ text: 'Scaffolding rises.', fired_day: 100, heard: false }],
      status: 'active',
      started_day: 1,
    });

    expect(canResolve(db, campaignId, agenda, 1)).toBe(true);
  });
});

describe('deliverWorldNews', () => {
  it("delivers a known agenda's news and marks its portents heard", () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const redham = findPlace(db, campaignId, 'Redham')!;
    const bishopric = listFactions(db, campaignId).find((faction) => faction.name === 'Bishopric of Redham')!;

    const agenda = insertAgenda(db, campaignId, {
      faction_id: bishopric.id,
      template: 'build',
      target_kind: 'own_seat',
      target_id: redham.id,
      target_name: redham.name,
      clock_size: 8,
      clock_filled: 0,
      portents: [
        { text: 'Scaffolding rises over Redham.', fired_day: null, heard: false },
        { text: 'Masons arrive in Redham.', fired_day: null, heard: false },
      ],
      status: 'active',
      started_day: 1,
    });

    firePortent(db, campaignId, agenda, 0, 100);
    firePortent(db, campaignId, agenda, 1, 100);

    const result = deliverWorldNews(db, campaignId, redham.id, 100);
    expect(result.rumours).toHaveLength(2);
    expect(result.discovered.map((entry) => entry.id)).toEqual([agenda.id]);

    const stored = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
    expect(stored.portents.every((portent) => portent.heard)).toBe(true);
    expect(stored.known_to_party).toBe(true);

    expect(deliverWorldNews(db, campaignId, redham.id, 100)).toEqual({ rumours: [], discovered: [] });
  });
});

describe('public world texts', () => {
  for (const [label, realm] of [['safe', safe], ['dangerous', dangerous]] as const) {
    it(`never names a danger site in events or portents after 180 days (${label})`, () => {
      const campaignId = withRegion(realm);
      ensureWorld(db, campaignId);
      const dangers = getRegion(db, campaignId)!
        .places.filter((place) => place.kind === 'danger')
        .map((place) => place.name);
      const today = currentGameDay(db, campaignId);
      for (let call = 1; call <= 3; call += 1) tickTo(db, campaignId, today + 60 * call);

      const texts = [
        ...listEvents(db, campaignId).map((event) => event.text),
        ...listAgendas(db, campaignId).flatMap((agenda) => agenda.portents.map((portent) => portent.text)),
      ];
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        for (const danger of dangers) expect(text).not.toContain(danger);
        expect(text).not.toContain('The Brood of');
      }
    });
  }
});
