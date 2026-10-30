// The combat engine's leaks to the player's window: the target number on a roll card follows the
// table's dc_disclosure, monster hit points stay out of the shared log, and only the DM sees true names.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attack, endEncounter, moveToken, startEncounter, undoLastCombatAction, useAction } from '../src/combat/engine.js';
import type { BattleMap } from '../src/combat/map.js';
import { combatLog, getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign } from '../src/core/campaign.js';
import { addItem, createCharacter, grantFeature } from '../src/core/character.js';
import { clausesSchema } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import {
  getPendingRoll,
  openPendingRolls,
  resolvePendingRoll,
  rollForTool,
  type PendingRollRow,
} from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
let events: GameEvent[];
let unsubscribe: () => void;
const realRandom = Math.random;

/** 0.041 pins every d20 to a natural 20, so an attack that is asked for always lands. */
const NAT_20 = 0.041;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Leaks', story_shape: 'sandbox' }).campaign_id;
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
  events = [];
  unsubscribe = bus.subscribe((event) => events.push(event));
  Math.random = () => NAT_20;
});

afterEach(() => {
  unsubscribe();
  Math.random = realRandom;
});

interface Fight {
  encounterId: number;
  pc: number;
  goblin: number;
}

/** Opens a fight on an open field, the PC at (5,5) beside one goblin at (6,5), on the PC's turn. */
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
  const map: BattleMap = { w: 20, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(20)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), started.encounter_id);
  const combatants = listCombatants(db, started.encounter_id);
  const pc = combatants.find((c) => c.kind === 'pc')!;
  const goblin = combatants.find((c) => c.team === 'enemy')!;
  db.prepare('UPDATE combatant SET x = 5, y = 5, action_used = 0, reaction_used = 0 WHERE id = ?').run(pc.id);
  db.prepare('UPDATE combatant SET x = 6, y = 5, hp_max = 200, hp_current = 200, reaction_used = 0 WHERE id = ?').run(
    goblin.id,
  );
  const order = listCombatants(db, started.encounter_id).findIndex((c) => c.id === pc.id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(order, started.encounter_id);
  events = [];
  return { encounterId: started.encounter_id, pc: pc.id, goblin: goblin.id };
}

