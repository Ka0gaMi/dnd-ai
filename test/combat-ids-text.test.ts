// A DM that reads only the reply text can take every combatant and effect id a combat call needs:
// the battle legend, the "is up" line, the touched lines, the turn brief and the effect a turn started.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyText } from './helpers/reply.js';

/** The Playability review's cap on one turn reply, in estimated tokens. */
const TURN_REPLY = 300;

/** 0.041 pins every d20 to a natural 20, so the fight plays out the same way every run. */
const NAT_20 = 0.041;

let db: Db;
let stopClicking: () => void;
const realRandom = Math.random;

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
  Math.random = () => NAT_20;
});

afterEach(() => {
  stopClicking();
  Math.random = realRandom;
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Calls a tool and keeps only its text, the one channel the DM is assumed to read. */
async function say(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = replyText(result);
  if (result.isError) throw new Error(text);
  return text;
}

/** A campaign with a lone Fighter, made through the core so only the combat calls go over MCP. */
function campaignWithBorg(): number {
  const campaignId = createCampaign(db, { name: 'Ids In Text', story_shape: 'sandbox' }).campaign_id;
  createCharacter(db, {
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
  return campaignId;
}

interface Named {
  id: number;
  name: string;
}

/** The battle render's legend, "#2 g = Goblin Warrior 1 (enemy, 10/10 HP, ...". */
const legendOf = (text: string): Array<Named & { team: string }> =>
  [...text.matchAll(/^#(\d+) \S = (.+?) \((party|enemy|neutral), /gm)].map((m) => ({
    id: Number(m[1]),
    name: m[2]!,
    team: m[3]!,
  }));

/** Who the text says is up, from "Borg #1 is up" in a battle render or a turn reply. */
function upOf(text: string): Named {
  const m = /(?:^Round \d+ - |, turn \d+ - )(.+) #(\d+) is up/m.exec(text);
  if (!m) throw new Error(`No "is up" line with an id in:\n${text}`);
  return { name: m[1]!, id: Number(m[2]) };
}

/** The foes the turn brief closes a reply with, "g Goblin Warrior 1 #2, 5 ft, no cover, ...". */
const briefFoes = (text: string): Array<Named & { ft: number }> =>
  [...text.split('\n').at(-1)!.matchAll(/(?:\): |; |nearest: )\S (.+?) #(\d+), (\d+) ft, /g)].map((m) => ({
    name: m[1]!,
    id: Number(m[2]),
    ft: Number(m[3]),
  }));

/** The ids of the effects a turn reply says it started, "... is affected by prone (...): effect #3.". */
const startedEffects = (text: string): number[] => [...text.matchAll(/ is affected by .+: effect #(\d+)\.$/gm)].map((m) => Number(m[1]));

/** A turn reply's touched-combatant lines, "g Goblin Warrior 1 #2: 10/10 HP, ...". */
const touchedLines = (text: string): string[] => text.split('\n').filter((line) => /^\S \S.*: (\d+\/\d+ HP|dead)/.test(line));

/** Every combatant a turn reply names on its "is up", touched and brief lines carries the id the legend gave it. */
function expectIdsOnTurn(text: string, legend: Named[]): void {
  const idOf = (name: string): number | undefined => legend.find((c) => c.name === name)?.id;
  const up = upOf(text);
  expect(idOf(up.name)).toBe(up.id);
  const touched = touchedLines(text);
  expect(touched.length).toBeGreaterThan(0);
  for (const line of touched) {
    const m = /^\S (.+) #(\d+): /.exec(line);
    expect(m, line).not.toBeNull();
    expect(idOf(m![1]!)).toBe(Number(m![2]));
  }
  for (const foe of briefFoes(text)) expect(idOf(foe.name)).toBe(foe.id);
}

describe('combat ids in the text', () => {
  it('lets a text-only DM start a fight, act, move, attack and end the effects a turn started', async () => {
    const campaignId = campaignWithBorg();
    const client = await connect();
    const started = await say(client, 'start_encounter', {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior', count: 2 }],
    });

    // The legend gives every combatant's id, and the header's "is up" id is one of them.
    const legend = legendOf(started);
    expect(legend.map((c) => c.name).sort()).toEqual(['Borg', 'Goblin Warrior 1', 'Goblin Warrior 2']);
    expect(new Set(legend.map((c) => c.id)).size).toBe(3);
    const borg = legend.find((c) => c.name === 'Borg')!;
    const goblinIds = new Set(legend.filter((c) => c.team === 'enemy').map((c) => c.id));
    const first = upOf(started);
    expect(legend.find((c) => c.id === first.id)?.name).toBe(first.name);

    // Round to a goblin's turn, acting for it with the id its "is up" line names.
    let up = first;
    for (let step = 0; step < 3 && !goblinIds.has(up.id); step += 1) {
      const turn = await say(client, 'advance_turn', { campaign_id: campaignId });
      expectIdsOnTurn(turn, legend);
      up = upOf(turn);
    }
    expect(goblinIds.has(up.id)).toBe(true);
    const thrown = await say(client, 'use_action', {
      campaign_id: campaignId,
      actor_id: up.id,
      action_name: 'Burning oil',
      target_id: borg.id,
      effect: { name: 'burning', kind: 'damage', damage_expr: '1d4', damage_type: 'fire', tick: 'start', ends: 'manual' },
    });
    expectIdsOnTurn(thrown, legend);
    const [burning] = startedEffects(thrown);
    expect(burning).toBeDefined();
    expect(await say(client, 'get_battle_state', { campaign_id: campaignId })).toContain(`#${burning} on Borg: burning`);
    await say(client, 'effect', { op: 'end', campaign_id: campaignId, effect_id: burning });
    expect(await say(client, 'get_battle_state', { campaign_id: campaignId })).not.toContain(`#${burning} on`);

    // Round to Borg, the id on each turn's "is up" line saying when.
    for (let step = 0; step < 3 && up.id !== borg.id; step += 1) {
      const turn = await say(client, 'advance_turn', { campaign_id: campaignId });
      expectIdsOnTurn(turn, legend);
      up = upOf(turn);
    }
    expect(up.id).toBe(borg.id);

    // find_position names the ids of the combatants it was asked about.
    const quarry = legend.find((c) => goblinIds.has(c.id))!;
    const cells = await say(client, 'find_position', { campaign_id: campaignId, combatant_id: borg.id, within_reach_of: quarry.id });
    expect(cells.split('\n')[0]).toMatch(
      new RegExp(`^Cells for Borg #${borg.id} within \\d+ ft, relative to ${quarry.name} #${quarry.id}:$`),
    );

    // Move and attack with the ids the text handed over, the target taken off the turn brief.
    const moved = await say(client, 'move_token', { campaign_id: campaignId, combatant_id: borg.id, toward: quarry.id });
    expectIdsOnTurn(moved, legend);
    const target = briefFoes(moved)[0]!;
    expect(goblinIds.has(target.id)).toBe(true);
    const shot = await say(client, 'attack', {
      campaign_id: campaignId,
      attacker_id: borg.id,
      target_id: target.id,
      action_name: 'Shortbow',
    });
    expect(shot).toContain(`Borg attacks ${target.name} with Shortbow`);
    expectIdsOnTurn(shot, legend);
    expect(touchedLines(shot).some((line) => line.includes(` ${target.name} #${target.id}: `))).toBe(true);

    // A timed condition is an effect: its id is in that turn's text, and effect {op: end} takes it. The other
    // goblin takes it, since the critical shot may have killed the first.
    const other = legend.find((c) => goblinIds.has(c.id) && c.id !== target.id)!;
    const pinned = await say(client, 'condition', {
      op: 'set',
      campaign_id: campaignId,
      combatant_id: other.id,
      condition: 'prone',
      active: true,
      duration_rounds: 2,
    });
    expectIdsOnTurn(pinned, legend);
    const [prone] = startedEffects(pinned);
    expect(pinned).toContain(`${other.name} is affected by prone (condition, 2 rounds): effect #${prone}.`);
    const legendLine = new RegExp(`^#${other.id} \\S = ${other.name} \\(.+ - prone`, 'm');
    const before = await say(client, 'get_battle_state', { campaign_id: campaignId });
    expect(before).toMatch(legendLine);
    expect(before).toContain(`#${prone} on ${other.name}: prone`);
    await say(client, 'effect', { op: 'end', campaign_id: campaignId, effect_id: prone });
    const after = await say(client, 'get_battle_state', { campaign_id: campaignId });
    expect(after).not.toContain(`#${prone} on`);
    expect(after).not.toMatch(legendLine);
    await client.close();
  });

  it(`keeps every turn reply of a crowded fight within ${TURN_REPLY} tokens with the ids in`, async () => {
    const campaignId = campaignWithBorg();
    const client = await connect();
    const started = await say(client, 'start_encounter', {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [
        { creature: 'Goblin Warrior', count: 4 },
        { creature: 'Wolf', count: 2 },
        { creature: 'Goblin Boss' },
      ],
    });
    const legend = legendOf(started);
    const borg = legend.find((c) => c.name === 'Borg')!;
    const enemies = legend.filter((c) => c.team === 'enemy');
    expect(enemies).toHaveLength(7);

    // Crowd every enemy onto the free cells nearest the PC; the grid rows and Borg's cell come off the render.
    const grid = started.split('\n').filter((line) => /^\s{1,3}\d+ [.~#A-Za-z]+$/.test(line)).map((line) => line.trim().split(' ')[1]!);
    const at = /^#\d+ \S = Borg \(party, .+, at (\d+),(\d+)\)/m.exec(started)!;
    const pc = { x: Number(at[1]), y: Number(at[2]) };
    const free: Array<{ x: number; y: number }> = [];
    grid.forEach((row, y) =>
      [...row].forEach((cell, x) => {
        if (cell !== '#' && !(x === pc.x && y === pc.y)) free.push({ x, y });
      }),
    );
    const gap = (cell: { x: number; y: number }): number => Math.max(Math.abs(cell.x - pc.x), Math.abs(cell.y - pc.y));
    free.sort((a, b) => gap(a) - gap(b));
    enemies.forEach((c, i) => db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(free[i]!.x, free[i]!.y, c.id));

    const sizes: number[] = [];
    const turnReply = (text: string): string => {
      sizes.push(estimateTokens(text));
      expectIdsOnTurn(text, legend);
      return text;
    };
    // Borg acts first so a monster's blow cannot drop him before his turn; then one monster swings and one throws.
    const acted = { pc: false, swing: false, throw: false };
    for (let step = 0; step < 2 * (1 + enemies.length) && !(acted.pc && acted.swing && acted.throw); step += 1) {
      const turn = turnReply(await say(client, 'advance_turn', { campaign_id: campaignId }));
      const up = upOf(turn);
      if (up.id === borg.id) {
        if (acted.pc) continue;
        acted.pc = true;
        const foes = briefFoes(turn);
        expect(turn.split('\n').at(-1)).toMatch(/; 2 more\.$/);
        const swing = turnReply(
          await say(client, 'attack', { campaign_id: campaignId, attacker_id: borg.id, target_id: foes[0]!.id, action_name: 'Greatsword' }),
        );
        expect(swing).toContain(`Borg attacks ${foes[0]!.name} with Greatsword`);
        const pinned = turnReply(
          await say(client, 'condition', {
            op: 'set',
            campaign_id: campaignId,
            combatant_id: foes[1]!.id,
            condition: 'prone',
            active: true,
            duration_rounds: 2,
          }),
        );
        expect(startedEffects(pinned)).toHaveLength(1);
      } else if (acted.pc && !acted.swing && briefFoes(turn).some((f) => f.id === borg.id && f.ft <= 5)) {
        acted.swing = true;
        const melee = /(?:^Attacks: |; )([^;]+?) [+-]\d+ to hit[^;]*reach/m.exec(turn)![1]!;
        const blow = turnReply(
          await say(client, 'attack', { campaign_id: campaignId, attacker_id: up.id, target_id: borg.id, action_name: melee }),
        );
        expect(blow).toContain(`${up.name} attacks Borg with ${melee}`);
      } else if (acted.swing && !acted.throw) {
        acted.throw = true;
        const thrown = turnReply(
          await say(client, 'use_action', {
            campaign_id: campaignId,
            actor_id: up.id,
            action_name: 'Burning oil',
            target_id: borg.id,
            effect: { name: 'burning', kind: 'damage', damage_expr: '1d4', damage_type: 'fire', tick: 'start', ends: 'manual' },
          }),
        );
        expect(startedEffects(thrown)).toHaveLength(1);
      }
    }
    expect(acted).toEqual({ pc: true, swing: true, throw: true });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(TURN_REPLY);
    await client.close();
  });
});
