// The AC or DC a fight-log roll was made against reaches the player's window only when dc_disclosure shows it:
// the combat event, the snapshot's log tail, the combat-log route and the roll history all follow the setting.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startEncounter } from '../src/combat/engine.js';
import { playerLogEntry } from '../src/combat/log-view.js';
import type { BattleMap } from '../src/combat/map.js';
import { combatLog, listCombatants, type BattleState, type CombatLogEntry } from '../src/combat/state.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign, rollAndRecord } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let base: string;
let wsUrl: string;
let stop: () => Promise<void>;
let events: GameEvent[];
let unsubscribe: () => void;
const realRandom = Math.random;

/** 0.041 pins every d20 to a natural 20, so the swing the player clicks always lands. */
const NAT_20 = 0.041;
const BLAST_DC = 12;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'logleakssecret0123456789abcdef01' });
  base = `http://${HOST}:${started.port}`;
  wsUrl = `ws://${HOST}:${started.port}/ws`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

beforeEach(() => {
  events = [];
  unsubscribe = bus.subscribe((event) => events.push(event));
  Math.random = () => NAT_20;
});

afterEach(() => {
  unsubscribe();
  Math.random = realRandom;
});

interface Played {
  campaignId: number;
  encounterId: number;
  ac: number;
  escapeDc: number;
  /** The DM's three MCP replies, their text joined: the only channel a reply has. */
  dm: string;
}

const replyOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content.map((part) => part.text).join('\n');

/** A fight on an open field where, through the DM's MCP tools, Borg swings, a goblin forces a save and Borg grapples it. */
async function play(disclosure: 'hidden' | 'shown'): Promise<Played> {
  const campaignId = createCampaign(db, { name: `Log ${disclosure}`, story_shape: 'sandbox' }).campaign_id;
  updateSettings(db, campaignId, { dc_disclosure: disclosure });
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
  const stopClicking = resolvePendingRollsImmediately(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  try {
    const encounterId = (
      await startEncounter(db, {
        campaign_id: campaignId,
        seed: 7,
        terrain: 'road',
        size: 'small',
        enemies: [{ creature: 'Goblin Warrior' }],
      })
    ).encounter_id;
    const map: BattleMap = { w: 20, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(20)), features: [] };
    db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), encounterId);
    const pc = listCombatants(db, encounterId).find((c) => c.kind === 'pc')!;
    const goblin = listCombatants(db, encounterId).find((c) => c.team === 'enemy')!;
    db.prepare('UPDATE combatant SET x = 5, y = 5, action_used = 0, reaction_used = 0 WHERE id = ?').run(pc.id);
    db.prepare('UPDATE combatant SET x = 6, y = 5, hp_max = 200, hp_current = 200, reaction_used = 0 WHERE id = ?').run(
      goblin.id,
    );
    const order = listCombatants(db, encounterId).findIndex((c) => c.id === pc.id);
    db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(order, encounterId);
    events = [];

    const swing = await client.callTool({
      name: 'attack',
      arguments: { campaign_id: campaignId, attacker_id: pc.id, target_id: goblin.id, action_name: 'Greatsword' },
    });
    const blast = await client.callTool({
      name: 'use_action',
      arguments: {
        campaign_id: campaignId,
        actor_id: goblin.id,
        action_name: 'Scorching Blast',
        target_id: pc.id,
        damage_expr: '2d6',
        damage_type: 'fire',
        save_ability: 'dex',
        save_dc: BLAST_DC,
        half_on_save: true,
        out_of_turn: true,
        reason: 'a reaction the fiction called for',
      },
    });
    db.prepare('UPDATE combatant SET action_used = 0 WHERE id = ?').run(pc.id);
    const grapple = await client.callTool({
      name: 'use_action',
      arguments: {
        campaign_id: campaignId,
        actor_id: pc.id,
        action_name: 'grapple',
        target_id: goblin.id,
        rolls: { [String(goblin.id)]: { total: 1, natural: 1 } },
      },
    });
    for (const reply of [swing, blast, grapple]) expect((reply as { isError?: boolean }).isError).toBeFalsy();

    const stored = combatLog(db, encounterId);
    const attackEntry = stored.find((e) => e.kind === 'attack')!;
    const grappleEntry = stored.find((e) => e.kind === 'grapple')!;
    return {
      campaignId,
      encounterId,
      ac: (attackEntry.payload as { effective_ac: number }).effective_ac,
      escapeDc: (grappleEntry.payload as { escape_dc: number }).escape_dc,
      dm: [swing, blast, grapple].map(replyOf).join('\n'),
    };
  } finally {
    stopClicking();
    await client.close();
  }
}

