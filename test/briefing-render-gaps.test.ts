import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { replyData, replyText } from './helpers/reply.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function setup(settings?: Record<string, unknown>): Promise<{ client: Client; id: number }> {
  const client = await connect();
  const created = await client.callTool({
    name: 'create_campaign',
    arguments: { name: 'Gaps', story_shape: 'structured', ...(settings ? { settings } : {}) },
  });
  const { campaign_id } = replyData<{ campaign_id: number }>(created);
  const made = await client.callTool({
    name: 'create_character',
    arguments: {
      campaign_id,
      name: 'Borg',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    },
  });
  if (made.isError) throw new Error(replyText(made));
  return { client, id: campaign_id };
}

const load = async (client: Client, id: number): Promise<string> =>
  replyText(await client.callTool({ name: 'load_campaign', arguments: { campaign_id: id } }));

describe('the briefing text carries the PC proficiencies and features', () => {
  it('lists proficient skills, proficient saves and feature names', async () => {
    const { client, id } = await setup();
    const text = await load(client, id);
    const skills = text.match(/^Skills: (.*); Saves: (.*)$/m);
    expect(skills).not.toBeNull();
    expect(skills![1]).toMatch(/athletics/);
    expect(skills![1]).toMatch(/perception/);
    expect(skills![2]).toBe('STR, CON');
    expect(text).toMatch(/^Features: .*Second Wind/m);
    await client.close();
  });

  it('stays within the 5,000 token budget for a level-5 character', async () => {
    const { client, id } = await setup();
    const sheet = db.prepare('SELECT id, features_json FROM character WHERE campaign_id = ?').get(id) as {
      id: number;
      features_json: string;
    };
    const features = JSON.parse(sheet.features_json) as unknown[];
    for (let i = 0; i < 25; i++) features.push({ name: `Extra Feature Number ${i}`, source: 'class', text: 'x' });
    db.prepare('UPDATE character SET level = 5, features_json = ? WHERE id = ?').run(JSON.stringify(features), sheet.id);
    const text = await load(client, id);
    expect(text).toContain('Extra Feature Number 24');
    expect(estimateTokens(text)).toBeLessThanOrEqual(5000);
    await client.close();
  });
});

describe('the canon facts', () => {
  it('carry their ids, so checkpoint supersedes_id has a source', async () => {
    const { client, id } = await setup();
    const remember = async (subject: string, fact: string): Promise<number> =>
      replyData<{ id: number }>(
        await client.callTool({ name: 'remember', arguments: { op: 'fact', campaign_id: id, subject, fact } }),
      ).id;
    const mira = await remember('Mira', 'Mira keeps the ferry at Redham.');
    const gate = await remember('Redham', 'Redham bars its gate at dusk.');
    const text = await load(client, id);
    expect(text).toContain(`\n- Mira (id ${mira}): Mira keeps the ferry at Redham.\n`);
    expect(text).toContain(`\n- Redham (id ${gate}): Redham bars its gate at dusk.\n`);
    await client.close();
  });
});

describe('the DC disclosure line', () => {
  it('shows only when dc_disclosure is shown', async () => {
    const shown = await setup({ setting_preset: 'classic-fantasy', dc_disclosure: 'shown' });
    expect(await load(shown.client, shown.id)).toContain('DC disclosure: shown');
    await shown.client.close();
  });

  it('is absent by default', async () => {
    const plain = await setup();
    expect(await load(plain.client, plain.id)).not.toContain('DC disclosure');
    await plain.client.close();
  });
});
