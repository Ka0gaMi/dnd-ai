// The DM-only cues: one short line set beside the result it concerns, only when it applies, and never on a
// player surface (the bus, the snapshot, the rolls route, the combat-log route).
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { updateSettings } from '../src/core/settings.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { CUE } from '../src/mcp/cues.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';
import { replyData, replyText } from './helpers/reply.js';

/** Math.random values that pin every d20 to a natural 20, a natural 1, or a plain middling face. */
const NAT_20 = 0.041;
const NAT_1 = 0;
const MIDDLING = 0.5;

const ALL_CUES = [CUE.hiddenDc, CUE.showSuccess, CUE.narrateAttack, CUE.playerTurn, CUE.dying('Borg')];

let db: Db;
let base: string;
let stop: () => Promise<void>;
let events: GameEvent[];
let unsubscribe: () => void;
let client: Client;
let campaignId: number;
let borgId: number;
const realRandom = Math.random;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'dmcuessecret0123456789abcdef0123' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

beforeEach(async () => {
  events = [];
  unsubscribe = bus.subscribe((event) => events.push(event));
  campaignId = createCampaign(db, { name: 'Cues', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  borgId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  unsubscribe();
  Math.random = realRandom;
  await client.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: { campaign_id: campaignId, ...args } });
  expect((result as { isError?: boolean }).isError, replyText(result)).toBeFalsy();
  return replyText(result);
}

const roll = (args: Record<string, unknown>): Promise<string> => call('roll', { purpose: 'A check', ...args });

describe('roll cues', () => {
  it('give a won check against a hidden DC the hidden-DC and show-it cues, after its data', async () => {
    Math.random = () => NAT_20;
    const text = await roll({ skill: 'perception', dc: 12 });
    expect(text).toContain(`\n\n${CUE.hiddenDc}\n${CUE.showSuccess}`);
    expect(replyData({ content: [{ type: 'text', text }] })).toMatchObject({ outcome: 'success' });
  });

  it('give a lost check only the hidden-DC cue', async () => {
    Math.random = () => NAT_1;
    const text = await roll({ skill: 'perception', dc: 12 });
    expect(text).toContain(CUE.hiddenDc);
    expect(text).not.toContain(CUE.showSuccess);
  });

  it('drop the hidden-DC cue while the table shows DCs', async () => {
    updateSettings(db, campaignId, { dc_disclosure: 'shown' });
    Math.random = () => NAT_20;
    const text = await roll({ skill: 'perception', dc: 12 });
    expect(text).not.toContain(CUE.hiddenDc);
    expect(text).toContain(CUE.showSuccess);
  });

  it('keep the show-it cue to checks, and give a roll with no DC nothing', async () => {
    Math.random = () => NAT_20;
    for (const text of [await roll({ save: 'dex', dc: 12 }), await roll({ expr: '1d20+5', roll_type: 'attack', dc: 12 })]) {
      expect(text).toContain(CUE.hiddenDc);
      expect(text).not.toContain(CUE.showSuccess);
    }
    const free = await roll({ skill: 'perception' });
    const damage = await roll({ expr: '1d6', roll_type: 'damage' });
    for (const text of [free, damage]) {
      for (const cue of ALL_CUES) expect(text).not.toContain(cue);
    }
  });

  it('give passive and group checks the same cues', async () => {
    const passive = await roll({ passive: true, skill: 'perception', dc: 5 });
    expect(passive).toContain(`${CUE.hiddenDc}\n${CUE.showSuccess}`);

    Math.random = () => NAT_20;
    const elowen = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Elowen',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    }).companion!.id;
    // roller dm, so Borg's own die is not left waiting for a click.
    const group = await roll({ group: [borgId, elowen], skill: 'perception', dc: 5, roller: 'dm' });
    expect(group).toContain(`${CUE.hiddenDc}\n${CUE.showSuccess}`);
  });
});

/** Borg and a goblin side by side on an open field, the goblin too tough to drop, and the turn Borg's. */
async function fight(): Promise<{ pc: number; goblin: number; encounterId: number }> {
  const encounterId = (
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    })
  ).encounter_id;
  const map = { w: 20, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(20)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), encounterId);
  const pc = listCombatants(db, encounterId).find((c) => c.kind === 'pc')!.id;
  const goblin = listCombatants(db, encounterId).find((c) => c.team === 'enemy')!.id;
  db.prepare('UPDATE combatant SET x = 5, y = 5 WHERE id = ?').run(pc);
  db.prepare('UPDATE combatant SET x = 6, y = 5, hp_max = 200, hp_current = 200 WHERE id = ?').run(goblin);
  giveTurn(pc);
  return { pc, goblin, encounterId };
}

/** The turn is this combatant's, with the action economy full. */
function giveTurn(id: number): void {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0 WHERE id = ?').run(id);
}

