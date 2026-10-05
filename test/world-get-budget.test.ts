// world {op: get} on the large map after 180 ticked days: party-centred, within WORLD_GET for text plus JSON,
// zero attitudes never listed, the rest counted, and each filter a budgeted subset that still serves a thwart.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { RegionView, WorldPlace } from '../src/core/region.js';
import type { WorldAgenda, WorldFaction } from '../src/core/world-store.js';

const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;

const PARTY = 'Dione';

let db: Db;
let campaignId: number;
let client: Client;
let today: number;
let store: typeof import('../src/core/world-store.js');
let region: typeof import('../src/core/region.js');
let news: typeof import('../src/core/world-news.js');
let memory: typeof import('../src/core/world-memory.js');
let resolve: typeof import('../src/core/world-resolve.js');
let politics: typeof import('../src/core/politics-store.js');
let budget: typeof import('../src/core/token-budget.js');
let digest: typeof import('../src/core/world-digest.js');

let felt: WorldFaction;
let grudge: WorldFaction;
let even: WorldFaction;
let ended: WorldFaction;
let revealed: WorldAgenda;
let transfer: { county: string; from: string; to: string };

interface Faction {
  id: number;
  name: string;
  type: string;
  seat: string | null;
  days?: number;
  ended_day: number | null;
  attitude?: { total: number; band: string; reasons: Array<{ reason: string; current: number }> };
}

interface Agenda {
  id: number;
  faction: string;
  clock: string;
  status: string;
  known_to_party: boolean;
  days?: number;
  portents?: Array<{ text: string; fired_day: number; heard: boolean }>;
}

interface Digest {
  view: string;
  party: string | null;
  factions: Faction[];
  agendas: Agenda[];
  others: { factions: number; by_type: Record<string, number>; agendas: number; ended: number };
  page?: { page: number; pages: number; total: number };
  place_states: Array<{ place: string; state: string; until_day: number }>;
  transfers: Array<{ day: number; county: string; from: string; to: string }>;
  faction?: Faction;
}

interface Got {
  isError: boolean;
  text: string;
  data: Digest;
  tokens: number;
}

/** Calls world get the way the DM does and sizes the reply as the budget counts it: text plus JSON. */
async function get(args: Record<string, unknown> = {}): Promise<Got> {
  const result = await client.callTool({ name: 'world', arguments: { campaign_id: campaignId, op: 'get', ...args } });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  const json = JSON.stringify(result.structuredContent ?? {});
  return {
    isError: result.isError === true,
    text,
    data: result.structuredContent as unknown as Digest,
    tokens: budget.estimateTokens(text) + budget.estimateTokens(json),
  };
}

const view = (): RegionView => region.getRegion(db, campaignId)!;
const place = (name: string): WorldPlace => view().places.find((entry) => entry.name === name)!;
const living = (): WorldFaction[] => store.listFactions(db, campaignId);

/** Travel days from a place to a faction's seat, Infinity without a seat. */
function seatDays(from: WorldPlace, faction: WorldFaction): number {
  const seat = faction.place_id !== null ? view().places.find((entry) => entry.id === faction.place_id) : undefined;
  return seat ? news.travelDays(view(), from, seat) : Infinity;
}

function agendaDays(from: WorldPlace, agenda: WorldAgenda): number {
  const placeId = resolve.agendaPlaceId(db, campaignId, agenda);
  const target = placeId !== null ? view().places.find((entry) => entry.id === placeId) : undefined;
  return target ? news.travelDays(view(), from, target) : Infinity;
}

