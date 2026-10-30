// The player's window never shows tool-call syntax: a scripted fight and a few calls around it, through MCP,
// leave every text the bus, the snapshot and the player routes carry in plain words, and the DM's replies keep the calls.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { playerLogEntry } from '../src/combat/log-view.js';
import type { BattleMap } from '../src/combat/map.js';
import { activeEncounter, combatLog, listCombatants, type CombatLogEntry } from '../src/combat/state.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyText } from './helpers/reply.js';

let db: Db;
let base: string;
let wsUrl: string;
let stop: () => Promise<void>;
let events: GameEvent[];
let stops: Array<() => void>;
const realRandom = Math.random;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'playertextsecret0123456789abcdef' });
  base = `http://${HOST}:${started.port}`;
  wsUrl = `ws://${HOST}:${started.port}/ws`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

beforeEach(() => {
  events = [];
  stops = [resolvePendingRollsImmediately(db), bus.subscribe((event) => events.push(event))];
  // Every d20 lands on 11, so the scripted fight plays the same way each run.
  Math.random = () => 0.5;
});

afterEach(() => {
  for (const one of stops) one();
  Math.random = realRandom;
});

/** The keys whose strings the window prints: log and event lines, action labels and hints, roll purposes. */
const SHOWN = new Set(['text', 'hint', 'label', 'purpose']);

function shownStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) shownStrings(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (SHOWN.has(key) && typeof inner === 'string') out.push(inner);
      else shownStrings(inner, out);
    }
  }
  return out;
}

/** Call syntax in any form: `name {`, an op or id field, out_of_turn, or a snake_case tool name. */
function callPattern(tools: string[]): RegExp {
  const snake = tools.filter((name) => name.includes('_'));
  return new RegExp(`\\w+ \\{|\\bop:|_id:|out_of_turn|\\b(?:${tools.join('|')}) ?\\{|\\b(?:${snake.join('|')})\\b`);
}

async function snapshot(campaignId: number): Promise<unknown> {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve) => socket.once('open', resolve));
  const message = new Promise<unknown>((resolve) => socket.once('message', (raw) => resolve(JSON.parse(String(raw)))));
  socket.send(JSON.stringify({ type: 'subscribe', campaignId }));
  const answer = await message;
  socket.close();
  return answer;
}

const getJson = async (path: string): Promise<unknown> => (await fetch(`${base}${path}`)).json();

