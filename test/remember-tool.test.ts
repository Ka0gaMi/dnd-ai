// The canon-fact and glossary families behind one `remember` tool, through the MCP client:
// what each op lands, what the briefing shows, and the refusals the op helper owes the DM.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

let db: Db;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

const textOf = (result: { content: Array<{ text: string }> }): string => result.content[0]!.text;

async function makeCampaign(client: Client): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Remember',
    story_shape: 'sandbox',
  });
  return campaign_id;
}

const briefing = (client: Client, campaignId: number) =>
  call<{ canon_facts: Array<{ subject: string; fact: string }>; glossary_terms: string[] }>(client, 'load_campaign', {
    campaign_id: campaignId,
  });

beforeEach(() => {
  db = openDb(':memory:');
});

describe('remember {op: fact}', () => {
  it('lands a canon fact the briefing shows', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const result = await call<{ id: number; subject: string; fact: string }>(client, 'remember', {
      op: 'fact',
      campaign_id,
      subject: 'Mira',
      fact: 'Mira runs the Copper Kettle inn.',
    });
    expect(result.id).toBeDefined();
    expect(result.subject).toBe('Mira');

    const shown = await briefing(client, campaign_id);
    expect(shown.canon_facts.map((f) => f.fact)).toContain('Mira runs the Copper Kettle inn.');
    await client.close();
  });

  it('retires the old fact when supersedes_id is passed', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    const first = await call<{ id: number }>(client, 'remember', {
      op: 'fact',
      campaign_id,
      subject: 'Mira',
      fact: 'Mira runs the inn.',
    });

    await call(client, 'remember', {
      op: 'fact',
      campaign_id,
      subject: 'Mira',
      fact: 'Mira sold the inn.',
      supersedes_id: first.id,
    });

    const shown = await briefing(client, campaign_id);
    expect(shown.canon_facts.map((f) => f.fact)).toEqual(['Mira sold the inn.']);
    const row = db.prepare('SELECT active FROM canon_fact WHERE id = ?').get(first.id) as { active: number };
    expect(row.active).toBe(0);
    await client.close();
  });

  it('teaches which fields op=fact needs', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const missing = await client.callTool({ name: 'remember', arguments: { op: 'fact', campaign_id } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing as { content: Array<{ text: string }> })).toBe(
      'Missing subject, fact for op=fact (requires subject, fact). Re-call with subject, fact set.',
    );
    await client.close();
  });

  it('refuses the term fields on op=fact', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const refused = await client.callTool({
      name: 'remember',
      arguments: { op: 'fact', campaign_id, subject: 'Mira', fact: 'Mira runs the inn.', term: 'Mira' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused as { content: Array<{ text: string }> })).toBe(
      'term does not apply to op=fact; it takes campaign_id, subject, fact, supersedes_id. Re-call without it.',
    );
    await client.close();
  });
});

describe('remember {op: term}', () => {
  it('adds a glossary term the briefing lists', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const result = await call<{ term: string; definition: string }>(client, 'remember', {
      op: 'term',
      campaign_id,
      term: 'Sain',
      definition: 'A minor god of embers.',
    });
    expect(result.term).toBe('Sain');

    const shown = await briefing(client, campaign_id);
    expect(shown.glossary_terms).toContain('Sain');
    await client.close();
  });

  it('teaches which fields op=term needs', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const missing = await client.callTool({ name: 'remember', arguments: { op: 'term', campaign_id } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing as { content: Array<{ text: string }> })).toBe(
      'Missing term, definition for op=term (requires term, definition). Re-call with term, definition set.',
    );
    await client.close();
  });

  it('refuses the fact fields on op=term', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const refused = await client.callTool({
      name: 'remember',
      arguments: { op: 'term', campaign_id, term: 'Sain', definition: 'A minor god of embers.', subject: 'Sain' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused as { content: Array<{ text: string }> })).toBe(
      'subject does not apply to op=term; it takes campaign_id, term, definition. Re-call without it.',
    );
    await client.close();
  });
});

describe('the remember tool surface', () => {
  it('advertises remember and neither legacy fact tool', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('remember');
    expect(names).not.toContain('add_canon_fact');
    expect(names).not.toContain('add_glossary_entry');
    await client.close();
  });

  it('keeps log_event beside it', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('log_event');
    await client.close();
  });
});
