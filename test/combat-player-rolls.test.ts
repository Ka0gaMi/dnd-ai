import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attack, startEncounter, useAction } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import { createCampaign } from '../src/core/campaign.js';
import { applyDamage, createCharacter, createCompanion, grantFeature } from '../src/core/character.js';
import { clausesSchema } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { openPendingRolls, resolvePendingRoll, type PendingRollRow } from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

/** 0.041 pins every d20 to a natural 20, so an attack that is asked for always lands. */
const NAT_20 = 0.041;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Player Rolls', story_shape: 'sandbox' }).campaign_id;
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
  Math.random = () => NAT_20;
});

afterEach(() => {
  Math.random = realRandom;
});

interface Fight {
  encounterId: number;
  pc: number;
  goblin: number;
  /** The last card asked for while the fight was opening, so a test can count only its own. */
  lastAsk: number;
}

/** Opens a fight with the PC next to one goblin, clicking the initiative asks on the player's behalf. */
async function fight(): Promise<Fight> {
  const stopClicking = resolvePendingRollsImmediately(db);
  const started = await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  stopClicking();
  const combatants = listCombatants(db, started.encounter_id);
  const pc = combatants.find((c) => c.kind === 'pc')!;
  const goblin = combatants.find((c) => c.team === 'enemy')!;
  db.prepare('UPDATE combatant SET x = 1, y = 5 WHERE id = ?').run(pc.id);
  db.prepare('UPDATE combatant SET x = 2, y = 5 WHERE id = ?').run(goblin.id);
  const order = listCombatants(db, started.encounter_id).findIndex((c) => c.id === pc.id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(order, started.encounter_id);
  const lastAsk = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM pending_roll').get() as { id: number }).id;
  return { encounterId: started.encounter_id, pc: pc.id, goblin: goblin.id, lastAsk };
}

/** The cards asked for since the fight opened, in order. */
const asksSince = (lastAsk: number): PendingRollRow[] =>
  db.prepare('SELECT * FROM pending_roll WHERE campaign_id = ? AND id > ? ORDER BY id').all(campaignId, lastAsk) as PendingRollRow[];

/** The card the engine is waiting on right now; the chain moves on a microtask, so give it a moment. */
async function nextAsk(): Promise<PendingRollRow> {
  for (let tries = 0; tries < 100; tries += 1) {
    const open = openPendingRolls(db, campaignId);
    if (open.length > 0) return open[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The engine never asked the player to roll.');
}

const context = (row: PendingRollRow): Record<string, unknown> =>
  JSON.parse(row.context_json!) as Record<string, unknown>;

/** Puts a homebrew extra_damage rider on the character, so a landed swing carries dice the player owns. */
function grantForcefulFocus(characterId: number): void {
  const entry = saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'feature',
    name: 'Forceful Focus',
    schema: {
      name: 'Forceful Focus',
      text: 'Forceful Focus',
      clauses: clausesSchema.parse([
        { when: 'hit', do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }] },
      ]),
    },
  });
  grantFeature(db, {
    campaign_id: campaignId,
    character_id: characterId,
    name: 'Forceful Focus',
    source: 'homebrew',
    text: 'Forceful Focus',
    mechanics: { homebrew_id: entry.id },
  });
}

/** The combatant id of the player character in a fight. */
const characterIdOf = (encounterId: number, combatantId: number): number =>
  listCombatants(db, encounterId).find((c) => c.id === combatantId)!.character_id!;

