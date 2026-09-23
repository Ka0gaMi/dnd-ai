// The region tool's map op: it fetches a place's Watabou export once, caches it and returns the
// digest. The fetcher is mocked so no browser runs.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';

vi.mock('../src/core/place-map-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/place-map-fetch.js')>();
  return { ...actual, fetchPlaceMap: vi.fn() };
});

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;
const cityMap = JSON.parse(
  readFileSync(new URL('./fixtures/map-city-redham.json', import.meta.url), 'utf8'),
) as unknown;
const villageMap = JSON.parse(
  readFileSync(new URL('./fixtures/map-village-hotfield.json', import.meta.url), 'utf8'),
) as unknown;
const dungeonMap = JSON.parse(
  readFileSync(new URL('./fixtures/map-dungeon-hidden-keep.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createGameServer: (typeof import('../src/mcp/server.js'))['createGameServer'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let fetchPlaceMap: (typeof import('../src/core/place-map-fetch.js'))['fetchPlaceMap'];
let PlaceMapFetchError: (typeof import('../src/core/place-map-fetch.js'))['PlaceMapFetchError'];
let mockedFetch: ReturnType<typeof vi.mocked<typeof fetchPlaceMap>>;

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may already have loaded the route with the
  // real fetcher, so drop the module cache and import the server fresh under the mock.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createGameServer } = await import('../src/mcp/server.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  ({ fetchPlaceMap, PlaceMapFetchError } = await import('../src/core/place-map-fetch.js'));
  mockedFetch = vi.mocked(fetchPlaceMap);
});

beforeEach(() => {
  db = openDb(':memory:');
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (link: string) => {
    if (link.includes('/city-generator/')) return { kind: 'city' as const, raw: cityMap, url: link };
    if (link.includes('/village-generator/')) return { kind: 'village' as const, raw: villageMap, url: link };
    return { kind: 'dungeon' as const, raw: dungeonMap, url: link };
  });
});

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

const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;

interface MapReply {
  place: string;
  place_kind: string;
  map_kind: string;
  cached: boolean;
  fetched_at: string;
  digest: { kind: string; buildings?: number; title?: string };
}

describe('the mocked place-map fetcher', () => {
  it('fetchPlaceMap is the mock', () => {
    expect(vi.isMockFunction(fetchPlaceMap)).toBe(true);
  });
});

describe('region op=map', () => {
  it('fetches a city map once and serves it from cache afterwards', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const first = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'map', place: 'Redham' } });
    expect(first.isError).toBeFalsy();
    const data = first.structuredContent as unknown as MapReply;
    expect(data.digest.kind).toBe('city');
    expect(data.digest.buildings).toBe(343);
    expect(data.cached).toBe(false);
    expect(textOf(first)).toContain('Merchants District');
    expect(textOf(first)).toContain('has not heard of Redham');
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    const second = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'map', place: 'Redham' } });
    const again = second.structuredContent as unknown as MapReply;
    expect(again.cached).toBe(true);
    expect(again.fetched_at).toBe(data.fetched_at);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('drops the "not heard" line once the party has been told of the place', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    await client.callTool({ name: 'region', arguments: { campaign_id, op: 'reveal', place: 'Redham' } });
    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'map', place: 'Redham' } });
    expect(textOf(result)).not.toContain('has not heard of Redham');
    await client.close();
  });

  it('returns a village digest for a village', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'map', place: 'Stormcourtby' },
    });
    const data = result.structuredContent as unknown as MapReply;
    expect(data.digest.kind).toBe('village');
    expect(data.map_kind).toBe('village');
    await client.close();
  });

  it('refuses an area, which has no map of its own', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'map', place: 'Coldwood' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is an area');
    expect(mockedFetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('returns a dungeon digest for a danger', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Dangerous Map');
    importRegion(db, campaign_id, dangerous, { source: 'uploaded' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'map', place: 'Hidden Keep' },
    });
    const data = result.structuredContent as unknown as MapReply;
    expect(data.digest.kind).toBe('dungeon');
    expect(data.map_kind).toBe('dungeon');
    expect(textOf(result)).toContain('Story:');
    expect(textOf(result)).toContain('Flavour only');
    expect(textOf(result)).not.toContain('has not heard');
    await client.close();
  });

  it('turns a fetch failure into a readable error and stores nothing', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    mockedFetch.mockRejectedValueOnce(new PlaceMapFetchError('boom'));
    const failed = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'map', place: 'Redham' } });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('boom');
    expect(textOf(failed)).toContain('describe');

    const ok = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'map', place: 'Redham' } });
    expect(ok.isError).toBeFalsy();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it('refuses map without a place', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Map');
    const result = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'map' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Missing place for op=map (requires place). Re-call with place set.');
    await client.close();
  });
});
