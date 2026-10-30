import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { campaignSnapshot, loadCampaign } from '../src/core/campaign.js';
import { getBattleState } from '../src/combat/state.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData, replyText } from './helpers/reply.js';

let db: Db;
let stopClicking: () => void;
const realRandom = Math.random;
/** 0.041 pins every d20, so the seeded fight plays out the same way every run. */
const NAT_20 = 0.041;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return replyData<T>(result);
}

/** The reply text of a tool that answers in rendered words rather than JSON. */
async function text(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(replyText(result));
  return replyText(result);
}

/** The lines under one heading of the rendered briefing, up to the next blank line. */
const section = (briefing: string, heading: string): string[] => {
  const start = briefing.indexOf(`\n${heading}\n`) + heading.length + 2;
  return briefing.slice(start, briefing.indexOf('\n\n', start)).split('\n');
};

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
  Math.random = () => NAT_20;
});

afterEach(() => {
  stopClicking();
  Math.random = realRandom;
});

describe('load_campaign answers with a slim briefing', () => {
  it('summarises the fight and names the features, while the window snapshot keeps the detail', async () => {
    const client = await connect();
    const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
      name: 'Briefing Diet',
      story_shape: 'structured',
    });
    await call(client, 'create_character', {
      campaign_id,
      name: 'Borg',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    await text(client, 'start_encounter', {
      campaign_id,
      seed: 7,
      terrain: 'road',
      size: 'small',
      features: ['road'],
      enemies: [{ creature: 'Goblin Warrior', count: 1 }],
    });

    const slim = await text(client, 'load_campaign', { campaign_id });

    // The fight as a summary: the round and who is up, one line per combatant, and get_battle_state for the grid.
    const fight = section(slim, '## Combat in progress');
    expect(fight[0]).toMatch(/^Encounter \d+, round \d+, .+ is up\. Call get_battle_state for the grid\.$/);
    expect(fight).toHaveLength(1 + getBattleState(db, campaign_id, false)!.combatants.length);

    // Features appear in the text by name only: their full text, read off the briefing data, is never sent.
    const full = loadCampaign(db, campaign_id);
    const features = full.pc!.features as Array<{ name: string; source: string; text?: string }>;
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      if (feature.text) expect(slim).not.toContain(feature.text);
    }
    expect(section(slim, '## Player character')[0]).toMatch(/, HP \d+\/\d+, AC \d+, /);
    expect(full.pc!.skills).toBeDefined();
    expect(slim).toContain('\n## Party\n');
    expect(slim).toContain('\n## Story arc\n');

    expect(slim.length).toBeLessThan(JSON.stringify(full).length);

    const snapshot = campaignSnapshot(db, campaign_id, { forPlayer: true });
    expect(Array.isArray(snapshot.encounter?.combatants)).toBe(true);
    await client.close();
  });

  it('keeps encounter null when no fight is running', async () => {
    const client = await connect();
    const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
      name: 'Quiet Night',
      story_shape: 'structured',
    });
    const slim = await text(client, 'load_campaign', { campaign_id });
    expect(slim).not.toContain('## Combat in progress');
    await client.close();
  });
});