/** The card the engine is waiting on right now; the chain moves on a microtask, so give it a moment. */
async function nextAsk(): Promise<PendingRollRow> {
  for (let tries = 0; tries < 100; tries += 1) {
    const open = openPendingRolls(db, campaignId);
    if (open.length > 0) return open[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The engine never asked the player to roll.');
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const replyText = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content.map((part) => part.text).join('\n');

const pushedCards = (): Array<GameEvent & { payload: PendingRollRow }> =>
  events.filter((e) => e.kind === 'pending_roll') as Array<GameEvent & { payload: PendingRollRow }>;

const combatEvents = (): Array<GameEvent & { payload: { log: Array<{ kind: string; text: string }>; state: BattleState } }> =>
  events.filter((e) => e.kind === 'combat') as Array<
    GameEvent & { payload: { log: Array<{ kind: string; text: string }>; state: BattleState } }
  >;

/** Everything the player's window was sent by the bus and can fetch of the fight log, as one string. */
const playerSurfaces = (encounterId: number): string => JSON.stringify({ events, log: combatLog(db, encounterId) });

/** The DM swings the Greatsword through the MCP tool and the player clicks both cards. */
async function swingAsDm(f: Fight): Promise<{ reply: string; attackCard: PendingRollRow; clicked: number | null }> {
  const client = await connect();
  const running = client.callTool({
    name: 'attack',
    arguments: { campaign_id: campaignId, attacker_id: f.pc, target_id: f.goblin, action_name: 'Greatsword' },
  });
  const attackCard = await nextAsk();
  const clicked = resolvePendingRoll(db, attackCard.id).dc;
  resolvePendingRoll(db, (await nextAsk()).id);
  const reply = replyText(await running);
  await client.close();
  return { reply, attackCard, clicked };
}

describe('dc_disclosure on the roll card', () => {
  it('keeps the AC off the player card and payload while hidden, and in the DM reply', async () => {
    const f = await fight();
    const ac = getBattleState(db, campaignId)!.combatants.find((c) => c.id === f.goblin)!.ac;

    const { reply, attackCard, clicked } = await swingAsDm(f);

    // What the window fetched and was pushed: no AC in the purpose, no dc in the payload.
    expect(attackCard.purpose).toBe('Attack: Greatsword');
    expect(attackCard.dc).toBeNull();
    const card = pushedCards()[0]!;
    expect(card.payload.purpose).toBe('Attack: Greatsword');
    expect(card.payload.dc).toBeNull();
    expect(card.text).toBe('Attack: Greatsword');
    // The Roll button's own answer and the dice-log event carry no DC either.
    expect(clicked).toBeNull();
    const rolled = events.filter((e) => e.kind === 'roll').map((e) => e.text);
    expect(rolled.length).toBeGreaterThan(0);
    expect(rolled.join('\n')).not.toMatch(/vs DC/);

    // The DM's reply still names the AC, and the stored card keeps it for the engine.
    expect(reply).toContain(`vs AC ${ac}`);
    expect(getPendingRoll(db, attackCard.id)!.dc).toBe(ac);
  });

  it('shows the AC on the card and in the payload once the table turns it on', async () => {
    updateSettings(db, campaignId, { dc_disclosure: 'shown' });
    const f = await fight();
    const ac = getBattleState(db, campaignId)!.combatants.find((c) => c.id === f.goblin)!.ac;

    const { reply, attackCard, clicked } = await swingAsDm(f);

    // The number rides in dc alone, so the card and its pushed text name it once.
    expect(attackCard.purpose).toBe('Attack: Greatsword');
    expect(attackCard.dc).toBe(ac);
    const card = pushedCards()[0]!;
    expect(card.payload.dc).toBe(ac);
    expect(card.text).toBe(`Attack: Greatsword vs DC ${ac}`);
    expect(clicked).toBe(ac);
    expect(events.filter((e) => e.kind === 'roll')[0]!.text).toContain(`vs DC ${ac}`);
    expect(reply).toContain(`vs AC ${ac}`);
  });

  it('follows the setting on a saving throw an enemy forces on the player', async () => {
    const f = await fight();
    const forceSave = () =>
      useAction(db, {
        campaign_id: campaignId,
        actor_id: f.goblin,
        action_name: 'Scorching Blast',
        target_id: f.pc,
        damage_expr: '2d6',
        damage_type: 'fire',
        save_ability: 'dex',
        save_dc: 13,
        half_on_save: true,
        out_of_turn: true,
        reason: 'a reaction the fiction called for',
      });

    const hidden = forceSave();
    const quiet = await nextAsk();
    expect(quiet).toMatchObject({ purpose: 'Saving throw: DEX', dc: null });
    resolvePendingRoll(db, quiet.id);
    const result = await hidden;
    // The DM's own result still carries the DC the save was made against.
    expect((result.targets[0] as { save: { dc: number } }).save.dc).toBe(13);

    updateSettings(db, campaignId, { dc_disclosure: 'shown' });
    db.prepare('UPDATE combatant SET reaction_used = 0 WHERE id = ?').run(f.goblin);
    const shown = forceSave();
    const loud = await nextAsk();
    expect(loud).toMatchObject({ purpose: 'Saving throw: DEX', dc: 13 });
    expect(pushedCards().at(-1)!.text).toBe('Saving throw: DEX vs DC 13');
    resolvePendingRoll(db, loud.id);
    await shown;
  });

  it('keeps the DM roll tool answer whole while the pushed card goes without the DC', async () => {
    const waiting = rollForTool(db, {
      expr: '1d20+5',
      purpose: 'Stealth check',
      dc: 12,
      roll_type: 'check',
      campaign_id: campaignId,
      roller: 'player',
    });
    const card = await nextAsk();
    expect(card.dc).toBeNull();
    expect(pushedCards()[0]).toMatchObject({ text: 'Stealth check', payload: { dc: null } });
    expect(resolvePendingRoll(db, card.id).dc).toBeNull();
    // The tool waiting on the card answers the DM, the DC included.
    expect((await waiting).dc).toBe(12);
  });
});

describe.each(['hidden', 'shown'] as const)('the other cards with dc_disclosure %s', (mode) => {
  /** The card pushed for this purpose: its number once in shown mode, and nowhere in hidden. */
  function expectCard(purpose: string, dc: number): void {
    const card = pushedCards().find((one) => one.payload.purpose === purpose);
    expect(card, `no card for "${purpose}"`).toBeDefined();
    expect(card!.payload.dc).toBe(mode === 'shown' ? dc : null);
    expect(card!.text).toBe(mode === 'shown' ? `${purpose} vs DC ${dc}` : purpose);
  }

  /** A Sorcerer PC who knows Fire Bolt and holds Seeking Spell, at level 2 with its Sorcery Points. */
  function sorcerer(): void {
    campaignId = createCampaign(db, { name: 'Sorcery', story_shape: 'sandbox' }).campaign_id;
    const id = createCharacter(db, {
      campaign_id: campaignId,
      name: 'Zel',
      species: 'Human',
      class: 'Sorcerer',
      background: 'Acolyte',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 13, con: 14, int: 10, wis: 12, cha: 15 },
      ability_bonuses: { cha: 2, wis: 1 },
      skill_choices: ['arcana', 'deception', 'perception'],
      cantrips: ['Fire Bolt', 'Light', 'Mage Hand', 'Prestidigitation'],
      spells: ['Magic Missile', 'Shield'],
    }).character!.id;
    const row = db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string };
    const features = [
      ...(JSON.parse(row.features_json) as unknown[]),
      { name: 'Font of Magic', source: 'class', text: 'Font of Magic' },
      { name: 'Metamagic', source: 'class', text: 'Metamagic', mechanics: { options: ['Seeking Spell'] } },
      {
        name: 'Sorcery Points',
        source: 'class',
        text: 'Sorcery Points',
        mechanics: { resource: 'sorcery_points', max: 2, per: 'long', used: 0 },
      },
    ];
    // No starting armour: a Sorcerer cannot cast in armour they are not trained with.
    db.prepare("UPDATE character SET level = 2, features_json = ?, inventory_json = '[]' WHERE id = ?").run(
      JSON.stringify(features),
      id,
    );
  }

  it('the Stealth check to hide', async () => {
    updateSettings(db, campaignId, { dc_disclosure: mode });
    const f = await fight();
    // Three-quarters cover from the goblin, which is what hiding asks for.
    const rows = ['..............', '..............', '..##..........', '..............', '..............', '..............'];
    db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(
      JSON.stringify({ w: 14, h: 6, rows, features: [] }),
      f.encounterId,
    );
    db.prepare('UPDATE combatant SET x = 2, y = 1 WHERE id = ?').run(f.pc);
    db.prepare('UPDATE combatant SET x = 5, y = 4 WHERE id = ?').run(f.goblin);

    const hiding = useAction(db, { campaign_id: campaignId, actor_id: f.pc, action_name: 'hide' });
    resolvePendingRoll(db, (await nextAsk()).id);
    const hidden = (await hiding) as unknown as { dc: number };
    expectCard('Stealth check to hide', hidden.dc);
  });

  it('the check to escape a grapple', async () => {
    updateSettings(db, campaignId, { dc_disclosure: mode });
    const f = await fight();
    const grabbing = useAction(db, {
      campaign_id: campaignId,
      actor_id: f.goblin,
      action_name: 'grapple',
      target_id: f.pc,
      out_of_turn: true,
      reason: 'a reaction the fiction called for',
    });
    const save = await nextAsk();
    Math.random = () => 0; // a natural 1, so the hold takes
    resolvePendingRoll(db, save.id);
    await grabbing;
    Math.random = () => NAT_20;

    const escaping = useAction(db, { campaign_id: campaignId, actor_id: f.pc, action_name: 'escape_grapple' });
    resolvePendingRoll(db, (await nextAsk()).id);
    const escaped = (await escaping) as unknown as { dc: number };
    expectCard("Escape Goblin Warrior's grapple: athletics", escaped.dc);
  });

  it('the spell attack and its Seeking Spell reroll', async () => {
    sorcerer();
    updateSettings(db, campaignId, { dc_disclosure: mode });
    const f = await fight();
    const ac = getBattleState(db, campaignId)!.combatants.find((c) => c.id === f.goblin)!.ac;
    Math.random = () => 0; // a natural 1 on both rolls, so the miss is rerolled and misses again

    const casting = useAction(db, {
      campaign_id: campaignId,
      actor_id: f.pc,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: f.goblin,
      metamagic: ['Seeking Spell'],
    });
    resolvePendingRoll(db, (await nextAsk()).id);
    resolvePendingRoll(db, (await nextAsk()).id);
    await casting;
    expectCard('Spell attack: Fire Bolt', ac);
    expectCard('Seeking Spell: Fire Bolt rerolled', ac);
  });
});

describe('hit points in the fight log text', () => {
  /** A readout such as " - 12/20 HP" or " (12/20)", the shapes the engine's lines use. */
  const HP_READOUT = /\d+\/\d+( HP|\))/;

  it('names no monster hit points on its damage and feature_damage lines', async () => {
    updateSettings(db, campaignId, { player_rolls: 'none' });
    const f = await fight();
    const characterId = listCombatants(db, f.encounterId).find((c) => c.id === f.pc)!.character_id!;
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Forceful Focus',
      schema: {
        name: 'Forceful Focus',
        text: 'Forceful Focus',
        clauses: clausesSchema.parse([{ when: 'hit', do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }] }]),
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

    const result = await attack(db, {
      campaign_id: campaignId,
      attacker_id: f.pc,
      target_id: f.goblin,
      action_name: 'Greatsword',
    });

    const hurt = result.log.filter((e) => e.kind === 'damage' || e.kind === 'feature_damage');
    expect(hurt.map((e) => e.kind).sort()).toEqual(['damage', 'feature_damage']);
    for (const line of hurt) expect(line.text).not.toMatch(HP_READOUT);
    const goblin = listCombatants(db, f.encounterId).find((c) => c.id === f.goblin)!;
    const stored = combatLog(db, f.encounterId).map((e) => e.text);
    expect(stored.join('\n')).not.toContain(`${goblin.hp_current}/${goblin.hp_max}`);
    const pushed = combatEvents().flatMap((e) => e.payload.log);
    expect(pushed.map((e) => e.text).join('\n')).not.toMatch(HP_READOUT);
  });

  it('keeps the readout on a party member, whose numbers the player always sees', async () => {
    updateSettings(db, campaignId, { player_rolls: 'none' });
    const f = await fight();

    const result = await attack(db, {
      campaign_id: campaignId,
      attacker_id: f.goblin,
      target_id: f.pc,
      action_name: 'Scimitar',
      out_of_turn: true,
      reason: 'a reaction the fiction called for',
    });

    const pc = listCombatants(db, f.encounterId).find((c) => c.id === f.pc)!;
    const damage = result.log.find((e) => e.kind === 'damage')!;
    expect(damage.text).toMatch(new RegExp(` - ${pc.hp_current}/${pc.hp_max} HP\\.$`));
  });
});

