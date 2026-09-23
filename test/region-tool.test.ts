import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { importRegion } from '../src/core/region.js';
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

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

interface MapData {
  miles_per_hex: number;
  settlements: Array<{ name: string; known: boolean }>;
  areas: Array<{ name: string }>;
  dangers: Array<{ name: string; nearest_settlement: string | null; hexes_away: number | null }>;
  routes: Array<{ kind: string; from: string; to: string; hexes: number }>;
}

interface PlaceData {
  place: { id: number; name: string; kind: string; known: boolean };
  nearby: Array<{ id: number; name: string; kind: string; hexes: number; miles: number }>;
  route?: { hexes: number; miles: number; kinds: string[]; stops: string[] } | null;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('region tool', () => {
  it('is listed', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('region');
    await client.close();
  });

  it('teaches when the campaign has no region map', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'No Map');
    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no region map yet');
    await client.close();
  });

  it('lists the whole map with the DM-only dangers', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    const data = result.structuredContent as unknown as MapData;
    expect(data.miles_per_hex).toBe(6);
    expect(data.settlements).toHaveLength(5);
    expect(data.areas).toHaveLength(3);
    expect(data.dangers).toHaveLength(0);
    expect(data.routes).toHaveLength(9);
    expect(data.routes[0]).toEqual({ kind: 'road', from: 'Stormcourtby', to: 'Redham', hexes: 4 });
    await client.close();
  });

  it('reads one place with its neighbours and the route to a second place', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'get', place: 'Redham', to: 'Ficengwind' },
    });
    const data = result.structuredContent as unknown as PlaceData;
    expect(data.place.name).toBe('Redham');
    expect(data.nearby).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Ironfall Fens', hexes: 1 })]),
    );
    expect(data.route).toMatchObject({ hexes: 16, stops: ['Stormcourtby'] });
    await client.close();
  });

  it('falls back to the straight-line distance when no route reaches the place', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'get', place: 'Redham', to: 'Coldwood' },
    });
    const data = result.structuredContent as unknown as PlaceData;
    expect(data.route).toBeNull();
    expect(textOf(result)).toContain('straight-line distance');
    await client.close();
  });

  it('refuses a place that is not on the map', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get', place: 'Atlantis' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No place "Atlantis"');
    await client.close();
  });

  it('names the nearest settlement for each danger', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Dangerous Map');
    importRegion(db, campaign_id, dangerous, { source: 'uploaded' });

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    const data = result.structuredContent as unknown as MapData;
    expect(data.dangers).toHaveLength(2);
    for (const danger of data.dangers) {
      expect(typeof danger.nearest_settlement).toBe('string');
      expect(typeof danger.hexes_away).toBe('number');
    }
    await client.close();
  });

  it('refuses reveal without a place', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'reveal' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Missing place for op=reveal (requires place). Re-call with place set.');
    await client.close();
  });

  it('reveals a place, writes its codex entry and marks it known', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const revealed = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'reveal', place: 'Redham' },
    });
    expect((revealed.structuredContent as unknown as { created: boolean }).created).toBe(true);

    const entity = db
      .prepare('SELECT id FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
      .get(campaign_id, 'Redham') as { id: number } | undefined;
    expect(entity).toBeDefined();

    const map = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    const settlements = (map.structuredContent as unknown as MapData).settlements;
    expect(settlements.find((s) => s.name === 'Redham')?.known).toBe(true);
    await client.close();
  });

  it('serves the region guide', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'read_guide', arguments: { section: 'region' } });
    const guide = result.structuredContent as unknown as { found: boolean; text: string };
    expect(guide.found).toBe(true);
    expect(guide.text).toContain('6 miles');
    await client.close();
  });
});