describe('player-visible text', () => {
  it('carries no tool-call syntax anywhere the window reads, while the DM replies keep the calls', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name, arguments: args });
      const text = replyText(result);
      expect(result.isError, `${name}: ${text}`).toBeFalsy();
      return text;
    };

    const created = await call('create_campaign', { name: 'Plain Words', story_shape: 'sandbox' });
    const campaign_id = (JSON.parse(created.split('\n\n')[0]!) as { campaign_id: number }).campaign_id;
    await call('create_character', {
      campaign_id,
      name: 'Bram',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    // A Longsword and no shield, so the attack hint names the versatile grip.
    db.prepare("UPDATE character SET inventory_json = ? WHERE name = 'Bram'").run(
      JSON.stringify([{ name: 'Longsword', qty: 1, equipped: true }]),
    );
    const wrenSheet = createCompanion(db, {
      campaign_id,
      name: 'Wren',
      source: { class: 'Wizard', species: 'Human', background: 'Sage' },
    }).companion!.id;
    db.prepare('UPDATE character SET spells_json = ?, spell_slots_json = ? WHERE id = ?').run(
      JSON.stringify({ cantrips: ['Fire Bolt'], known: ['Magic Missile'], prepared: ['Magic Missile'], save_dc: 13, attack_bonus: 5 }),
      JSON.stringify({ '1': { max: 2, used: 0 } }),
      wrenSheet,
    );

    await call('roll', { campaign_id, purpose: 'Perception check', skill: 'perception', roller: 'player', dc: 12 });
    await call('start_encounter', {
      campaign_id,
      seed: 3,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior', count: 2 }],
      extra_party: [wrenSheet],
    });
    const encounterId = activeEncounter(db, campaign_id)!.id;
    const map: BattleMap = { w: 20, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(20)), features: [] };
    db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), encounterId);
    const fighters = listCombatants(db, encounterId);
    const bram = fighters.find((c) => c.name === 'Bram')!;
    const wren = fighters.find((c) => c.name === 'Wren')!;
    const [first, second] = fighters.filter((c) => c.team === 'enemy');
    const place = db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?');
    place.run(5, 5, bram.id);
    place.run(2, 5, wren.id);
    place.run(6, 5, first!.id);
    place.run(6, 6, second!.id);
    const turnTo = (id: number): void => {
      const index = listCombatants(db, encounterId).findIndex((c) => c.id === id);
      db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounterId);
    };

    turnTo(bram.id);
    await call('condition', { op: 'set', campaign_id, combatant_id: bram.id, condition: 'prone', active: true });
    await call('use_action', { campaign_id, actor_id: bram.id, action_name: 'stand' });
    const readied = await call('use_action', {
      campaign_id,
      actor_id: bram.id,
      action_name: 'ready',
      trigger: 'the goblin raises its blade',
      readied_action: 'Longsword',
    });
    const midFight = await snapshot(campaign_id);
    await call('advance_turn', { campaign_id });
    await call('attack', {
      campaign_id,
      attacker_id: bram.id,
      target_id: first!.id,
      action_name: 'Longsword',
      out_of_turn: true,
      reason: 'the goblin raises its blade',
    });
    turnTo(wren.id);
    await call('use_action', { campaign_id, actor_id: wren.id, action_name: 'Fire Bolt', spell: 'Fire Bolt', target_id: second!.id });
    await call('effect', {
      op: 'apply',
      campaign_id,
      target_id: second!.id,
      name: 'on fire',
      kind: 'damage',
      damage_expr: '1d4',
      damage_type: 'fire',
      tick: 'start',
      ends: 'rounds',
      remaining_rounds: 2,
    });
    await call('advance_turn', { campaign_id });
    const routeLog = (await getJson(`/api/campaigns/${campaign_id}/combat-log?encounter=${encounterId}`)) as CombatLogEntry[];
    await call('end_encounter', { campaign_id, outcome: 'victory' });
    await call('rest', { campaign_id, kind: 'short' });
    await client.close();

    const surfaces = [...events, midFight, await snapshot(campaign_id), routeLog, await getJson(`/api/campaigns/${campaign_id}/rolls`)];
    const shown = [...new Set(shownStrings(surfaces))];
    // The scan reached the texts that used to carry calls: the action hints, the Ready line and the readied action.
    expect(shown.some((text) => text.includes('Versatile: swung two-handed'))).toBe(true);
    expect(shown.some((text) => text.startsWith('Cantrip'))).toBe(true);
    expect(shown.some((text) => text.startsWith('Triggers on "the goblin raises its blade"'))).toBe(true);
    expect(shown.some((text) => text.startsWith('Bram readies Longsword'))).toBe(true);
    const pattern = callPattern(tools);
    expect(shown.filter((text) => pattern.test(text))).toEqual([]);

    // The DM's reply still names the release call, with the id it needs.
    expect(readied).toContain(`attack {attacker_id: ${bram.id}, target_id, action_name, out_of_turn: true, reason}`);
    // The stored line keeps the call as its DM-only note, and the player's copy of the log never carries it.
    const stored = combatLog(db, encounterId).find((entry) => entry.text.startsWith('Bram readies'))!;
    expect((stored.payload as { dm_note?: string }).dm_note).toMatch(/^Release it with attack \{/);
    expect(routeLog.find((entry) => entry.id === stored.id)!.payload).not.toHaveProperty('dm_note');
  });

  it('strips the dm_note from a log entry for the player whether DCs are shown or not', () => {
    const entry: CombatLogEntry = {
      id: 1,
      round: 1,
      actor_id: 1,
      target_id: null,
      kind: 'action',
      payload: { action: 'ready', dm_note: 'Release it with attack {attacker_id: 1}.' },
      text: 'Bram readies Longsword.',
      ts: '',
    };
    for (const dcShown of [true, false]) {
      const shown = playerLogEntry(entry, dcShown);
      expect(shown.payload).toEqual({ action: 'ready' });
      expect(shown.text).toBe('Bram readies Longsword.');
    }
  });
});
