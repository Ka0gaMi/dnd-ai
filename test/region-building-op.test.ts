// The region tool's building op: it fetches a named building's Dwellings floor plan once, caches it
// and returns the digest. The fetcher is mocked so no browser runs.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';

vi.mock('../src/core/building-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/building-fetch.js')>();
  return { ...actual, fetchBuildingPlan: vi.fn() };
});

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const tavernPlan = JSON.parse(
  readFileSync(new URL('./fixtures/plan-tavern.json', import.meta.url), 'utf8'),
) as unknown;
const gothicPlan = JSON.parse(
  readFileSync(new URL('./fixtures/plan-gothic.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createGameServer: (typeof import('../src/mcp/server.js'))['createGameServer'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let upsertEntity: (typeof import('../src/core/codex.js'))['upsertEntity'];
let fetchBuildingPlan: (typeof import('../src/core/building-fetch.js'))['fetchBuildingPlan'];
let BuildingFetchError: (typeof import('../src/core/building-fetch.js'))['BuildingFetchError'];
let mockedFetch: ReturnType<typeof vi.mocked<typeof fetchBuildingPlan>>;

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may already have loaded the route with the
  // real fetcher, so drop the module cache and import the server fresh under the mock.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createGameServer } = await import('../src/mcp/server.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  ({ upsertEntity } = await import('../src/core/codex.js'));
  ({ fetchBuildingPlan, BuildingFetchError } = await import('../src/core/building-fetch.js'));
  mockedFetch = vi.mocked(fetchBuildingPlan);
});

beforeEach(() => {
  db = openDb(':memory:');
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (url: string) => ({ raw: tavernPlan, url }));
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

const countBuildings = (campaign_id: number): unknown =>
  db.prepare('SELECT COUNT(*) AS n FROM world_building WHERE campaign_id = ?').get(campaign_id);

interface BuildingReply {
  place: string;
  building: string;
  kind: string;
  known: boolean;
  cached: boolean;
  digest: { entrance: string | null; secret_rooms: Array<{ name: string }> };
}

interface PlaceReply {
  place: { name: string; known: boolean };
  buildings?: Array<{ name: string; kind: string; known: boolean }>;
}

interface MapData {
  settlements: Array<{ name: string; known: boolean }>;
}

describe('the mocked building fetcher', () => {
  it('fetchBuildingPlan is the mock', () => {
    expect(vi.isMockFunction(fetchBuildingPlan)).toBe(true);
  });
});

describe('region op=building', () => {
  it('creates a tavern from its floor plan, then serves it from cache', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const first = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: 'The Gilded Goose', kind: 'tavern' },
    });
    expect(first.isError).toBeFalsy();
    const data = first.structuredContent as unknown as BuildingReply;
    expect(data.digest.entrance).toBe('Common room');
    expect(data.cached).toBe(false);
    expect(textOf(first)).toContain('The Gilded Goose (tavern, 2 floors)');
    expect(textOf(first)).toContain('The party has not been inside The Gilded Goose yet.');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(expect.stringContaining('rooms=tavern'), { timeoutMs: 35000 });

    const second = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: 'The Gilded Goose' },
    });
    expect(second.isError).toBeFalsy();
    expect((second.structuredContent as unknown as BuildingReply).cached).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('asks for a kind before creating an unknown building', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: 'Nowhere' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('give a kind');
    expect(mockedFetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('refuses a blank building name before fetching', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: '   ', kind: 'tavern' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('A building needs a name.');
    expect(mockedFetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('refuses a place that is not a settlement', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Coldwood', building: 'Hunter Lodge', kind: 'house' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is not a settlement');
    expect(mockedFetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('lists secret rooms in the digest for the DM', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    mockedFetch.mockResolvedValueOnce({
      raw: gothicPlan,
      url: 'https://watabou.github.io/dwellings/?seed=1&rooms=gothic',
    });
    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: 'Chapel of Dawn', kind: 'temple' },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Hidden from the player's plan: Secret passage");
    await client.close();
  });

  it('turns a fetch failure into a readable error and stores nothing', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    mockedFetch.mockRejectedValueOnce(new BuildingFetchError('boom'));
    const failed = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: 'Broken Hall', kind: 'house' },
    });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('boom');
    expect(textOf(failed)).toContain('describe');
    expect(countBuildings(campaign_id)).toEqual({ n: 0 });
    await client.close();
  });

  it('refuses a floor plan it cannot digest and stores nothing', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    mockedFetch.mockResolvedValueOnce({ raw: { floors: 'x' }, url: 'https://watabou.github.io/dwellings/?seed=1' });
    const failed = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: 'Bad Plan', kind: 'house' },
    });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('could not be read');
    expect(countBuildings(campaign_id)).toEqual({ n: 0 });
    await client.close();
  });
});

describe('region op=reveal with a building', () => {
  it('reveals the building and its settlement together', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: 'The Gilded Goose', kind: 'tavern' },
    });

    const revealed = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'reveal', place: 'Redham', building: 'The Gilded Goose' },
    });
    expect(revealed.isError).toBeFalsy();
    expect(textOf(revealed)).toContain("its plan shows in Redham's codex entry");

    const map = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    const settlements = (map.structuredContent as unknown as MapData).settlements;
    expect(settlements.find((s) => s.name === 'Redham')?.known).toBe(true);

    const place = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'get', place: 'Redham' },
    });
    const buildings = (place.structuredContent as unknown as PlaceReply).buildings;
    expect(buildings).toContainEqual({ name: 'The Gilded Goose', kind: 'tavern', known: true });
    expect(textOf(place)).toContain('Buildings: The Gilded Goose (tavern) [known]');
    await client.close();
  });

  it('warns and drops the codex clause when the town name is another codex kind', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    upsertEntity(db, { campaign_id, kind: 'npc', name: 'Redham' });
    await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'building', place: 'Redham', building: 'The Gilded Goose', kind: 'tavern' },
    });

    const revealed = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'reveal', place: 'Redham', building: 'The Gilded Goose' },
    });
    expect(revealed.isError).toBeFalsy();
    const data = revealed.structuredContent as unknown as { warning?: string };
    expect(data.warning).toContain('already has a npc named "Redham"');
    expect(textOf(revealed)).toContain('Redham has no codex entry the player can open');
    expect(textOf(revealed)).not.toContain("its plan shows in Redham's codex entry");
    await client.close();
  });

  it('refuses to reveal a building that does not exist yet', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'Safe Buildings');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'reveal', place: 'Redham', building: 'The Gilded Goose' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Create it with');
    await client.close();
  });
});