/** Borg at 0 HP and unconscious, rolling death saves unless stable. */
function downBorg(pc: number, stable: boolean): void {
  db.prepare(
    'UPDATE character SET hp_current = 0, stable = ?, death_saves_json = ?, conditions_json = ? WHERE id = ?',
  ).run(stable ? 1 : 0, JSON.stringify({ successes: 0, failures: 0 }), JSON.stringify(['unconscious']), borgId);
  db.prepare('UPDATE combatant SET hp_current = 0, conditions_json = ? WHERE id = ?').run(
    JSON.stringify(['unconscious']),
    pc,
  );
}

describe('combat cues', () => {
  it('set the narrate and hidden-DC cues right under a party attack log line', async () => {
    Math.random = () => NAT_20;
    const { pc, goblin } = await fight();
    const text = await call('attack', { attacker_id: pc, target_id: goblin, action_name: 'Greatsword' });
    const lines = text.split('\n');
    const swing = lines.findIndex((line) => /vs AC \d+/.test(line));
    const cue = lines.indexOf(CUE.narrateAttack);
    expect(cue).toBeGreaterThan(swing);
    expect(lines.slice(swing + 1, cue).every((line) => !line.startsWith('Round '))).toBe(true);
    expect(lines[cue + 1]).toBe(CUE.hiddenDc);
  });

  it('drop the hidden-DC cue while the table shows the AC', async () => {
    updateSettings(db, campaignId, { dc_disclosure: 'shown' });
    Math.random = () => NAT_20;
    const { pc, goblin } = await fight();
    const text = await call('attack', { attacker_id: pc, target_id: goblin, action_name: 'Greatsword' });
    expect(text).toContain(CUE.narrateAttack);
    expect(text).not.toContain(CUE.hiddenDc);
  });

  it('give a monster attack on the player character neither cue', async () => {
    Math.random = () => MIDDLING;
    const { pc, goblin } = await fight();
    giveTurn(goblin);
    const text = await call('attack', { attacker_id: goblin, target_id: pc, action_name: 'Scimitar' });
    expect(text).toMatch(/vs AC \d+/);
    for (const cue of ALL_CUES) expect(text).not.toContain(cue);
  });

  it("lead advance_turn with the player-turn cue on the player character's turn only", async () => {
    Math.random = () => MIDDLING;
    const { goblin } = await fight();
    giveTurn(goblin);
    const mine = await call('advance_turn', {});
    expect(mine.startsWith(`${CUE.playerTurn}\n`)).toBe(true);
    const theirs = await call('advance_turn', {});
    expect(theirs.startsWith('Act for ')).toBe(true);
    expect(theirs).not.toContain(CUE.playerTurn);
  });

  it("tell the DM to stop at a dying player character's death save, and not once they are stable", async () => {
    Math.random = () => MIDDLING;
    const { pc, goblin } = await fight();
    downBorg(pc, false);
    giveTurn(goblin);
    const save = await call('advance_turn', {});
    expect(save).toMatch(/death save/);
    expect(save).toContain(CUE.dying('Borg'));
    expect(save).not.toContain(CUE.playerTurn);
    // The goblin's turn that follows is not the dying state's moment.
    const next = await call('advance_turn', {});
    expect(next).not.toContain(CUE.dying('Borg'));

    downBorg(pc, true);
    giveTurn(goblin);
    const stable = await call('advance_turn', {});
    expect(stable).not.toMatch(/death save:/);
    for (const cue of ALL_CUES) expect(stable).not.toContain(cue);
  });
});

describe('the cues', () => {
  it('are each one short line', () => {
    for (const cue of ALL_CUES) {
      expect(cue).not.toContain('\n');
      expect(estimateTokens(cue)).toBeLessThanOrEqual(20);
    }
  });

  it('never reach the bus, the snapshot, the rolls route or the combat-log route', async () => {
    Math.random = () => NAT_20;
    const { pc, goblin } = await fight();
    const dm = [
      await roll({ skill: 'perception', dc: 12 }),
      await call('attack', { attacker_id: pc, target_id: goblin, action_name: 'Greatsword' }),
    ];
    Math.random = () => MIDDLING;
    giveTurn(goblin);
    dm.push(await call('advance_turn', {}));
    downBorg(pc, false);
    giveTurn(goblin);
    dm.push(await call('advance_turn', {}));
    const said = dm.join('\n');
    for (const cue of ALL_CUES) expect(said).toContain(cue);

    const surfaces = {
      bus: JSON.stringify(events),
      snapshot: JSON.stringify(campaignSnapshot(db, campaignId, { forPlayer: true })),
      rolls: await (await fetch(`${base}/api/campaigns/${campaignId}/rolls`)).text(),
      combatLog: await (await fetch(`${base}/api/campaigns/${campaignId}/combat-log`)).text(),
    };
    for (const [surface, json] of Object.entries(surfaces)) {
      for (const cue of ALL_CUES) expect(json, `${surface}: ${cue}`).not.toContain(cue);
    }
    expect(JSON.parse(surfaces.combatLog)).not.toHaveLength(0);
    expect(JSON.parse(surfaces.rolls)).not.toHaveLength(0);
  });
});
