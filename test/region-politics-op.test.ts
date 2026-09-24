// The region tool's get op reports the political division: realms and counties for the whole map,
// and a place's county and realm in a place view.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { importRegion } from '../src/core/region.js';
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

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

interface RealmData {
  id: number;
  name: string;
  capital: string | null;
  counties: Array<{ id: number; name: string; seat: string; hexes: number }>;
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
    expect(textOf(result)).toContain('Realm Kingdom of Ficengwind (capital Ficengwind)');
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
    expect(textOf(result)).toContain('Realm Kingdom of Crimson Wharf (capital Crimson Wharf)');
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
