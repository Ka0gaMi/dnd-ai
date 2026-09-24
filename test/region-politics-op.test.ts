// The region tool's get op reports the political division: realms and counties for the whole map,
// and a place's county and realm in a place view.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { findPlace, importRegion } from '../src/core/region.js';
import { saveHierarchy } from '../src/core/politics-store.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import { upsertEntity } from '../src/core/codex.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

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
  return (created.structuredContent as { campaign_id: number }).campaign_id;
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

interface RealmData {
  id: number;
  name: string;
  kind: string;
  off_map: boolean;
  capital: string | null;
  liege: string | null;
  duchies: Array<{
    name: string;
    seat: string | null;
    demesne: boolean;
    joined_how: string;
    counties: Array<{ id: number; name: string }>;
  }>;
  counties: Array<{
    id: number;
    name: string;
    seat: string;
    hexes: number;
    seat_kind: string;
    march: boolean;
    duchy: string | null;
  }>;
  claims: Array<{ county: string; strength: string; reason: string }>;
}

interface PoliticsData {
  county: { id: number; name: string } | null;
  realm: { id: number; name: string; capital: string | null } | null;
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
    const data = result.structuredContent as unknown as { realms: RealmData[] };
    expect(data.realms).toHaveLength(1);
    const realm = data.realms[0]!;
    expect(realm.name).toBe('Kingdom of Ficengwind');
    expect(realm.capital).toBe('Ficengwind');
    expect(realm.counties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'County of Redham', seat: 'Redham', hexes: 54 }),
        expect.objectContaining({ name: 'County of Ficengwind', seat: 'Ficengwind', hexes: 76 }),
        expect.objectContaining({ name: 'Lordship of Southern Landing', seat: 'Southern Landing', hexes: 31 }),
      ]),
    );
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
    const data = result.structuredContent as unknown as { realms: RealmData[] };
    const kingdom = data.realms.find((realm) => realm.name === 'Kingdom of Ficengwind')!;
    const lordship = data.realms.find((realm) => realm.name === 'Lordship of Redham')!;

    expect(kingdom).toMatchObject({ kind: 'kingdom', off_map: false, capital: 'Ficengwind', liege: null });
    expect(kingdom.claims).toEqual([{ county: 'March of the Fens', strength: 'strong', reason: 'ancient kingdom' }]);
    expect(lordship).toMatchObject({ kind: 'lordship', liege: 'Kingdom of Ficengwind' });
    expect(lordship.duchies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Duchy of Redham',
          seat: 'Redham',
          demesne: true,
          joined_how: 'core',
          counties: [expect.objectContaining({ name: 'County of Redham' })],
        }),
        expect.objectContaining({ name: 'Duchy of the Fens', demesne: false, joined_how: 'conquest' }),
      ]),
    );
    expect(lordship.counties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'March of the Fens', seat_kind: 'castle', march: true, duchy: 'Duchy of the Fens' }),
        expect.objectContaining({ name: 'County of Redham', seat_kind: 'town', march: false, duchy: 'Duchy of Redham' }),
      ]),
    );
    expect(data.realms.find((realm) => realm.name === 'Free City of the Reach')!.off_map).toBe(true);

    const text = textOf(result);
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
    const data = result.structuredContent as unknown as { politics: PoliticsData };
    expect(data.politics.county?.name).toBe('County of Redham');
    expect(data.politics.realm?.name).toBe('Kingdom of Ficengwind');
    const firstLine = textOf(result).split('\n')[0]!;
    expect(firstLine).toContain('County of Redham, Kingdom of Ficengwind');
    await client.close();
  });

  it('crowns the coastal castle when the map has no city', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Dangerous Map');
    importRegion(db, campaign_id, dangerous, { source: 'uploaded' });

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    const data = result.structuredContent as unknown as { realms: RealmData[] };
    expect(data.realms).toHaveLength(1);
    expect(data.realms[0]).toMatchObject({ name: 'Kingdom of Crimson Wharf', capital: 'Crimson Wharf' });
    expect(textOf(result)).toContain('Kingdom of Crimson Wharf (kingdom, capital Crimson Wharf)');
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
