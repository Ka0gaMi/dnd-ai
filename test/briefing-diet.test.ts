import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { campaignSnapshot, loadCampaign } from '../src/core/campaign.js';
import { resolvePendingRollsImmediately } from './helpers.js';

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
  return result.structuredContent as T;
}

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
    await call(client, 'start_encounter', {
      campaign_id,
      seed: 7,
      terrain: 'road',
      size: 'small',
      features: ['road'],
      enemies: [{ creature: 'Goblin Warrior', count: 1 }],
    });

    const slim = await call<Record<string, unknown>>(client, 'load_campaign', { campaign_id });

    const encounter = slim.encounter as Record<string, unknown>;
    expect(Object.keys(encounter).sort()).toEqual(['active', 'legal_actions', 'round', 'summary', 'turn_index']);
    expect(typeof encounter.summary).toBe('string');
    expect(encounter.summary as string).toContain('Round ');

    const pc = slim.pc as Record<string, unknown>;
    const features = pc.features as Array<Record<string, unknown>>;
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(Object.keys(feature).sort()).toEqual(['name', 'source']);
    }
    expect(pc.hp_max).toBeDefined();
    expect(pc.ac).toBeDefined();
    expect(pc.skills).toBeDefined();
    expect(Array.isArray(slim.companions)).toBe(true);
    expect(slim.story).toBeDefined();

    const full = JSON.stringify(loadCampaign(db, campaign_id));
    const slimmed = JSON.stringify(slim);
    expect(slimmed.length).toBeLessThan(full.length);

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
    const slim = await call<Record<string, unknown>>(client, 'load_campaign', { campaign_id });
    expect(slim.encounter).toBeNull();
    await client.close();
  });
});
