// The DM-facing surface of world wins: unexpired place states and recent county transfers in the
// briefing, ended factions still named, a vassal showing its liege's faith, and none of it on player routes.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import type { Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let db: Db;
let base: string;
let stop: () => Promise<void>;

let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let saveHierarchy: (typeof import('../src/core/politics-store.js'))['saveHierarchy'];
let currentGameDay: (typeof import('../src/core/world-store.js'))['currentGameDay'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let insertFaction: (typeof import('../src/core/world-store.js'))['insertFaction'];
let insertAgenda: (typeof import('../src/core/world-store.js'))['insertAgenda'];
let insertEvent: (typeof import('../src/core/world-store.js'))['insertEvent'];
let updateFaction: (typeof import('../src/core/world-store.js'))['updateFaction'];
let saveWorldState: (typeof import('../src/core/world-store.js'))['saveWorldState'];
let setPlaceState: (typeof import('../src/core/world-place-state.js'))['setPlaceState'];
let transferCounty: (typeof import('../src/core/world-place-state.js'))['transferCounty'];
let RAIDED_DAYS: (typeof import('../src/core/world-place-state.js'))['RAIDED_DAYS'];
let insertFaith: (typeof import('../src/core/world-faith-store.js'))['insertFaith'];
let setFactionFaith: (typeof import('../src/core/world-faith-store.js'))['setFactionFaith'];
let worldBriefing: (typeof import('../src/core/world-briefing.js'))['worldBriefing'];
let createGameServer: (typeof import('../src/mcp/server.js'))['createGameServer'];
let startHttpServer: (typeof import('../src/transport/http.js'))['startHttpServer'];
let HOST: (typeof import('../src/transport/http.js'))['HOST'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world modules
  // fresh on the real one; this file builds its state by hand and never mocks.
  vi.resetModules();
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, findPlace } = await import('../src/core/region.js'));
  ({ saveHierarchy } = await import('../src/core/politics-store.js'));
  ({ currentGameDay, listFactions, insertFaction, insertAgenda, insertEvent, updateFaction, saveWorldState } =
    await import('../src/core/world-store.js'));
  ({ setPlaceState, transferCounty, RAIDED_DAYS } = await import('../src/core/world-place-state.js'));
  ({ insertFaith, setFactionFaith } = await import('../src/core/world-faith-store.js'));
  ({ worldBriefing } = await import('../src/core/world-briefing.js'));
  ({ createGameServer } = await import('../src/mcp/server.js'));
  ({ startHttpServer, HOST } = await import('../src/transport/http.js'));
  const { openDb } = await import('../src/db/connection.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'worldstate0123456789abcdef0123' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function mcpCampaign(client: Client, name: string): Promise<number> {
  const created = await client.callTool({ name: 'create_campaign', arguments: { name, story_shape: 'sandbox' } });
  return (created.structuredContent as { campaign_id: number }).campaign_id;
}

const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;

interface BorderWorld {
  places: { ficengwind: number; hotfield: number; redham: number; southernLanding: number; stormcourtby: number };
  realms: [number, number, number];
  counties: [number, number, number, number, number];
}

/**
 * Two sovereign kingdoms and one lordship sworn to the first, with the lordship seated at Stormcourtby.
 * A church only sits on the liege, so a vassal must fall back up the chain to show any faith.
 */
