// The region tool's get op reports the political division: realms and counties for the whole map,
// and a place's county and realm in a place view.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { findPlace, importRegion } from '../src/core/region.js';
import { getPolitics, saveHierarchy } from '../src/core/politics-store.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import { upsertEntity } from '../src/core/codex.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData } from './helpers/reply.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function newCampaign(client: Client, name: string): Promise<number> {
  const created = await client.callTool({ name: 'create_campaign', arguments: { name, story_shape: 'sandbox' } });
  return replyData<{ campaign_id: number }>(created).campaign_id;
}

/** A handcrafted hierarchy saved directly, so the tool does not depend on the pipeline wiring. */
function saveHandcrafted(campaignId: number): void {
  const redham = findPlace(db, campaignId, 'Redham')!.id;
  const ficengwind = findPlace(db, campaignId, 'Ficengwind')!.id;
  const southernLanding = findPlace(db, campaignId, 'Southern Landing')!.id;

  const counties: ComputedCounties = {
    counties: [
      { name: 'County of Redham', seat_place_id: redham, seat_kind: 'town', hexes: ['q6_r8'], village_place_ids: [], component: 0 },
      { name: 'County of Ficengwind', seat_place_id: ficengwind, seat_kind: 'city', hexes: ['q4_r11'], village_place_ids: [], component: 0 },
      { name: 'March of the Fens', seat_place_id: southernLanding, seat_kind: 'castle', hexes: ['q11_r14'], village_place_ids: [], component: 0 },
    ],
    edges: [],
  };
  const realms: ComputedRealms = {
    realms: [
      { name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: ficengwind, off_map: false, liege: null },
      { name: 'Lordship of Redham', kind: 'lordship', capital_place_id: redham, off_map: false, liege: 0 },
      { name: 'Free City of the Reach', kind: 'free_city', capital_place_id: null, off_map: true, liege: null },
    ],
    county_realm: [1, 0, 1],
  };
  const hierarchy: ComputedHierarchy = {
    duchies: [
      { name: 'Duchy of Redham', realm: 1, seat_place_id: redham, county_indexes: [0], demesne: true, joined_how: 'core' },
      { name: 'Duchy of the Fens', realm: 1, seat_place_id: southernLanding, county_indexes: [2], demesne: false, joined_how: 'conquest' },
    ],
    county_duchy: [0, null, 1],
    march_counties: [2],
    claims: [
      { county: 2, claimant_realm: 0, strength: 'strong', reason: 'ancient kingdom' },
      { county: 1, claimant_realm: 2, strength: 'weak', reason: 'dowry' },
    ],
  };
  saveHierarchy(db, campaignId, { counties, realms, hierarchy });
}

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

/** The map text's realms: each realm header line with the indented duchy and county lines under it. */
function realms(text: string): Map<string, string[]> {
  const lines = text.split('\n');
  const out = new Map<string, string[]>();
  let current: string[] = [];
  for (const line of lines.slice(lines.indexOf('Realms:') + 1)) {
    if (line.startsWith('  ')) current.push(line);
    else if (line === '' || /^(Marches:|Contested:|County land|… and)/.test(line)) break;
    else out.set(line, (current = []));
  }
  return out;
}