/** The fight log the bus pushed to the player's window with every combat event, its log and its state's tail. */
function pushedLog(campaignId: number): CombatLogEntry[] {
  return events
    .filter((e) => e.kind === 'combat' && e.campaign_id === campaignId)
    .flatMap((e) => {
      const payload = e.payload as { log: CombatLogEntry[]; state: BattleState };
      return [...payload.log, ...payload.state.log_tail];
    });
}

/** The battle state the window is sent when it subscribes over the socket. */
async function snapshotTail(campaignId: number): Promise<CombatLogEntry[]> {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve) => socket.once('open', resolve));
  const message = new Promise<{ type: string; data: { encounter: BattleState | null } }>((resolve) =>
    socket.once('message', (raw) => resolve(JSON.parse(String(raw)))),
  );
  socket.send(JSON.stringify({ type: 'subscribe', campaignId }));
  const snapshot = await message;
  socket.close();
  expect(snapshot.type).toBe('snapshot');
  return snapshot.data.encounter!.log_tail;
}

async function routeLog(campaignId: number): Promise<CombatLogEntry[]> {
  return (await (await fetch(`${base}/api/campaigns/${campaignId}/combat-log`)).json()) as CombatLogEntry[];
}

async function routeRolls(campaignId: number): Promise<Array<{ purpose: string; dc: number | null }>> {
  return (await (await fetch(`${base}/api/campaigns/${campaignId}/rolls`)).json()) as Array<{
    purpose: string;
    dc: number | null;
  }>;
}

const kinds = (entries: CombatLogEntry[]): string[] => [...new Set(entries.map((e) => e.kind))];

/** Any AC or DC a roll was made against, as a payload key or in a sentence. */
function expectNoTargets(entries: CombatLogEntry[]): void {
  const json = JSON.stringify(entries);
  expect(json).not.toMatch(/"(?:effective_ac|target_ac|dc|save_dc|escape_dc|next_dc)":/);
  expect(json).not.toMatch(/vs AC|vs DC|DC \d/);
}

function expectTargets(entries: CombatLogEntry[], played: Played): void {
  const payloadOf = (kind: string) => entries.find((e) => e.kind === kind)!.payload as Record<string, unknown>;
  expect(payloadOf('attack')).toMatchObject({ effective_ac: played.ac });
  expect(payloadOf('save')).toMatchObject({ save: { dc: BLAST_DC } });
  expect(payloadOf('grapple')).toMatchObject({ escape_dc: played.escapeDc, save: { dc: played.escapeDc } });
  const text = entries.map((e) => e.text).join('\n');
  expect(text).toContain(`vs AC ${played.ac}`);
  expect(text).toContain(`vs DC ${BLAST_DC}`);
  expect(text).toContain(`escapes with a DC ${played.escapeDc}`);
}

describe('the fight log under dc_disclosure', () => {
  it('keeps every AC and DC off the player surfaces while hidden, and in the DM replies and stored log', async () => {
    const played = await play('hidden');

    const pushed = pushedLog(played.campaignId);
    const tail = await snapshotTail(played.campaignId);
    const route = await routeLog(played.campaignId);
    for (const surface of [pushed, tail, route]) {
      expect(kinds(surface)).toEqual(expect.arrayContaining(['attack', 'save', 'grapple']));
      expectNoTargets(surface);
    }
    // The chips still have their rolls to show; only the number they were made against is gone.
    const attack = route.find((e) => e.kind === 'attack')!;
    expect(attack.payload).toMatchObject({ hit: true, roll: { total: expect.any(Number) } });
    expect(attack.text).toMatch(/: \d+ - critical hit\./);

    const rolls = await routeRolls(played.campaignId);
    expect(rolls.length).toBeGreaterThanOrEqual(2);
    expect(rolls.every((roll) => roll.dc === null)).toBe(true);
    expect(JSON.stringify(rolls)).not.toMatch(/vs AC|vs DC/);

    expect(played.dm).toContain(`vs AC ${played.ac}`);
    expect(played.dm).toContain(`vs DC ${BLAST_DC}`);
    expect(played.dm).toContain(`escapes with a DC ${played.escapeDc} STR (Athletics)`);
    expect(played.dm).toMatch(new RegExp(`with Greatsword: \\d+ vs AC ${played.ac}\\b`));
    expectTargets(combatLog(db, played.encounterId), played);

    // Read at request time, so turning the setting on shows the numbers of rolls already made.
    updateSettings(db, played.campaignId, { dc_disclosure: 'shown' });
    expect((await routeRolls(played.campaignId)).map((roll) => roll.dc)).toEqual(
      expect.arrayContaining([played.ac, BLAST_DC]),
    );
    expectTargets(await routeLog(played.campaignId), played);
  });

  it('shows the AC and DC on every player surface once the table turns it on', async () => {
    const played = await play('shown');

    expectTargets(pushedLog(played.campaignId), played);
    expectTargets(await snapshotTail(played.campaignId), played);
    expectTargets(await routeLog(played.campaignId), played);
    const rolls = await routeRolls(played.campaignId);
    expect(rolls.map((roll) => roll.dc)).toEqual(expect.arrayContaining([played.ac, BLAST_DC]));
    // The number rides in dc alone, so a card's purpose never repeats it.
    expect(rolls.map((roll) => roll.purpose)).toEqual(expect.arrayContaining(['Attack: Greatsword', 'Saving throw: DEX']));
    expect(played.dm).toContain(`vs AC ${played.ac}`);

    // Hiding them again takes the numbers back out of the history.
    updateSettings(db, played.campaignId, { dc_disclosure: 'hidden' });
    const hidden = await routeRolls(played.campaignId);
    expect(hidden.every((roll) => roll.dc === null)).toBe(true);
    expect(hidden.map((roll) => roll.purpose)).toEqual(
      expect.arrayContaining(['Attack: Greatsword', 'Saving throw: DEX']),
    );
    expect(JSON.stringify(hidden)).not.toMatch(/vs AC|vs DC|DC \d/);
  });
});