function buildBorder(campaignId: number): BorderWorld {
  importRegion(db, campaignId, safe, { source: 'generated' });
  const place = (ref: string): number => findPlace(db, campaignId, ref)!.id;
  const places = {
    ficengwind: place('Ficengwind'),
    hotfield: place('Hotfield'),
    redham: place('Redham'),
    southernLanding: place('Southern Landing'),
    stormcourtby: place('Stormcourtby'),
  };

  const counties: ComputedCounties = {
    counties: [
      { name: 'County of Ficengwind', seat_place_id: places.ficengwind, seat_kind: 'city', hexes: ['q4_r11'], village_place_ids: [], component: 0 },
      { name: 'County of Hotfield', seat_place_id: places.hotfield, seat_kind: 'town', hexes: ['q12_r11'], village_place_ids: [], component: 0 },
      { name: 'County of Redham', seat_place_id: places.redham, seat_kind: 'town', hexes: ['q6_r8'], village_place_ids: [], component: 0 },
      { name: 'Lordship of Southern Landing', seat_place_id: places.southernLanding, seat_kind: 'castle', hexes: ['q11_r14'], village_place_ids: [], component: 0 },
      { name: 'Lordship of Stormcourtby', seat_place_id: places.stormcourtby, seat_kind: 'town', hexes: ['q9_r5'], village_place_ids: [], component: 0 },
    ],
    edges: [],
  };
  const realms: ComputedRealms = {
    realms: [
      { name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: places.ficengwind, off_map: false, liege: null },
      { name: 'Kingdom of Redham', kind: 'kingdom', capital_place_id: places.redham, off_map: false, liege: null },
      { name: 'Lordship of Stormcourtby', kind: 'lordship', capital_place_id: places.stormcourtby, off_map: false, liege: 0 },
    ],
    county_realm: [0, 0, 1, 1, 2],
  };
  const hierarchy: ComputedHierarchy = {
    duchies: [
      { name: 'Crownlands of Ficengwind', realm: 0, seat_place_id: places.ficengwind, county_indexes: [0, 1], demesne: true, joined_how: 'core' },
      { name: 'Crownlands of Redham', realm: 1, seat_place_id: places.redham, county_indexes: [2, 3], demesne: true, joined_how: 'core' },
    ],
    county_duchy: [0, 0, 1, 1, null],
    march_counties: [1, 2],
    claims: [],
  };

  const stored = saveHierarchy(db, campaignId, { counties, realms, hierarchy });
  saveWorldState(db, campaignId, { seed: 7, last_tick_day: currentGameDay(db, campaignId), quiet_until_day: 0 });
  return {
    places,
    realms: stored.realms.map((realm) => realm.id) as BorderWorld['realms'],
    counties: stored.counties.map((county) => county.id) as BorderWorld['counties'],
  };
}

function borderWorld(name: string): { campaignId: number } & BorderWorld {
  const campaignId = createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;
  return { campaignId, ...buildBorder(campaignId) };
}

describe('worldBriefing place states and transfers', () => {
  it('lists an unexpired raided settlement and omits an expired one', () => {
    const { campaignId, places } = borderWorld('State Block');
    const today = currentGameDay(db, campaignId);
    setPlaceState(db, campaignId, places.redham, today, { state: 'raided' });
    setPlaceState(db, campaignId, places.hotfield, today - RAIDED_DAYS, { state: 'raided' });

    const text = worldBriefing(db, campaignId, 'Stormcourtby');
    expect(text).toContain(`Troubled settlements: Redham — raided until day ${today + RAIDED_DAYS}`);
    expect(text).not.toContain('Hotfield');
  });

  it('names a recent county transfer and drops one outside the window', () => {
    const { campaignId, counties, realms } = borderWorld('Transfer Block');
    const today = currentGameDay(db, campaignId);
    transferCounty(db, campaignId, counties[1], realms[1]);
    insertEvent(db, campaignId, {
      day: today - 3,
      kind: 'agenda_won',
      text: 'Redham takes Hotfield.',
      severity: 3,
      place_id: null,
      faction_id: null,
      agenda_id: null,
      causes: [],
      effects: {
        outcome: 'county_transferred',
        county_id: counties[1],
        from_realm_id: realms[0],
        to_realm_id: realms[1],
      },
      visibility: 'public',
    });
    insertEvent(db, campaignId, {
      day: today - 100,
      kind: 'agenda_won',
      text: 'An old war.',
      severity: 3,
      place_id: null,
      faction_id: null,
      agenda_id: null,
      causes: [],
      effects: {
        outcome: 'county_transferred',
        county_id: counties[2],
        from_realm_id: realms[1],
        to_realm_id: realms[0],
      },
      visibility: 'public',
    });

    const text = worldBriefing(db, campaignId, null);
    expect(text).toContain('Recent county transfers:');
    expect(text).toContain('County of Hotfield passes from Kingdom of Ficengwind to Kingdom of Redham');
    expect(text).not.toContain('County of Redham passes from');
  });
});

describe('worldBriefing and ended factions', () => {
  it('still names an ended faction in the portent and clock lines', () => {
    const { campaignId, places } = borderWorld('Ended Faction Block');
    const today = currentGameDay(db, campaignId);
    const faction = insertFaction(db, campaignId, {
      name: 'The Broken Crown',
      type: 'house',
      realm_id: null,
      county_id: null,
      place_id: places.ficengwind,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      created_day: today,
    });
    updateFaction(db, campaignId, faction.id, { ended_day: today });
    insertAgenda(db, campaignId, {
      faction_id: faction.id,
      template: 'raid',
      target_kind: 'settlement',
      target_id: places.stormcourtby,
      target_name: 'Stormcourtby',
      clock_size: 4,
      clock_filled: 1,
      portents: [{ text: 'A red sail.', fired_day: today, heard: false }],
      status: 'active',
      known_to_party: true,
      started_day: today,
    });

    const text = worldBriefing(db, campaignId, 'Stormcourtby');
    expect(text).toContain(`- A red sail. (${faction.name}, 0 hexes away)`);
    expect(text).toContain(`- ${faction.name}: raid -> Stormcourtby [1/4]`);
  });
});

