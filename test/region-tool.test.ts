import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { importRegion } from '../src/core/region.js';
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

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

/** The "- " lines under a section title of the map text; an empty section reads "- none". */
function items(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(title);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('- '));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line !== '- none');
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
    const text = textOf(result);
    expect(text.split('\n')[0]).toMatch(/; 6 miles per hex\)$/);
    expect(items(text, 'Settlements:')).toHaveLength(5);
    expect(items(text, 'Areas:')).toHaveLength(3);
    expect(items(text, 'Dangers:')).toHaveLength(0);
    expect(items(text, 'Routes:')).toHaveLength(9);
    expect(items(text, 'Routes:')[0]).toBe('- road: Stormcourtby - Redham, 4 hexes');
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
    const lines = textOf(result).split('\n');
    expect(lines[0]).toMatch(/^Redham \(/);
    expect(lines.find((line) => line.startsWith('Within 3 hexes: '))).toMatch(/[ ;]Ironfall Fens \(\w+, 1 hexes,/);
    // One stop on the way, Stormcourtby.
    expect(lines.find((line) => line.startsWith('Route to Ficengwind: '))).toMatch(/, 16 hexes \(\d+ miles\) via Stormcourtby\.$/);
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
    expect(textOf(result)).toContain('No road or sea route to Coldwood');
    expect(textOf(result)).not.toContain('Route to Coldwood');
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
    const dangers = items(textOf(result), 'Dangers:');
    expect(dangers).toHaveLength(2);
    for (const danger of dangers) {
      expect(danger).toMatch(/ \(nearest .+, \d+ hexes away\)/);
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
    const redhamEntity = (): { id: number } | undefined =>
      db
        .prepare('SELECT id FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
        .get(campaign_id, 'Redham') as { id: number } | undefined;
    // No entry before the reveal, so the one after it was created by the reveal.
    expect(redhamEntity()).toBeUndefined();

    const revealed = await client.callTool({
      name: 'region',
      arguments: { campaign_id, op: 'reveal', place: 'Redham' },
    });
    expect(textOf(revealed)).toContain('Redham is now known to the party and has a codex entry.');

    const entity = redhamEntity();
    expect(entity).toBeDefined();

    const map = await client.callTool({ name: 'region', arguments: { campaign_id, op: 'get' } });
    const redham = items(textOf(map), 'Settlements:').find((line) => /^- #\d+ Redham \(/.test(line));
    expect(redham).toContain(') [known]: ');
    await client.close();
  });

  it('serves the region guide', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'read_guide', arguments: { section: 'region' } });
    // A missing page answers with "No guide page", so its absence says the page was found.
    expect(textOf(result)).not.toContain('No guide page');
    expect(textOf(result)).toContain('6 miles');
    await client.close();
  });
});