/** Every living-world row, so a refused get is proven to have written nothing. */
function rowSnapshot(): string {
  const tables = ['world_state', 'world_faction', 'world_agenda', 'world_event', 'world_attitude', 'world_place_state'];
  return JSON.stringify(
    tables.map((table) => db.prepare(`SELECT * FROM ${table} WHERE campaign_id = ? ORDER BY rowid`).all(campaignId)),
  );
}

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  const { openDb } = await import('../src/db/connection.js');
  const campaign = await import('../src/core/campaign.js');
  const calendar = await import('../src/core/calendar.js');
  const seed = await import('../src/core/world-seed.js');
  const { createGameServer } = await import('../src/mcp/server.js');
  store = await import('../src/core/world-store.js');
  region = await import('../src/core/region.js');
  news = await import('../src/core/world-news.js');
  memory = await import('../src/core/world-memory.js');
  resolve = await import('../src/core/world-resolve.js');
  politics = await import('../src/core/politics-store.js');
  budget = await import('../src/core/token-budget.js');
  digest = await import('../src/core/world-digest.js');

  db = openDb(':memory:');
  let state = 42;
  const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  try {
    campaignId = campaign.createCampaign(db, { name: 'The Long Year', story_shape: 'sandbox' }).campaign_id;
    region.importRegion(db, campaignId, large, { source: 'generated' });
    seed.ensureWorld(db, campaignId);
  } finally {
    spy.mockRestore();
  }
  campaign.saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'They winter in the city.', scene_location: PARTY });
  calendar.advanceTime(db, campaignId, { days: 180 });
  today = store.currentGameDay(db, campaignId);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'world-get-budget', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);

  // Four distant factions with no known agenda: two feel something, one's feelings cancel out, one is destroyed.
  const party = place(PARTY);
  const knownOwners = new Set(
    store.listAgendas(db, campaignId).filter((agenda) => agenda.known_to_party).map((agenda) => agenda.faction_id),
  );
  const far = living().filter((faction) => seatDays(party, faction) > digest.NEAR_DAYS && !knownOwners.has(faction.id));
  [felt, grudge, even] = far as [WorldFaction, WorldFaction, WorldFaction];
  ended = far.find((faction) => faction.type === 'house' && ![felt, grudge, even].includes(faction))!;
  memory.addAttitude(db, campaignId, { kind: 'faction', id: felt.id }, { value: 3, reason: 'saved their envoy', day: today });
  memory.addAttitude(db, campaignId, { kind: 'faction', id: grudge.id }, { value: -2, reason: 'mocked their banner', day: today });
  memory.addAttitude(db, campaignId, { kind: 'faction', id: even.id }, { value: 2, reason: 'a fair trade', day: today });
  memory.addAttitude(db, campaignId, { kind: 'faction', id: even.id }, { value: -2, reason: 'a broken promise', day: today });
  const destroyed = await client.callTool({
    name: 'world',
    arguments: { campaign_id: campaignId, op: 'destroy', target: ended.id, reason: 'its hall burned' },
  });
  expect(destroyed.isError).toBeFalsy();

  // A distant, unknown agenda the party then uncovers: the default view must still carry its id.
  const taken = new Set([felt.id, grudge.id, even.id, ended.id]);
  revealed = store
    .listAgendas(db, campaignId, { status: 'active' })
    .find(
      (agenda) =>
        !agenda.known_to_party && !taken.has(agenda.faction_id) && agendaDays(party, agenda) > digest.NEAR_DAYS &&
        seatDays(party, living().find((faction) => faction.id === agenda.faction_id)!) > digest.NEAR_DAYS,
    )!;
  const shown = await client.callTool({ name: 'world', arguments: { campaign_id: campaignId, op: 'reveal', agenda: revealed.id } });
  expect(shown.isError).toBeFalsy();

  // A county changing hands five days ago, as a won war records it.
  const stored = politics.getPolitics(db, campaignId)!;
  const county = stored.counties[0]!;
  const from = stored.realms.find((realm) => realm.id === county.realm_id)!;
  const to = stored.realms.find((realm) => realm.id !== county.realm_id)!;
  store.insertEvent(db, campaignId, {
    day: today - 5,
    kind: 'agenda_won',
    text: `${to.name} takes ${county.name}.`,
    severity: 4,
    place_id: null,
    faction_id: null,
    agenda_id: null,
    causes: [],
    effects: { outcome: 'county_transferred', county_id: county.id, from_realm_id: from.id, to_realm_id: to.id },
    visibility: 'public',
  });
  transfer = { county: county.name, from: from.name, to: to.name };
}, 120_000);

afterAll(async () => {
  await client.close();
});