/** A county's stored seat and seat kind, which the map text does not carry. */
function countySeat(campaignId: number, name: string): { seat: string | undefined; seat_kind: string } {
  const county = getPolitics(db, campaignId)!.counties.find((entry) => entry.name === name)!;
  return { seat: findPlace(db, campaignId, county.seat_place_id)?.name, seat_kind: county.seat_kind };
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('region get politics', () => {
  it('reports the realms and counties of the whole map', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    const text = textOf(result);
    // One realm, named with its capital.
    expect([...realms(text).keys()]).toEqual(['Kingdom of Ficengwind (kingdom, capital Ficengwind)']);
    const counties = realms(text).get('Kingdom of Ficengwind (kingdom, capital Ficengwind)')!.join('\n');
    // Updated for bounded counties: hexes counts held land, and the former totals are now the claim.
    const land = text.split('\n').find((line) => line.startsWith('County land (held/claimed hexes): '))!;
    for (const [name, seat, held] of [
      ['County of Redham', 'Redham', '8/54'],
      ['County of Ficengwind', 'Ficengwind', '34/76'],
      ['Lordship of Southern Landing', 'Southern Landing', '13/31'],
    ] as const) {
      expect(counties).toContain(name);
      expect(land).toContain(`${name} ${held}`);
      expect(countySeat(campaign_id, name).seat).toBe(seat);
    }
    // Updated for the hierarchy: the text is a header block, not a "Realm ..." line.
    expect(textOf(result)).toContain('Kingdom of Ficengwind (kingdom, capital Ficengwind)');
    expect(textOf(result)).toContain('  Outside duchies: County of Redham, County of Ficengwind');
    await client.close();
  });

  it('reports duchies, county flags and claims for a handcrafted hierarchy', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Handcrafted Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    saveHandcrafted(campaign_id);

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    const text = textOf(result);
    const blocks = realms(text);
    const lines = text.split('\n');

    // A kingdom with its own capital, sworn to no one, and claiming only the March.
    expect(blocks.has('Kingdom of Ficengwind (kingdom, capital Ficengwind)')).toBe(true);
    expect(lines.filter((line) => line.includes('— claimed by Kingdom of Ficengwind'))).toEqual([
      'Contested: March of the Fens — claimed by Kingdom of Ficengwind (ancient kingdom, strong)',
    ]);
    const lordship = blocks.get('Lordship of Redham (lordship, capital Redham, vassal of Kingdom of Ficengwind)')!;
    expect(lordship).toEqual(
      expect.arrayContaining([
        '  Duchy of Redham (seat Redham, crownlands): County of Redham',
        '  Duchy of the Fens (seat Southern Landing, joined by conquest): March of the Fens',
      ]),
    );
    // The March alone is a march; seat kinds are not in the text, so they are read from the store.
    expect(lines).toContain('Marches: March of the Fens');
    expect(countySeat(campaign_id, 'March of the Fens').seat_kind).toBe('castle');
    expect(countySeat(campaign_id, 'County of Redham').seat_kind).toBe('town');
    expect(blocks.has('Free City of the Reach (free city, capital off the map)')).toBe(true);

    expect(text).toContain('Lordship of Redham (lordship, capital Redham, vassal of Kingdom of Ficengwind)');
    expect(text).toContain('  Duchy of Redham (seat Redham, crownlands): County of Redham');
    expect(text).toContain('Marches: March of the Fens');
    expect(text).toContain('Contested: March of the Fens — claimed by Kingdom of Ficengwind (ancient kingdom, strong)');
    await client.close();
  });

  it('reports a place county and realm in the place view', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'get', place: 'Stormcourtby' },
    });
    // The place line names its county, then its realm.
    const firstLine = textOf(result).split('\n')[0]!;
    expect(firstLine).toContain('— County of Redham, Kingdom of Ficengwind');
    await client.close();
  });

  it('names the coastal castle lordship when the map has no city', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Dangerous Map');
    importRegion(db, campaign_id, dangerous, { source: 'uploaded' });

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    expect([...realms(textOf(result)).keys()]).toEqual(['Lordship of Crimson Wharf (lordship, capital Crimson Wharf)']);
    expect(textOf(result)).toContain('Lordship of Crimson Wharf (lordship, capital Crimson Wharf)');
    await client.close();
  });

  it('names the realm when a settlement is revealed', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Reveal realm');
    importRegion(db, campaign_id, safe, { source: 'uploaded' });
    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'reveal', place: 'Redham' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('It belongs to Kingdom of Ficengwind');
  });

  it('still refuses get when the campaign has no region', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'No Map');
    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no region map yet');
    await client.close();
  });

  it('keeps the success text when a realm name is taken by another kind', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Reveal clash');
    importRegion(db, campaign_id, safe, { source: 'uploaded' });
    upsertEntity(db, { campaign_id, kind: 'npc', name: 'Kingdom of Ficengwind', summary: 'A pretender.' });

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'reveal', place: 'Redham' } });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain('is now known to the party');
    expect(text).toContain('already has a npc named "Kingdom of Ficengwind"');
    await client.close();
  });
});
