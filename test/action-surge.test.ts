// Action Surge buys one more Action whenever it is taken on the turn, and a readied action names its release.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  levelUp,
  levelUpOptions,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { legalActions } from '../src/combat/actions.js';
import { advanceTurn, attack, startEncounter, useAction } from '../src/combat/engine.js';
import { FEATURES, resourceState } from '../src/combat/features.js';
import { combatSheet } from '../src/combat/sheet.js';
import {
  getBattleState,
  listCombatants,
  renderTurn,
  type BattleState,
  type Combatant,
  type CombatLogEntry,
} from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { findClass, findSpecies, skillChoiceGroups } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

interface Options {
  subclass_choice?: unknown;
  ability_score_improvement?: unknown;
  feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
}

function climbTo(characterId: number, level: number): void {
  const owed = XP_THRESHOLDS[level - 1]! - sheetOf(characterId).xp;
  if (owed > 0) awardXp(db, { campaign_id: campaignId, character_id: characterId, amount: owed });
  while (sheetOf(characterId).level < level) {
    const options = levelUpOptions(db, campaignId, characterId) as Options;
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = 'Champion';
    if (options.ability_score_improvement) choices.ability_increases = { str: 1, con: 1 } as Partial<Record<Ability, number>>;
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]),
      );
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices });
  }
}

function skillPicks(): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass('fighter'), findSpecies('Human'))) {
    picks.push(...group.from.filter((option) => !picks.includes(option)).slice(0, group.choose));
  }
  return picks;
}

/** A Human Fighter at the level named, holding a Longsword. */
function fighter(level: number): number {
  const id = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Bram',
    class: 'fighter',
    species: 'Human',
    background: 'Soldier',
    ability_method: 'manual',
    abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(),
  } as CreateCharacterInput).character!.id;
  if (level > 1) climbTo(id, level);
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify([{ name: 'Longsword', qty: 1, equipped: true }]),
    id,
  );
  return id;
}

async function ambush(): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 1 }],
  });
  const state = getBattleState(db, campaignId)!;
  const map: BattleMap = { w: 60, h: 14, rows: Array.from({ length: 14 }, () => '.'.repeat(60)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  let x = 3;
  for (const c of listCombatants(db, state.encounter.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
  db.prepare("UPDATE combatant SET hp_max = 500, hp_current = 500 WHERE team = 'enemy'").run();
}

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (): Combatant => combatants().find((c) => c.team === 'enemy')!;

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

const turnOf = async (id: number): Promise<void> => {
  for (let step = 0; step < 30; step += 1) {
    const state = getBattleState(db, campaignId)!;
    if (state.combatants[state.encounter.turn_index]?.id === id) return;
    await advanceTurn(db, campaignId);
  }
  throw new Error(`The fight never came round to combatant ${id}.`);
};

const swing = (extra: Record<string, unknown> = {}) =>
  attack(db, { campaign_id: campaignId, attacker_id: pc().id, target_id: foe().id, action_name: 'Longsword', roll: hit, ...extra });

const use = (action: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: action, ...extra });

const fireBolt = () => use('Fire Bolt', { spell: 'Fire Bolt', target_id: foe().id });

/** Puts a cantrip on the sheet, so the legal actions have a spell to offer or withhold. */
const knowsFireBolt = (id: number): void => {
  db.prepare("UPDATE character SET spells_json = json_set(COALESCE(spells_json, '{}'), '$.cantrips', json('[\"Fire Bolt\"]')) WHERE id = ?").run(id);
};

const surgesLeft = (id: number): number | null => resourceState(combatSheet(db, id), FEATURES['fighter-action-surge']!)?.left ?? null;

const legalIds = (): string[] => legalActions(pc(), combatSheet(db, pc().character_id!)).map((a) => a.id);

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Surge', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('Action Surge taken before the Action', () => {
  it('lets a level 3 Fighter attack twice, as the journey playtest tried', async () => {
    fighter(3);
    await ambush();
    startTurn(pc().id);
    await use('action_surge');
    expect((await swing()).hit).toBe(true);
    expect((await swing()).hit).toBe(true);
    await expect(swing()).rejects.toThrow(/already taken their Action/i);
  });

  it('gives a level 5 Fighter two full Attack actions, four swings in all', async () => {
    fighter(5);
    await ambush();
    startTurn(pc().id);
    await use('action_surge');
    for (let n = 1; n <= 4; n += 1) {
      const done = (await swing()) as unknown as { attacks_used: number };
      expect(done.attacks_used).toBe(n > 2 ? n - 2 : n);
    }
    await expect(swing()).rejects.toThrow(/all 2 attacks/i);
  });

  it('keeps the turn own Action open to a spell, and bars the spell from the surged one', async () => {
    fighter(2);
    await ambush();
    startTurn(pc().id);
    await use('action_surge');
    await fireBolt();
    await expect(fireBolt()).rejects.toThrow(/Action Surge/i);
    // The refusal cost nothing: the surged Action is still there for an attack.
    expect((await swing()).hit).toBe(true);
    await expect(swing()).rejects.toThrow(/already taken their Action/i);
  });

  it('spends the two Actions on Dash and Dodge, and refuses a third', async () => {
    fighter(2);
    await ambush();
    startTurn(pc().id);
    const speed = pc().speed;
    await use('action_surge');
    await use('dash');
    expect(pc().movement_left).toBe(speed * 2);
    await use('dodge');
    expect(pc().flags.dodging).toBe(true);
    await expect(use('disengage')).rejects.toThrow(/already taken their Action/i);
  });

  it('lists the attacks and the standard actions, but no spell, once the turn own Action is spent', async () => {
    knowsFireBolt(fighter(2));
    await ambush();
    startTurn(pc().id);
    await use('action_surge');
    expect(legalIds()).toContain('cast:Fire Bolt');
    await swing();
    const ids = legalIds();
    expect(ids).toContain('attack:Longsword');
    expect(ids).toContain('dash');
    expect(ids).not.toContain('cast:Fire Bolt');
    await swing();
    expect(legalIds()).not.toContain('attack:Longsword');
    expect(legalIds()).not.toContain('dash');
  });
});