describe('the default world get on a large map after 180 days', () => {
  it('stays within WORLD_GET counting text and JSON, and lists far fewer factions than live', async () => {
    const got = await get();
    expect(got.isError).toBe(false);
    expect(got.tokens).toBeLessThanOrEqual(budget.WORLD_GET);
    expect(got.data).toMatchObject({ view: 'default', party: PARTY });
    expect(got.data.factions.length).toBeLessThan(living().length);
    expect(got.text).toContain('DM only');
  });

  it('centres on the party: every faction seated within two days is listed with its distance', async () => {
    const { data } = await get();
    const party = place(PARTY);
    const near = living().filter((faction) => seatDays(party, faction) <= digest.NEAR_DAYS);
    expect(near.length).toBeGreaterThan(0);
    for (const faction of near) {
      const entry = data.factions.find((listed) => listed.id === faction.id);
      expect(entry, faction.name).toBeDefined();
      expect(entry!.days).toBe(seatDays(party, faction));
    }
    const landing = store
      .listAgendas(db, campaignId)
      .filter((agenda) => ['active', 'held'].includes(agenda.status) && agendaDays(party, agenda) <= digest.NEAR_DAYS);
    for (const agenda of landing) expect(data.agendas.map((entry) => entry.id)).toContain(agenda.id);
  });

  it('lists a distant faction that feels something, with band and total, and never a zero attitude', async () => {
    const { data, text } = await get();
    expect(data.factions.find((entry) => entry.id === felt.id)!.attitude).toMatchObject({ total: 3, band: 'friendly' });
    expect(data.factions.find((entry) => entry.id === grudge.id)!.attitude).toMatchObject({ total: -2, band: 'wary' });
    expect(text).toContain('friendly (+3) [+3 saved their envoy]');
    expect(text).toContain('wary (-2)');

    expect(memory.attitudeOf(db, campaignId, { kind: 'faction', id: even.id }, today).total).toBe(0);
    expect(data.factions.map((entry) => entry.id)).not.toContain(even.id);
    for (const entry of data.factions) {
      if (entry.attitude) expect(entry.attitude.total).not.toBe(0);
      else expect(memory.attitudeOf(db, campaignId, { kind: 'faction', id: entry.id }, today).total).toBe(0);
    }
    expect(text).not.toMatch(/\(0\)|regards the party 0/);
  });

  it('counts every other living faction by type', async () => {
    const { data, text } = await get();
    const listedLiving = data.factions.filter((entry) => entry.ended_day === null).length;
    expect(data.others.factions).toBeGreaterThan(0);
    expect(data.others.factions + listedLiving).toBe(living().length);
    expect(Object.values(data.others.by_type).reduce((sum, n) => sum + n, 0)).toBe(data.others.factions);
    expect(text).toContain(`+ ${data.others.factions} other factions: `);
    expect(text).toMatch(/\d+ houses/);
  });

  it('keeps known agendas with their ids and clocks, and lists their owners', async () => {
    const { data, text } = await get();
    const known = store.listAgendas(db, campaignId).filter((agenda) => agenda.known_to_party && agenda.status === 'active');
    expect(known.map((agenda) => agenda.id)).toContain(revealed.id);
    for (const agenda of known) {
      const entry = data.agendas.find((listed) => listed.id === agenda.id)!;
      expect(entry).toMatchObject({ known_to_party: true, clock: `${agenda.clock_filled}/${agenda.clock_size}` });
      expect(text).toContain(`- #${agenda.id} `);
      expect(data.factions.map((listed) => listed.id)).toContain(agenda.faction_id);
    }
  });

  it('shows ended factions, place states and county transfers compactly', async () => {
    const { data, text } = await get();
    expect(data.factions.find((entry) => entry.id === ended.id)).toMatchObject({ ended_day: today });
    expect(text).toContain(`${ended.name} (`);
    expect(text).toContain(`[ended day ${today}]`);

    const states = db
      .prepare('SELECT COUNT(*) AS n FROM world_place_state WHERE campaign_id = ? AND state IS NOT NULL AND until_day > ?')
      .get(campaignId, today) as { n: number };
    expect(states.n).toBeGreaterThan(0);
    expect(data.place_states.length).toBeGreaterThan(0);
    for (const row of data.place_states) expect(Object.keys(row).sort()).toEqual(['place', 'state', 'until_day']);
    expect(text).toContain('Place states:');
    expect(text).toContain(`- ${data.place_states[0]!.place}: ${data.place_states[0]!.state} until day `);

    expect(data.transfers).toContainEqual({ day: today - 5, ...transfer });
    expect(text).toContain(`${transfer.county} passes from ${transfer.from} to ${transfer.to}`);
  });
});