describe('the edge-of-reach line', () => {
  it('logs the hold when the mover is already at the edge of a reach', async () => {
    const { pc, encounterId } = await fight();
    const held = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 2, y: 5 } });
    expect(held.position).toEqual({ x: 5, y: 5 });
    expect(held.paused_for_reactions).toHaveLength(1);
    expect(held.log).toHaveLength(1);
    expect(held.log[0]!.text).toBe("Borg holds at (5,5) on the edge of Goblin Warrior's reach; the next step leaves it.");
    expect(combatLog(db, encounterId).at(-1)!.text).toBe(held.log[0]!.text);
  });

  it('writes no such line when the move goes through or leaves no reach', async () => {
    const { pc } = await fight();
    const waived = moveToken(db, {
      campaign_id: campaignId,
      combatant_id: pc,
      to: { x: 2, y: 5 },
      waive_reactions: true,
    });
    expect(waived.position).toEqual({ x: 2, y: 5 });
    expect(waived.log.map((e) => e.text).join('\n')).not.toMatch(/edge of/);

    const free = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 2, y: 2 } });
    expect(free.log.map((e) => e.text).join('\n')).not.toMatch(/edge of/);
  });

  it('puts the hold line in the DM turn text', async () => {
    const { pc } = await fight();
    const client = await connect();
    const reply = replyText(
      await client.callTool({ name: 'move_token', arguments: { campaign_id: campaignId, combatant_id: pc, to: { x: 2, y: 5 } } }),
    );
    await client.close();
    expect(reply).toContain("Borg holds at (5,5) on the edge of Goblin Warrior's reach");
  });
});

