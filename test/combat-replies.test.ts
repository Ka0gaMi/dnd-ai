// The combat tool replies stay small and speak to the DM in true names: end_encounter carries no
// embedded battle state, start_encounter points at the turn-loop guide, and nothing says get_battle_state.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot } from '../src/core/campaign.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { addItem } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData } from './helpers/reply.js';
import { activeEncounter, getBattleState } from '../src/combat/state.js';

const END_ENCOUNTER_TOKEN_CAP = 500;

let db: Db;
let stopClicking: () => void;

interface ToolAnswer {
  content: Array<{ type: string; text: string }>;
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function answer(client: Client, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result as unknown as ToolAnswer;
}

const bodyOf = (a: ToolAnswer): string => a.content[0]!.text;

/** A campaign with Borg carrying an unidentified +1 Longsword, and two goblins on a small road. */
async function openFight(client: Client): Promise<{ campaignId: number; started: ToolAnswer }> {
  const created = await answer(client, 'create_campaign', { name: 'Replies', story_shape: 'sandbox' });
  const campaignId = replyData<{ campaign_id: number }>(created).campaign_id;
  await answer(client, 'create_character', {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });
  const started = await answer(client, 'start_encounter', {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 2 }],
  });
  // The rendered start_encounter reply carries no encounter id, so it comes off the encounter row.
  const encounterId = activeEncounter(db, campaignId)!.id;
  // Put the PC first in the order so its legal actions are the active ones.
  db.prepare('UPDATE combatant SET initiative_order = initiative_order + 1 WHERE encounter_id = ?').run(encounterId);
  db.prepare("UPDATE combatant SET initiative_order = 0 WHERE encounter_id = ? AND kind = 'pc'").run(encounterId);
  db.prepare('UPDATE encounter SET turn_index = 0 WHERE id = ?').run(encounterId);
  return { campaignId, started };
}

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

describe('the combat tool replies', () => {
  it('slims end_encounter to the outcome, the party HP and the next step', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);

    const ended = await answer(client, 'end_encounter', { campaign_id: campaignId, outcome: 'retreat', summary: 'Fled.' });
    const body = bodyOf(ended);
    const data = replyData<Record<string, unknown>>(ended);

    expect(estimateTokens(body)).toBeLessThanOrEqual(END_ENCOUNTER_TOKEN_CAP);
    expect(data.state).toBeUndefined();
    expect(data.reminder).toBeUndefined();
    expect(body).not.toMatch(/"state"|"reminder"|XP is a suggestion/);
    expect(data.outcome).toBe('retreat');
    const party = data.party as Array<{ name: string; hp_current: number; hp_max: number }>;
    expect(party.map((p) => p.name)).toEqual(['Borg']);
    expect(party[0]!.hp_max).toBeGreaterThan(0);
    expect(body).toContain('Borg');
    expect(data.next_step).toEqual(expect.any(String));
    await client.close();
  });

  it('shows the DM the true name of an unidentified weapon while the player snapshot stays masked', async () => {
    const client = await connect();
    const { campaignId } = await openFight(client);

    // The rendered battle state lists no legal actions, so the DM's labels come from the engine's DM view.
    const dm = await answer(client, 'get_battle_state', { campaign_id: campaignId });
    const encounter = getBattleState(db, campaignId, false)!;
    expect(encounter.legal_actions.map((a) => a.label)).toContain('Attack: +1 Longsword');
    expect(bodyOf(dm)).not.toContain('Unidentified longsword');

    const player = campaignSnapshot(db, campaignId, { forPlayer: true });
    expect(player.encounter!.legal_actions.map((a) => a.label)).toContain('Attack: Unidentified longsword');
    expect(JSON.stringify(player)).not.toContain('+1 Longsword');
    await client.close();
  });

  it('ends the start_encounter reply with the turn-loop pointer', async () => {
    const client = await connect();
    const { started } = await openFight(client);
    expect(bodyOf(started).trimEnd().split('\n').pop()).toContain('read_guide {section: "combat", topic: "turn-loop"}');
    await client.close();
  });

  it('keeps any "get_battle_state" instruction out of the combat tool file', () => {
    const source = readFileSync(new URL('../src/mcp/tools/combat.ts', import.meta.url), 'utf8');
    const lines = source.split('\n').filter((line) => line.includes('get_battle_state'));
    // Only the tool's own registration may name it.
    expect(lines.filter((line) => !/^\s*'get_battle_state',$/.test(line))).toEqual([]);
  });
});
