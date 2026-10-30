// Every tool reply is text alone: Claude Code shows the model only structuredContent when a reply has it,
// so the rendered text must be the one channel on every host, refusals included.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBattleState } from '../src/combat/state.js';
import { importRegion } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData, replyText } from './helpers/reply.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

type Reply = Awaited<ReturnType<Client['callTool']>>;

interface Step {
  step: string;
  result: Reply;
}

let db: Db;
let client: Client;
let stopClicking: () => void;
const realRandom = Math.random;
const replies: Step[] = [];
const refusals: Array<Step & { teaches: RegExp }> = [];

async function call(step: string, name: string, args: Record<string, unknown>): Promise<Reply> {
  const result = await client.callTool({ name, arguments: args });
  replies.push({ step, result });
  return result;
}

async function refuse(step: string, name: string, args: Record<string, unknown>, teaches: RegExp): Promise<void> {
  refusals.push({ step, result: await client.callTool({ name, arguments: args }), teaches });
}

beforeAll(async () => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
  // A golden-ratio walk: spread like random draws, but the same script every run so a failure replays.
  let draw = 0;
  Math.random = () => (++draw * 0.6180339887498949) % 1;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'reply-shape', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);

  const created = await call('create_campaign', 'create_campaign', { name: 'Plain Words', story_shape: 'sandbox' });
  const campaign_id = replyData<{ campaign_id: number }>(created).campaign_id;
  await refuse('region get without a map', 'region', { campaign_id, op: 'get' }, /no region map yet/);
  importRegion(db, campaign_id, safe, { source: 'generated' });
  await call('load_campaign list', 'load_campaign', {});
  await call('create_character', 'create_character', {
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
  await call('roll', 'roll', { campaign_id, expr: '1d20+2', purpose: 'Perception check' });
  await call('get_character_sheet', 'get_character_sheet', { campaign_id });

  await call('start_encounter', 'start_encounter', {
    campaign_id,
    seed: 7,
    terrain: 'road',
    size: 'small',
    features: ['road'],
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const wolf = { campaign_id, terrain: 'cave', enemies: [{ creature: 'Wolf' }] };
  await refuse('a second start_encounter', 'start_encounter', wolf, /end_encounter/);
  await call('get_battle_state', 'get_battle_state', { campaign_id });
  const battle = () => getBattleState(db, campaign_id, false)!;
  const pcId = battle().combatants.find((c) => c.kind === 'pc')!.id;
  let attacked = false;
  for (let turn = 0; turn < 12 && !attacked; turn += 1) {
    const enemy = battle().combatants.find((c) => c.team === 'enemy' && c.alive);
    if (!enemy) break;
    if (battle().active?.id === pcId) {
      if ((enemy.distance_ft ?? 99) > 5) {
        await call('move_token', 'move_token', { campaign_id, combatant_id: pcId, toward: enemy.id });
      }
      const near = battle().combatants.find((c) => c.id === enemy.id)!;
      if ((near.distance_ft ?? 99) <= 5) {
        const swing = { campaign_id, attacker_id: pcId, target_id: enemy.id, action_name: 'Greatsword' };
        await call('attack', 'attack', swing);
        attacked = true;
      }
    }
    await call('advance_turn', 'advance_turn', { campaign_id });
  }
  expect(attacked).toBe(true);
  await call('end_encounter', 'end_encounter', { campaign_id, outcome: 'victory', summary: 'The goblin falls.' });

  await call('checkpoint save', 'checkpoint', {
    op: 'save',
    campaign_id,
    scene_title: 'The Road',
    scene_summary: 'Borg cut down a goblin on the road.',
  });
  await call('load_campaign briefing', 'load_campaign', { campaign_id });
  await call('read_guide', 'read_guide', { section: 'combat' });
  const juggling = { section: 'combat', topic: 'juggling' };
  await refuse('read_guide unknown topic', 'read_guide', juggling, /No topic "juggling" in the combat guide\. Its topics/);
  await call('world get', 'world', { campaign_id, op: 'get' });
  const nobody = { campaign_id, op: 'get', faction: 'Nobody At All' };
  await refuse('world get unknown faction', 'world', nobody, /No faction "Nobody At All"/);
  await call('region get', 'region', { campaign_id, op: 'get' });
}, 120_000);

afterAll(async () => {
  stopClicking();
  Math.random = realRandom;
  await client.close();
});

describe('tool replies are text alone', () => {
  it('ran every common call in the script', () => {
    const steps = new Set(replies.map((entry) => entry.step));
    for (const step of [
      'create_campaign',
      'load_campaign list',
      'create_character',
      'roll',
      'get_character_sheet',
      'start_encounter',
      'get_battle_state',
      'attack',
      'advance_turn',
      'end_encounter',
      'checkpoint save',
      'load_campaign briefing',
      'read_guide',
      'world get',
      'region get',
    ]) {
      expect(steps, step).toContain(step);
    }
  });

  it('answers each call with non-empty text content and no structuredContent', () => {
    for (const { step, result } of replies) {
      expect(result.isError, `${step}: ${replyText(result)}`).toBeFalsy();
      expect('structuredContent' in result, step).toBe(false);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.length, step).toBeGreaterThan(0);
      for (const part of content) expect(part.type, step).toBe('text');
      expect(replyText(result).trim().length, step).toBeGreaterThan(0);
    }
  });

  it('keeps a refusal isError, in text alone, teaching the way on', () => {
    expect(refusals.length).toBe(4);
    for (const { step, result, teaches } of refusals) {
      expect(result.isError, step).toBe(true);
      expect('structuredContent' in result, step).toBe(false);
      expect(replyText(result), step).toMatch(teaches);
    }
  });
});