/** A weapon hit's homebrew rider effects, as the reply lists them. */
const riderEffects = (result: unknown): Array<{ feature: string; damage?: number }> =>
  (result as { features?: Array<{ feature: string; damage?: number }> }).features ?? [];

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('the player rolls their own dice in combat', () => {
  it('asks for the attack, then for the damage, and applies what the player rolled', async () => {
    const { encounterId, pc, goblin } = await fight();

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });

    const d20 = await nextAsk();
    expect(d20.purpose).toMatch(/^Attack: Greatsword vs AC \d+$/);
    expect(d20.roll_type).toBe('attack');
    expect(context(d20)).toEqual({
      encounter_id: encounterId,
      tool: 'attack',
      step: 'attack',
      actor_id: pc,
      target_id: goblin,
    });
    resolvePendingRoll(db, d20.id);

    const damage = await nextAsk();
    expect(damage.purpose).toBe('Damage: 4d6+3 (slashing)');
    expect(damage.roll_type).toBe('damage');
    expect(context(damage)).toEqual({
      encounter_id: encounterId,
      tool: 'attack',
      step: 'damage',
      actor_id: pc,
      target_id: goblin,
    });
    const rolled = resolvePendingRoll(db, damage.id);

    const result = await running;
    expect(result.critical).toBe(true);
    expect(result.total_damage).toBe(rolled.total);
    expect(result.damage[0]!.applied).toBe(rolled.total);
    expect(openPendingRolls(db, campaignId)).toHaveLength(0);
  });

  it('asks the player for an extra-damage rider and lands it from their number', async () => {
    const { encounterId, pc, goblin, lastAsk } = await fight();
    grantForcefulFocus(characterIdOf(encounterId, pc));
    db.prepare('UPDATE combatant SET hp_max = 100, hp_current = 100 WHERE id = ?').run(goblin);

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });

    const d20 = await nextAsk();
    resolvePendingRoll(db, d20.id);

    const weapon = await nextAsk();
    expect(weapon.roll_type).toBe('damage');
    const weaponRolled = resolvePendingRoll(db, weapon.id);

    const rider = await nextAsk();
    expect(rider.roll_type).toBe('damage');
    expect(rider.expr).toBe('2d6'); // the natural 20 doubles the rider's 1d6
    expect(rider.purpose).toBe('Damage: 2d6 (force)');
    const riderRolled = resolvePendingRoll(db, rider.id);

    const result = (await running) as unknown as { damage: Array<{ applied: number }> };
    expect(result.damage[0]!.applied).toBe(weaponRolled.total);
    expect(riderEffects(result).find((f) => f.feature === 'Forceful Focus')?.damage).toBe(riderRolled.total);
    expect(asksSince(lastAsk)).toHaveLength(3);
  });

  it('rolls the rider itself when the table did not ask the player for damage', async () => {
    updateSettings(db, campaignId, { roll_mode: 'auto' });
    const { encounterId, pc, goblin, lastAsk } = await fight();
    grantForcefulFocus(characterIdOf(encounterId, pc));
    db.prepare('UPDATE combatant SET hp_max = 100, hp_current = 100 WHERE id = ?').run(goblin);

    const result = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });

    expect(asksSince(lastAsk)).toHaveLength(0);
    expect(riderEffects(result).find((f) => f.feature === 'Forceful Focus')?.damage).toBeGreaterThan(0);
  });

  it('asks only for the d20 when the player keeps the damage dice off their hands', async () => {
    updateSettings(db, campaignId, { player_rolls: 'd20_only' });
    const fought = await fight();
    const { pc, goblin } = fought;

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });
    const d20 = await nextAsk();
    expect(context(d20)).toMatchObject({ step: 'attack' });
    resolvePendingRoll(db, d20.id);

    const result = await running;
    expect(result.hit).toBe(true);
    expect(result.total_damage).toBeGreaterThan(0);
    expect(asksSince(fought.lastAsk)).toHaveLength(1);
  });

  it('asks for nothing at all when the player is not the one rolling', async () => {
    updateSettings(db, campaignId, { player_rolls: 'none' });
    const { pc, goblin, lastAsk } = await fight();
    await attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: goblin, action_name: 'Greatsword' });
    expect(asksSince(lastAsk)).toHaveLength(0);
  });

  it('never asks for a companion or a monster attack', async () => {
    createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    });
    const { encounterId, pc, goblin, lastAsk } = await fight();
    const companion = listCombatants(db, encounterId).find((c) => c.kind === 'companion')!;
    db.prepare('UPDATE combatant SET x = 1, y = 6 WHERE id = ?').run(companion.id);

    await attack(db, {
      campaign_id: campaignId,
      attacker_id: companion.id,
      target_id: goblin,
      action_name: 'Unarmed Strike',
      out_of_turn: true,
      reason: 'a reaction the fiction called for',
    });
    await attack(db, {
      campaign_id: campaignId,
      attacker_id: goblin,
      target_id: pc,
      action_name: 'Scimitar',
      out_of_turn: true,
      reason: 'a reaction the fiction called for',
    });
    expect(asksSince(lastAsk)).toHaveLength(0);
  });

  it('rolls the step itself when the player runs out of time and carries the chain on', async () => {
    updateSettings(db, campaignId, { roll_timeout_s: 1 });
    const { pc, goblin, lastAsk } = await fight();

    const result = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });
    expect(result.hit).toBe(true);
    expect(result.total_damage).toBeGreaterThan(0);
    expect(asksSince(lastAsk).map((row) => row.source)).toEqual(['auto', 'auto']);
  });

  it('takes a cheat-mode override into the attack and tells the DM the final numbers only', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    const { pc, goblin } = await fight();

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });
    const d20 = await nextAsk();
    resolvePendingRoll(db, d20.id, { dice: [1] });
    const result = await running;

    expect(result.roll.natural).toBe(1);
    expect(result.hit).toBe(false);
    expect(result.critical).toBe(false);
    expect(JSON.stringify(result)).not.toContain('overridden');
    expect(JSON.stringify(result)).not.toContain('original');
  });

  it('asks the player for a saving throw an action forces on them', async () => {
    const { encounterId, pc, goblin } = await fight();

    const running = useAction(db, {
      campaign_id: campaignId,
      actor_id: goblin,
      action_name: 'Scorching Blast',
      target_id: pc,
      damage_expr: '2d6',
      damage_type: 'fire',
      save_ability: 'dex',
      save_dc: 13,
      half_on_save: true,
      out_of_turn: true,
      reason: 'a reaction the fiction called for',
    });
    const save = await nextAsk();
    expect(save.purpose).toBe('Saving throw: DEX vs DC 13');
    expect(context(save)).toEqual({
      encounter_id: encounterId,
      tool: 'use_action',
      step: 'save',
      actor_id: pc,
    });
    resolvePendingRoll(db, save.id);

    const result = await running;
    const target = result.targets[0] as { save: { total: number; success: boolean } };
    expect(target.save.success).toBe(true);
  });

  it('asks the player for an ability check as a check, not as a save', async () => {
    const { encounterId, pc, goblin } = await fight();

    // The goblin takes hold of the player character, which asks them for a save first.
    const grabbing = useAction(db, {
      campaign_id: campaignId,
      actor_id: goblin,
      action_name: 'grapple',
      target_id: pc,
      out_of_turn: true,
      reason: 'a reaction the fiction called for',
    });
    const save = await nextAsk();
    expect(context(save)).toMatchObject({ step: 'save' });
    Math.random = () => 0; // a natural 1, so the hold takes
    resolvePendingRoll(db, save.id);
    await grabbing;
    Math.random = () => NAT_20;

    const escaping = useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'escape_grapple' });
    const check = await nextAsk();
    expect(check.purpose).toMatch(/^Escape .+ grapple: (athletics|acrobatics) \(DC \d+\)$/);
    expect(check.roll_type).toBe('check');
    expect(context(check)).toEqual({
      encounter_id: encounterId,
      tool: 'use_action',
      step: 'check',
      actor_id: pc,
    });
    resolvePendingRoll(db, check.id);

    const escaped = (await escaping) as unknown as { escaped: boolean };
    expect(escaped.escaped).toBe(true);
  });

  it('asks the player for their initiative when the fight starts', async () => {
    const running = startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    const ask = await nextAsk();
    expect(ask.purpose).toBe('Initiative');
    expect(context(ask)).toMatchObject({ tool: 'start_encounter', step: 'initiative' });
    resolvePendingRoll(db, ask.id);

    const started = await running;
    const pc = listCombatants(db, started.encounter_id).find((c) => c.kind === 'pc')!;
    expect(context(ask).actor_id).toBe(pc.id);
    expect(getBattleState(db, campaignId)!.combatants).toHaveLength(2);
  });

  it('asks the player for a death save made outside a fight', async () => {
    const hpMax = (db.prepare('SELECT hp_max FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
      hp_max: number;
    }).hp_max;
    applyDamage(db, { campaign_id: campaignId, amount: hpMax, source: 'a rockfall' });
    const client = await connect();
    const running = client.callTool({ name: 'death_save', arguments: { campaign_id: campaignId } });

    const ask = await nextAsk();
    expect(ask.purpose).toBe('Death saving throw');
    expect(context(ask)).toMatchObject({ encounter_id: null, tool: 'death_save', step: 'death_save' });
    const rolled = resolvePendingRoll(db, ask.id);

    const answer = (await running) as unknown as { structuredContent: { roll: number; result: string } };
    expect(answer.structuredContent.roll).toBe(rolled.total);
    expect(answer.structuredContent.result).toBe('critical_success');
    await client.close();
  });

  it('doubles the dice it asks the player to roll for a spell attack that crits', async () => {
    campaignId = createCampaign(db, { name: 'Caster', story_shape: 'sandbox' }).campaign_id;
    createCharacter(db, {
      campaign_id: campaignId,
      name: 'Zel',
      species: 'Human',
      class: 'Wizard',
      background: 'Sage',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 10, con: 14, int: 15, wis: 12, cha: 13 },
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'history', 'investigation'],
      cantrips: ['Fire Bolt', 'Mage Hand', 'Prestidigitation'],
      spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Detect Magic'],
    });
    const { pc, goblin } = await fight();

    const running = useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: goblin,
    });

    const attackAsk = await nextAsk();
    expect(attackAsk.purpose).toMatch(/^Spell attack: Fire Bolt vs AC \d+$/);
    resolvePendingRoll(db, attackAsk.id);

    const damageAsk = await nextAsk();
    expect(damageAsk.expr).toBe('2d10');
    expect(damageAsk.purpose).toMatch(/^Damage: 2d10/);
    resolvePendingRoll(db, damageAsk.id);

    const result = await running;
    const first = result.targets[0] as { attack: { critical: boolean } | null };
    expect(first.attack!.critical).toBe(true);
  });
});