describe('Action Surge taken after the Action', () => {
  it('gives a level 5 Fighter a second full Attack action after the first', async () => {
    fighter(5);
    await ambush();
    startTurn(pc().id);
    await swing();
    await swing();
    await expect(swing()).rejects.toThrow(/all 2 attacks/i);
    await use('action_surge');
    expect((await swing()).hit).toBe(true);
    expect((await swing()).hit).toBe(true);
    await expect(swing()).rejects.toThrow(/all 2 attacks/i);
  });

  it('keeps the swing still owed from the first Attack action when the surge comes between them', async () => {
    fighter(5);
    await ambush();
    startTurn(pc().id);
    await swing();
    await use('action_surge');
    for (let n = 0; n < 3; n += 1) expect((await swing()).hit).toBe(true);
    await expect(swing()).rejects.toThrow(/all 2 attacks/i);
  });

  it('refuses a spell with the surged Action and spends nothing on the refusal', async () => {
    knowsFireBolt(fighter(2));
    await ambush();
    startTurn(pc().id);
    await swing();
    await use('action_surge');
    expect(legalIds()).toContain('attack:Longsword');
    expect(legalIds()).not.toContain('cast:Fire Bolt');
    const before = pc();
    await expect(fireBolt()).rejects.toThrow(/Action Surge.*Magic action/i);
    const after = pc();
    expect(after.action_used).toBe(before.action_used);
    expect(after.flags).toEqual(before.flags);
    await use('dash');
    await expect(use('dodge')).rejects.toThrow(/already taken their Action/i);
  });
});

describe('Action Surge uses', () => {
  it('is once a turn and once a rest at level 2', async () => {
    const id = fighter(2);
    await ambush();
    await turnOf(pc().id);
    await use('action_surge');
    expect(surgesLeft(id)).toBe(0);
    await expect(use('action_surge')).rejects.toThrow(/once on a turn/i);
    await advanceTurn(db, campaignId);
    await turnOf(pc().id);
    await expect(use('action_surge')).rejects.toThrow(/0 of 1 .*Rest to get it back/i);
    // The turn boundary took the unspent surged Action with it.
    await swing();
    await expect(swing()).rejects.toThrow(/already taken their Action/i);
  });
});

describe('a readied action', () => {
  it('names the release call when use_action is asked for release_ready, and spends nothing', async () => {
    fighter(2);
    await ambush();
    startTurn(pc().id);
    const readied = (await use('ready', { trigger: 'the goblin steps closer', readied_action: 'Longsword' })) as unknown as {
      log: CombatLogEntry[];
      state: BattleState;
    };
    // The log line and the hint are the player's plain words; the release call rides in the DM's turn text only.
    expect(readied.log.map((entry) => entry.text).join(' ')).not.toMatch(/attack \{/);
    expect(renderTurn(readied.state, readied.log)).toMatch(/attack \{.*out_of_turn: true.*reason/);
    expect(legalActions(pc(), combatSheet(db, pc().character_id!)).find((a) => a.id === 'release_ready')?.hint).toBe(
      'Triggers on "the goblin steps closer": it goes off out of turn and spends the reaction.',
    );

    startTurn(foe().id);
    const reason = 'readied Longsword as the goblin steps closer';
    await expect(use('release_ready', { target_id: foe().id, out_of_turn: true, reason })).rejects.toThrow(
      /attack \{attacker_id: \d+, target_id, action_name: "Longsword", out_of_turn: true, reason/,
    );
    expect(pc().reaction_used).toBe(false);
    expect(pc().flags.ready).toBeDefined();

    const released = await swing({ out_of_turn: true, reason });
    expect(released.log.some((entry) => entry.kind === 'ready_release')).toBe(true);
    expect(pc().flags.ready).toBeUndefined();
    expect(pc().reaction_used).toBe(true);
  });

  it('tells a combatant with nothing readied how to ready first', async () => {
    fighter(2);
    await ambush();
    startTurn(foe().id);
    await expect(use('release_ready', { out_of_turn: true, reason: 'the goblin moves' })).rejects.toThrow(
      /nothing readied.*use_action \{action_name: "ready"/i,
    );
  });
});