describe('a roll the engine records for the DM', () => {
  it('names the DC on the dice-log event only when the table shows it', () => {
    const campaignId = createCampaign(db, { name: 'Dice log', story_shape: 'sandbox' }).campaign_id;
    const record = () =>
      rollAndRecord(db, { expr: '1d20+3', purpose: 'Stealth check', dc: 12, roll_type: 'check', campaign_id: campaignId });
    const lastRollText = () => events.filter((e) => e.kind === 'roll' && e.campaign_id === campaignId).at(-1)!.text;

    const quiet = record();
    expect(lastRollText()).not.toMatch(/vs DC/);
    expect(lastRollText()).toMatch(/^Stealth check: .* -> success/);
    // The caller still gets the roll it asked for, the DC included.
    expect(quiet.dc).toBe(12);

    updateSettings(db, campaignId, { dc_disclosure: 'shown' });
    record();
    expect(lastRollText()).toContain('vs DC 12');
  });
});

describe('playerLogEntry', () => {
  const entry = (text: string, payload: unknown = null): CombatLogEntry => ({
    id: 1,
    round: 1,
    actor_id: null,
    target_id: null,
    kind: 'note',
    payload,
    text,
    ts: '2026-10-30T00:00:00.000Z',
  });

  it.each([
    [
      'Borg attacks Goblin Warrior with Greatsword: 17 vs AC 15 (half-cover cover) - hit.',
      'Borg attacks Goblin Warrior with Greatsword: 17 (half-cover cover) - hit.',
    ],
    [
      'Borg grapples Goblin Warrior (STR save 3 vs DC 13): speed 0 until it escapes with a DC 13 STR (Athletics) or DEX (Acrobatics) check.',
      'Borg grapples Goblin Warrior (STR save 3): speed 0 until it escapes with a STR (Athletics) or DEX (Acrobatics) check.',
    ],
    [
      'Borg refuses to fall (CON save 18 vs DC 10): Relentless Rage puts them back on 1 hit points. The next one is DC 15.',
      'Borg refuses to fall (CON save 18): Relentless Rage puts them back on 1 hit points.',
    ],
    ['Borg rolls 12 against Web (DC 13 DEX): it continues.', 'Borg rolls 12 against Web (DEX): it continues.'],
    ['Borg fails to hide: Stealth 9 against DC 15.', 'Borg fails to hide: Stealth 9.'],
    ['Goblin Warrior is affected by Web (condition, DC 13 DEX ends).', 'Goblin Warrior is affected by Web (condition, DEX ends).'],
    ['Escape the grapple: Athletics (DC 13)', 'Escape the grapple: Athletics'],
  ])('cuts the number out of "%s" while hidden', (text, expected) => {
    expect(playerLogEntry(entry(text), false).text).toBe(expected);
    expect(playerLogEntry(entry(text), true).text).toBe(text);
  });

  it('drops the AC and DC keys at any depth and scrubs the notes, leaving the rest', () => {
    const payload = {
      roll: { total: 17, natural: 12, dc: 15 },
      target_ac: 15,
      effective_ac: 15,
      hit: true,
      notes: ['Topple: CON save 4 vs DC 13'],
      save: { total: 3, dc: 13, ability: 'str', success: false },
      escape_dc: 13,
      next_dc: 15,
      effect: { name: 'Web', save_dc: 13, save_ability: 'dex' },
    };
    const original = JSON.stringify(payload);
    expect(playerLogEntry(entry('x', payload), false).payload).toEqual({
      roll: { total: 17, natural: 12 },
      hit: true,
      notes: ['Topple: CON save 4'],
      save: { total: 3, ability: 'str', success: false },
      effect: { name: 'Web', save_ability: 'dex' },
    });
    expect(JSON.stringify(payload)).toBe(original);
    expect(playerLogEntry(entry('x', payload), true).payload).toBe(payload);
  });
});