describe('true names for the DM, the mask for the player', () => {
  const swordLabels = (state: BattleState): string[] =>
    state.legal_actions.filter((a) => a.id.toLowerCase().includes('longsword')).map((a) => a.label);

  it('answers the DM with the true weapon name and pushes the player only the mask', async () => {
    updateSettings(db, campaignId, { player_rolls: 'none' });
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });
    const f = await fight();

    // A step costs no Action, so the swing is still on the list the reply carries.
    const moved = moveToken(db, { campaign_id: campaignId, combatant_id: f.pc, to: { x: 5, y: 6 } });
    expect(swordLabels(moved.state)).toEqual(['Attack: +1 Longsword']);
    expect(swordLabels(combatEvents().at(-1)!.payload.state)).toEqual(['Attack: Unidentified longsword']);

    // The DM swings by the true name; the shared log is the player's, so it keeps the mask.
    const swung = await attack(db, {
      campaign_id: campaignId,
      attacker_id: f.pc,
      target_id: f.goblin,
      action_name: '+1 Longsword',
      roll: { total: 30, natural: 12 },
    });
    expect(swung.log.map((e) => e.text).join('\n')).toContain('Unidentified longsword');
    expect(playerSurfaces(f.encounterId)).not.toContain('+1 Longsword');
  });

  it('names the weapon truly in the DM turn text', async () => {
    updateSettings(db, campaignId, { player_rolls: 'none' });
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });
    const f = await fight();
    const client = await connect();
    const reply = replyText(
      await client.callTool({
        name: 'move_token',
        arguments: { campaign_id: campaignId, combatant_id: f.pc, to: { x: 5, y: 6 } },
      }),
    );
    await client.close();
    expect(reply).toContain('Attack: +1 Longsword');
    expect(playerSurfaces(f.encounterId)).not.toContain('+1 Longsword');
  });

  it('keeps the mask on the undo answer, which the player button reads too', async () => {
    updateSettings(db, campaignId, { player_rolls: 'none' });
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });
    const f = await fight();
    moveToken(db, { campaign_id: campaignId, combatant_id: f.pc, to: { x: 5, y: 6 } });

    const undone = undoLastCombatAction(db, campaignId);
    expect(swordLabels(undone.state)).toEqual(['Attack: Unidentified longsword']);
    expect(JSON.stringify(undone)).not.toContain('+1 Longsword');
  });

  it('ends the encounter with the true name for the DM and the mask on the event', async () => {
    updateSettings(db, campaignId, { player_rolls: 'none' });
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true, equipped: true });
    await fight();

    const ended = endEncounter(db, { campaign_id: campaignId, outcome: 'victory' });
    expect(swordLabels(ended.state)).toEqual(['Attack: +1 Longsword']);
    expect(swordLabels(combatEvents().at(-1)!.payload.state)).toEqual(['Attack: Unidentified longsword']);
    expect(JSON.stringify(events)).not.toContain('+1 Longsword');
  });
});