describe('worldBriefing and a vassal faith', () => {
  it("shows the liege's church when the vassal has none of its own", () => {
    const { campaignId, places, realms } = borderWorld('Vassal Faith Block');
    const today = currentGameDay(db, campaignId);
    const faith = insertFaith(db, campaignId, {
      name: 'the Dawn Covenant',
      aspect: 'dawn',
      symbol: 'a rising sun',
      head_place_id: places.ficengwind,
      fervor: 55,
      heresy_of: null,
      last_heresy_day: null,
      created_day: today,
    });
    const church = insertFaction(db, campaignId, {
      name: 'Temple of Ficengwind',
      type: 'church',
      realm_id: realms[0],
      county_id: null,
      place_id: places.ficengwind,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      created_day: today,
    });
    setFactionFaith(db, campaignId, church.id, faith.id, 'strong');

    const text = worldBriefing(db, campaignId, 'Stormcourtby');
    expect(text).toContain('Faith here:');
    expect(text).toContain(`- ${faith.name} holds strong sway (fervor ${faith.fervor})`);
  });
});

describe('world get with map state', () => {
  it('shows ended_day and the unexpired place_states, and hides an expired one', async () => {
    const client = await connect();
    const campaign_id = await mcpCampaign(client, 'State World Get');
    const { places } = buildBorder(campaign_id);
    const today = currentGameDay(db, campaign_id);

    const ended = insertFaction(db, campaign_id, {
      name: 'The Fallen House',
      type: 'house',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 1,
      capacities: {},
      created_day: today,
    });
    updateFaction(db, campaign_id, ended.id, { ended_day: today });
    const living = insertFaction(db, campaign_id, {
      name: 'The Standing House',
      type: 'house',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 1,
      capacities: {},
      created_day: today,
    });
    setPlaceState(db, campaign_id, places.redham, today, { state: 'raided' });
    setPlaceState(db, campaign_id, places.hotfield, today - RAIDED_DAYS, { state: 'raided' });

    const result = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as unknown as {
      factions: Array<{ id: number; ended_day: number | null }>;
      place_states: Array<{ place: string; state: string; until_day: number }>;
    };

    expect(data.factions.find((faction) => faction.id === ended.id)!.ended_day).toBe(today);
    expect(data.factions.find((faction) => faction.id === living.id)!.ended_day).toBeNull();
    expect(data.place_states).toEqual([{ place: 'Redham', state: 'raided', until_day: today + RAIDED_DAYS }]);
    expect(textOf(result)).toContain('Place states:');
    expect(textOf(result)).toContain(`- Redham: raided until day ${today + RAIDED_DAYS}`);
    expect(textOf(result)).toContain('[ended day ' + today + ']');
    await client.close();
  });
});

describe('the player routes never carry the DM map state', () => {
  it('keeps place states, transfers and ended factions off the world and region replies', async () => {
    const { campaignId, places, counties, realms } = borderWorld('Player Boundary');
    const today = currentGameDay(db, campaignId);
    setPlaceState(db, campaignId, places.redham, today, { state: 'raided' });
    transferCounty(db, campaignId, counties[1], realms[1]);
    insertEvent(db, campaignId, {
      day: today - 3,
      kind: 'agenda_won',
      text: 'Redham takes Hotfield.',
      severity: 3,
      place_id: null,
      faction_id: null,
      agenda_id: null,
      causes: [],
      effects: {
        outcome: 'county_transferred',
        county_id: counties[1],
        from_realm_id: realms[0],
        to_realm_id: realms[1],
      },
      visibility: 'public',
    });
    const faction = insertFaction(db, campaignId, {
      name: 'The Fallen House',
      type: 'house',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 1,
      capacities: {},
      created_day: today,
    });
    updateFaction(db, campaignId, faction.id, { ended_day: today });

    const briefing = worldBriefing(db, campaignId, 'Redham');
    expect(briefing).toContain('raided until day');
    expect(briefing).toContain('passes from');

    const worldRes = await fetch(`${base}/api/campaigns/${campaignId}/world`);
    const worldBody = (await worldRes.json()) as { world: { place_states?: unknown } };
    const worldText = JSON.stringify(worldBody);
    expect(worldBody.world.place_states).toBeUndefined();
    expect(worldText).not.toContain('raided until day');
    expect(worldText).not.toContain('passes from');
    expect(worldText).not.toContain('ended day');

    const regionRes = await fetch(`${base}/api/campaigns/${campaignId}/region`);
    const regionText = await regionRes.text();
    expect(regionText).not.toContain('raided until day');
    expect(regionText).not.toContain('passes from');
  });
});