describe('the get filters', () => {
  it('shows one faction in full by id or name, within budget', async () => {
    const active = store.listAgendas(db, campaignId).filter((agenda) => ['active', 'held'].includes(agenda.status));
    const busiest = living()
      .map((faction) => ({ faction, portents: active.filter((a) => a.faction_id === faction.id).flatMap((a) => a.portents).length }))
      .sort((a, b) => b.portents - a.portents)[0]!.faction;

    const byId = await get({ faction: busiest.id });
    expect(byId.isError).toBe(false);
    expect(byId.tokens).toBeLessThanOrEqual(budget.WORLD_GET);
    expect(byId.data).toMatchObject({ view: 'faction', faction: { id: busiest.id, name: busiest.name } });
    const own = active.filter((agenda) => agenda.faction_id === busiest.id);
    expect(byId.data.agendas.map((agenda) => agenda.id).sort()).toEqual(own.map((agenda) => agenda.id).sort());
    for (const agenda of byId.data.agendas) expect(Array.isArray(agenda.portents)).toBe(true);
    expect(byId.data.agendas.some((agenda) => agenda.portents!.length > 0)).toBe(true);

    const byName = await get({ faction: busiest.name.toUpperCase() });
    expect(byName.data.faction!.id).toBe(busiest.id);

    const gone = await get({ faction: ended.name });
    expect(gone.data.faction).toMatchObject({ id: ended.id, ended_day: today });
    expect(gone.text).toContain(`[ended day ${today}]`);
  });

  it('lists only the type asked for, singular or plural, each page within budget', async () => {
    const types = [...new Set(living().map((faction) => faction.type))];
    expect(types.length).toBeGreaterThan(3);
    for (const type of types) {
      const all = living().filter((faction) => faction.type === type);
      const seen: number[] = [];
      for (let page = 1; ; page += 1) {
        const got = await get({ type, page });
        expect(got.isError, `${type} page ${page}`).toBe(false);
        expect(got.tokens).toBeLessThanOrEqual(budget.WORLD_GET);
        expect(got.data.factions.every((entry) => entry.type === type)).toBe(true);
        expect(got.data.page).toMatchObject({ page, total: all.length });
        seen.push(...got.data.factions.map((entry) => entry.id));
        if (page >= got.data.page!.pages) break;
      }
      expect(seen.sort((a, b) => a - b)).toEqual(all.map((faction) => faction.id));
    }

    const plural = await get({ type: 'houses' });
    const singular = await get({ type: 'house' });
    expect(plural.data.factions).toEqual(singular.data.factions);
  });

  it('lists exactly the factions seated within two days of a place, and the agendas landing there', async () => {
    const settlements = view().places.filter((entry) => entry.kind === 'settlement');
    for (const centre of [place(PARTY), ...settlements.slice(0, 4)]) {
      const expected = living()
        .filter((faction) => seatDays(centre, faction) <= digest.NEAR_DAYS)
        .map((faction) => faction.id)
        .sort((a, b) => a - b);
      const listed: number[] = [];
      let pages = 1;
      for (let page = 1; page <= pages; page += 1) {
        const got = await get({ near: centre.name, page });
        expect(got.isError).toBe(false);
        expect(got.tokens).toBeLessThanOrEqual(budget.WORLD_GET);
        expect(got.data).toMatchObject({ view: 'near', near: centre.name, page: { page, total: expected.length } });
        for (const entry of got.data.factions) expect(entry.days).toBeLessThanOrEqual(digest.NEAR_DAYS);
        listed.push(...got.data.factions.map((entry) => entry.id));
        pages = got.data.page!.pages;

        if (page > 1) continue;
        const landing = store
          .listAgendas(db, campaignId)
          .filter((agenda) => ['active', 'held'].includes(agenda.status) && agendaDays(centre, agenda) <= digest.NEAR_DAYS);
        for (const agenda of landing) expect(got.data.agendas.map((entry) => entry.id)).toContain(agenda.id);
      }
      expect(listed.sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it('narrows near by type to the intersection', async () => {
    const centre = place(PARTY);
    const near = living().filter((faction) => seatDays(centre, faction) <= digest.NEAR_DAYS);
    const type = near[0]!.type;
    const got = await get({ near: centre.id, type });
    expect(got.isError).toBe(false);
    expect(got.data.factions.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(
      near.filter((faction) => faction.type === type).map((faction) => faction.id),
    );
  });

  it('pages through the counted rest exactly once, each page within budget', async () => {
    const first = await get();
    const listed = new Set(first.data.factions.map((entry) => entry.id));
    const rest = living()
      .filter((faction) => !listed.has(faction.id))
      .map((faction) => faction.id);
    expect(rest.length).toBe(first.data.others.factions);

    const seen: number[] = [];
    let pages = 1;
    for (let page = 1; page <= pages; page += 1) {
      const got = await get({ page });
      expect(got.isError).toBe(false);
      expect(got.tokens).toBeLessThanOrEqual(budget.WORLD_GET);
      expect(got.data.view).toBe('rest');
      pages = got.data.page!.pages;
      seen.push(...got.data.factions.map((entry) => entry.id));
    }
    expect(seen).toEqual(rest);
    expect(pages).toBe(Math.ceil(rest.length / digest.PAGE_SIZE));

    const past = await get({ page: pages + 1 });
    expect(past.isError).toBe(true);
    expect(past.text).toContain('past the last page');
  });

  it('refuses an unknown faction, type or place, a mixed faction filter and page 0, writing nothing', async () => {
    const cases: Array<{ args: Record<string, unknown>; message: RegExp }> = [
      { args: { faction: 'Nobody At All' }, message: /No faction "Nobody At All"/ },
      { args: { type: 'dragons' }, message: /No faction of type "dragons"\. Types here: .*house/ },
      { args: { near: 'Nowhere Zzz' }, message: /No place "Nowhere Zzz"/ },
      { args: { faction: felt.id, type: 'house' }, message: /without type, near or page/ },
      { args: { page: 0 }, message: /page counts from 1/ },
    ];
    for (const { args, message } of cases) {
      const before = rowSnapshot();
      const got = await get(args);
      expect(got.isError, JSON.stringify(args)).toBe(true);
      expect(got.text).toMatch(message);
      expect(rowSnapshot()).toBe(before);
    }
  });
});

describe('the thwart workflow from the default view', () => {
  it('thwarts a known agenda by the id the get shows, and the next get drops it', async () => {
    const before = await get();
    const entry = before.data.agendas.find((agenda) => agenda.id === revealed.id)!;
    expect(entry.known_to_party).toBe(true);

    const thwart = await client.callTool({
      name: 'world',
      arguments: { campaign_id: campaignId, op: 'thwart', agenda: entry.id, reason: 'exposed the scheme' },
    });
    expect(thwart.isError).toBeFalsy();

    const after = await get();
    expect(after.data.agendas.map((agenda) => agenda.id)).not.toContain(revealed.id);
  });
});

describe('the budget under pressure', () => {
  it('trims to WORLD_GET when every faction feels strongly, keeping the strongest first and counting the rest', async () => {
    const reason = 'stood beside them through the long and bitter winter siege';
    for (const [index, faction] of living().entries()) {
      memory.addAttitude(db, campaignId, { kind: 'faction', id: faction.id }, { value: index % 2 === 0 ? 4 : -4, reason, day: today });
    }
    const got = await get();
    expect(got.isError).toBe(false);
    expect(got.tokens).toBeLessThanOrEqual(budget.WORLD_GET);

    const listedLiving = got.data.factions.filter((entry) => entry.ended_day === null);
    expect(listedLiving.every((entry) => entry.attitude !== undefined && entry.attitude.total !== 0)).toBe(true);
    expect(got.data.others.factions).toBeGreaterThan(0);
    expect(got.data.others.factions + listedLiving.length).toBe(living().length);
    const strength = listedLiving.map((entry) => Math.abs(entry.attitude!.total));
    expect(strength).toEqual([...strength].sort((a, b) => b - a));

    // An agenda stays only when it is known, lands near the party, or its owner is still listed.
    const listed = new Set(listedLiving.map((entry) => entry.id));
    const owner = new Map(store.listAgendas(db, campaignId).map((agenda) => [agenda.id, agenda.faction_id]));
    for (const agenda of got.data.agendas) {
      expect(agenda.known_to_party || agenda.days !== undefined || listed.has(owner.get(agenda.id)!), `#${agenda.id}`).toBe(true);
    }
    const total = store.listAgendas(db, campaignId).filter((agenda) => ['active', 'held'].includes(agenda.status)).length;
    expect(got.data.others.agendas).toBe(total - got.data.agendas.length);
  });
});
