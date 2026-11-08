// A2a-2 species actions: Breath Weapon, Draconic Flight, Adrenaline Rush, Large Form and Giant Ancestry on the
// species registry, Halfling Luck on death saves, the condition a hit rider's save is made against, and the
// homebrew guard on the class-feature loop. Dice are pinned throughout.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  grantFeature,
  levelUp,
  levelUpOptions,
  rest,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { legalActions } from '../src/combat/actions.js';
import { advanceTurn, attack, endEncounter, startEncounter, useAction } from '../src/combat/engine.js';
import { rollCheck, rollSave } from '../src/combat/d20.js';
import { critRangeOf, featureActionIds, heldFeatures, type HitRider } from '../src/combat/features.js';
import { applyHitRiders } from '../src/combat/riders.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, requireEncounter, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { findClass, findSpecies, skillChoiceGroups } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };
const miss = { total: 2, natural: 2 };

// rpg-dice-roller turns each Math.random into one die through its own integer step, so these are measured.
const D20_1 = 0;
const D20_18 = 0.6;
const D10_9 = 0.5;

/** The next dice the engine rolls, in order; anything after them rolls as 0.5. */
function queueRolls(values: number[]): void {
  let index = 0;
  Math.random = () => values[index++] ?? 0.5;
}

// --- building a character -----------------------------------------------------

function skillPicks(species: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass('fighter'), findSpecies(species))) {
    let taken = 0;
    for (const option of group.from) {
      if (taken >= group.choose) break;
      if (picks.includes(option)) continue;
      picks.push(option);
      taken += 1;
    }
  }
  return picks;
}

const summary = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

/** Levels a fighter up to the target level, taking the Champion and spreading each ability increase. */
function climbTo(id: number, level: number): void {
  awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[level - 1]! - summary(id).xp });
  while (summary(id).level < level) {
    const options = levelUpOptions(db, campaignId, id) as { subclass_choice?: unknown; ability_score_improvement?: unknown };
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = 'Champion';
    if (options.ability_score_improvement) choices.ability_increases = { str: 1, dex: 1 };
    levelUp(db, { campaign_id: campaignId, character_id: id, choices });
  }
}

/** A fighter of that species and lineage, alone in a campaign of its own, at the level named. */
function make(species: string, options: { lineage?: string; level?: number } = {}): number {
  campaignId = createCampaign(db, { name: species, story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  const id = createCharacter(db, {
    campaign_id: campaignId,
    name: species,
    class: 'fighter',
    species,
    ...(options.lineage ? { lineage: options.lineage } : {}),
    background: 'Soldier',
    ability_method: 'manual',
    abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(species),
  } as CreateCharacterInput).character!.id;
  if ((options.level ?? 1) > 1) climbTo(id, options.level!);
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify([{ name: 'Longsword', qty: 1, equipped: true }]),
    id,
  );
  return id;
}

// --- the battlefield ----------------------------------------------------------

async function ambush(goblins = 1): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: goblins }],
  });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
  // The hero at (10,5), the goblins in a row beside them: 5 ft, 10 ft, 15 ft away.
  place(pc().id, 10, 5);
  foes().forEach((goblin, n) => place(goblin.id, 11 + n, 5));
}

const encounter = () => requireEncounter(db, campaignId);
const combatants = (): Combatant[] => listCombatants(db, encounter().id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foes = (): Combatant[] => combatants().filter((c) => c.team === 'enemy');
const foe = (n = 0): Combatant => foes()[n]!;
const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

/** Hands the turn to this combatant with its whole economy back. */
const turnOf = (who: Combatant): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare(
    "UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed, flags_json = json_remove(flags_json, '$.attacks_used') WHERE id = ?",
  ).run(who.id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === who.id),
    state.encounter.id,
  );
};

type Reply = { log: Array<{ kind: string; text: string; payload: Record<string, unknown> }> } & Record<string, unknown>;

const use = async (action: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
  (await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: action, ...extra })) as unknown as Reply;

const swingAt = async (target: Combatant, roll = hit): Promise<Reply> =>
  (await attack(db, {
    campaign_id: campaignId,
    attacker_id: pc().id,
    target_id: target.id,
    action_name: 'Longsword',
    roll,
  })) as unknown as Reply;

const goblinHits = async (roll = hit): Promise<Reply> => {
  turnOf(foe());
  return (await attack(db, {
    campaign_id: campaignId,
    attacker_id: foe().id,
    target_id: pc().id,
    action_name: 'Scimitar',
    roll,
  })) as unknown as Reply;
};

/** What one resource of the trait has spent, off the row the spend writes. */
const usedOf = (id: number, key: string): number =>
  combatSheet(db, id).features.find((f) => f.mechanics?.resource === key)?.mechanics?.used ?? 0;

const logText = (reply: Reply): string => reply.log.map((e) => e.text).join(' ');

/** The call is refused, and nothing it touches has moved: the economy, the uses and every hit point. */
async function refusedAtNoCost(id: number, key: string, call: () => Promise<unknown>, message: RegExp): Promise<void> {
  const before = { used: usedOf(id, key), hp: combatants().map((c) => c.hp_current), me: pc() };
  await expect(call()).rejects.toThrow(message);
  const after = pc();
  expect(usedOf(id, key)).toBe(before.used);
  expect(combatants().map((c) => c.hp_current)).toEqual(before.hp);
  expect([after.action_used, after.bonus_used, after.reaction_used]).toEqual([
    before.me.action_used,
    before.me.bonus_used,
    before.me.reaction_used,
  ]);
}

/** Ends the fight and rests, for the recharge checks. */
function restUp(id: number, kind: 'short' | 'long'): void {
  if (getBattleState(db, campaignId)) endEncounter(db, { campaign_id: campaignId, outcome: 'other' });
  rest(db, { campaign_id: campaignId, character_id: id, kind });
}

beforeEach(() => {
  db = openDb(':memory:');
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- Breath Weapon ------------------------------------------------------------

describe('Breath Weapon', () => {
  it("breathes a 15 ft cone of the ancestor's damage: a DEX save, half on a success, a use and the Attack action spent", async () => {
    const id = make('Dragonborn', { lineage: 'Draconic Ancestor: Red' });
    await ambush(3);
    // Two goblins in the cone, the third moved out of it.
    place(foe(2).id, 10, 9);
    turnOf(pc());
    expect(legalActions(pc(), combatSheet(db, id)).map((a) => a.label)).toContain('Breath Weapon (2 left)');
    // The first goblin fails on a 1, the second saves on an 18; the 1d10 comes up 9 for each.
    queueRolls([D20_1, D10_9, D20_18, D10_9]);
    const reply = (await use('breath_weapon', { point: { x: 13, y: 5 } })) as Reply & {
      save_targets: Array<{ target_id: number; save: { success: boolean }; damage: { applied: number } }>;
    };
    const rows = reply.save_targets;
    expect(rows.map((r) => r.target_id).sort()).toEqual([foe(0).id, foe(1).id].sort());
    expect(rows.find((r) => r.target_id === foe(0).id)!.damage.applied).toBe(9);
    expect(rows.find((r) => r.target_id === foe(1).id)!.damage.applied).toBe(4);
    expect(foe(2).hp_current).toBe(200);
    expect(logText(reply)).toMatch(/exhales fire in a 15 ft cone/);
    expect(usedOf(id, 'breath_weapon')).toBe(1);
    expect(pc().action_used).toBe(true);
    // The only attack of a level 1 Attack action went on the breath.
    await refusedAtNoCost(id, 'breath_weapon', () => use('breath_weapon', { point: { x: 13, y: 5 } }), /no attack of it left/);
  });

  it('comes out as a 30 ft line on breath_weapon_line', async () => {
    make('Dragonborn', { lineage: 'Draconic Ancestor: Blue' });
    await ambush(1);
    place(foe().id, 15, 5); // 25 ft: past the cone, inside the line
    turnOf(pc());
    const reply = (await use('breath_weapon_line', { point: { x: 16, y: 5 } })) as Reply & { save_targets: Array<{ target_id: number }> };
    expect(reply.save_targets.map((r) => r.target_id)).toEqual([foe().id]);
    expect(logText(reply)).toMatch(/exhales lightning in a 30 ft line/);
  });

  it('replaces one attack of an Extra Attack action, and rolls 2d10 from level 5', async () => {
    const id = make('Dragonborn', { lineage: 'Draconic Ancestor: Red', level: 5 });
    await ambush(1);
    turnOf(pc());
    await swingAt(foe());
    // The second of the two swings is the breath: no other action is spent on it.
    const reply = (await use('breath_weapon', { target_id: foe().id })) as Reply & {
      save_targets: Array<{ damage?: { expr?: string } }>;
    };
    expect(logText(reply)).toMatch(/Breath Weapon, 2d10/);
    expect(pc().flags.attacks_used).toBe(2);
    expect(usedOf(id, 'breath_weapon')).toBe(1);
    await expect(swingAt(foe())).rejects.toThrow(/all 2 attacks/);
  });

  it('is refused at no cost with its uses gone, and comes back on a Long Rest but not a Short one', async () => {
    const id = make('Dragonborn', { lineage: 'Draconic Ancestor: Red' });
    await ambush(1);
    for (let n = 0; n < 2; n += 1) {
      turnOf(pc());
      await use('breath_weapon', { target_id: foe().id });
    }
    turnOf(pc());
    expect(featureActionIds(combatSheet(db, id))).toContain('breath_weapon');
    expect(legalActions(pc(), combatSheet(db, id)).map((a) => a.id)).not.toContain('feature:breath_weapon');
    await refusedAtNoCost(id, 'breath_weapon', () => use('breath_weapon', { target_id: foe().id }), /0 of 2/);
    restUp(id, 'short');
    expect(usedOf(id, 'breath_weapon')).toBe(2);
    restUp(id, 'long');
    expect(usedOf(id, 'breath_weapon')).toBe(0);
  });
});

// --- Draconic Flight ----------------------------------------------------------

describe('Draconic Flight', () => {
  it('waits for level 5', async () => {
    const id = make('Dragonborn', { lineage: 'Draconic Ancestor: Red' });
    expect(featureActionIds(combatSheet(db, id))).not.toContain('draconic_flight');
  });

  it('spreads the wings as a Bonus Action once a Long Rest', async () => {
    const id = make('Dragonborn', { lineage: 'Draconic Ancestor: Red', level: 5 });
    await ambush(1);
    turnOf(pc());
    const reply = await use('draconic_flight');
    expect(logText(reply)).toMatch(/Fly Speed of \d+ ft for 10 minutes/);
    expect(pc().bonus_used).toBe(true);
    expect(usedOf(id, 'draconic_flight')).toBe(1);
    turnOf(pc());
    await refusedAtNoCost(id, 'draconic_flight', () => use('draconic_flight'), /0 of 1/);
    restUp(id, 'short');
    expect(usedOf(id, 'draconic_flight')).toBe(1);
    restUp(id, 'long');
    expect(usedOf(id, 'draconic_flight')).toBe(0);
  });
});

// --- Adrenaline Rush ----------------------------------------------------------

describe('Adrenaline Rush', () => {
  it('Dashes as a Bonus Action and gives Proficiency Bonus temporary hit points, PB times a Short Rest', async () => {
    const id = make('Orc');
    await ambush(1);
    turnOf(pc());
    const before = pc().movement_left;
    await use('adrenaline_rush');
    expect(pc().bonus_used).toBe(true);
    expect(pc().movement_left).toBe(before + pc().speed);
    expect(pc().temp_hp).toBe(2);
    expect(usedOf(id, 'adrenaline_rush')).toBe(1);
    turnOf(pc());
    await use('adrenaline_rush');
    turnOf(pc());
    await refusedAtNoCost(id, 'adrenaline_rush', () => use('adrenaline_rush'), /0 of 2/);
    restUp(id, 'short');
    expect(usedOf(id, 'adrenaline_rush')).toBe(0);
  });
});

// --- Large Form ---------------------------------------------------------------

describe('Large Form', () => {
  it('waits for level 5', () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Fire's Burn" });
    expect(featureActionIds(combatSheet(db, id))).not.toContain('large_form');
  });

  it('gives Advantage on Strength checks and 10 ft more Speed for the fight, once a Long Rest', async () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Fire's Burn", level: 5 });
    await ambush(1);
    turnOf(pc());
    const before = pc().movement_left;
    await use('large_form');
    expect(pc().bonus_used).toBe(true);
    expect(pc().movement_left).toBe(before + 10);
    expect(usedOf(id, 'large_form')).toBe(1);
    const str = await rollCheck(db, encounter(), pc(), { ability: 'str', dc: 10, purpose: 'Lift the gate', tool: 'test' });
    expect(str.advantage).toBe('advantage');
    expect(str.notes.join(' ')).toMatch(/Large Form/);
    expect((await rollCheck(db, encounter(), pc(), { ability: 'dex', dc: 10, purpose: 'Balance', tool: 'test' })).advantage).toBe('none');
    // The next turn opens on Speed + 10 ft.
    db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
      getBattleState(db, campaignId)!.combatants.findIndex((c) => c.id === foe().id),
      encounter().id,
    );
    await advanceTurn(db, campaignId);
    expect(pc().movement_left).toBe(pc().speed + 10);
    // In the next fight the form is over, and the use is still gone until a Long Rest.
    restUp(id, 'short');
    await ambush(1);
    turnOf(pc());
    expect(pc().flags.large_form).toBeUndefined();
    await refusedAtNoCost(id, 'large_form', () => use('large_form'), /0 of 1/);
    restUp(id, 'long');
    expect(usedOf(id, 'large_form')).toBe(0);
  });
});

// --- Giant Ancestry -----------------------------------------------------------

describe('Giant Ancestry', () => {
  it("Fire's Burn: declared before the swing, it adds 1d10 Fire to the hit and spends a use only then", async () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Fire's Burn" });
    await ambush(1);
    turnOf(pc());
    expect(legalActions(pc(), combatSheet(db, id)).map((a) => a.label)).toContain("Fire's Burn (no action) (2 left)");
    await use('fires_burn');
    expect(usedOf(id, 'giant_ancestry')).toBe(0);
    // A miss costs nothing and keeps it armed.
    await swingAt(foe(), miss);
    expect(usedOf(id, 'giant_ancestry')).toBe(0);
    expect(pc().flags.giant_ancestry_ready).toBe(true);
    turnOf(pc());
    const reply = await swingAt(foe());
    expect(logText(reply)).toMatch(/Fire's Burn: 1d10 Fire damage/);
    expect(usedOf(id, 'giant_ancestry')).toBe(1);
    expect(pc().flags.giant_ancestry_ready).toBeUndefined();
    // The second use, then a refusal at no cost, then the Long Rest.
    await use('fires_burn');
    turnOf(pc());
    await swingAt(foe());
    expect(usedOf(id, 'giant_ancestry')).toBe(2);
    await refusedAtNoCost(id, 'giant_ancestry', () => use('fires_burn'), /no Fire's Burn left/);
    restUp(id, 'short');
    expect(usedOf(id, 'giant_ancestry')).toBe(2);
    restUp(id, 'long');
    expect(usedOf(id, 'giant_ancestry')).toBe(0);
  });

  it("Frost's Chill: 1d6 Cold on the hit and 10 ft off the target's Speed", async () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Frost's Chill" });
    await ambush(1);
    turnOf(pc());
    await use('frosts_chill');
    const reply = await swingAt(foe());
    expect(logText(reply)).toMatch(/Frost's Chill: 1d6 Cold damage/);
    expect(foe().flags.slowed_by).toEqual({ attacker_id: pc().id, ft: 10 });
    expect(usedOf(id, 'giant_ancestry')).toBe(1);
  });

  it("Hill's Tumble: knocks a Large or smaller creature Prone, and waits out a hit on a Huge one", async () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Hill's Tumble" });
    await ambush(1);
    turnOf(pc());
    await use('hills_tumble');
    db.prepare("UPDATE combatant SET size = 'H' WHERE id = ?").run(foe().id);
    await swingAt(foe());
    expect(foe().conditions).not.toContain('prone');
    expect(usedOf(id, 'giant_ancestry')).toBe(0);
    db.prepare("UPDATE combatant SET size = 'S' WHERE id = ?").run(foe().id);
    turnOf(pc());
    await swingAt(foe());
    expect(foe().conditions).toContain('prone');
    expect(usedOf(id, 'giant_ancestry')).toBe(1);
  });

  it("Stone's Endurance: the Reaction declared before the blow takes 1d12 + CON off it, and the use goes on that blow", async () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Stone's Endurance" });
    await ambush(1);
    turnOf(foe());
    const hp = pc().hp_current;
    await use('stones_endurance', { out_of_turn: true, reason: 'the goblin swings' });
    expect(pc().reaction_used).toBe(true);
    expect(usedOf(id, 'giant_ancestry')).toBe(0);
    // The scimitar's 1d6+2 comes to 5, and 1d12 + 2 comes to 11: the blow does nothing.
    const reply = await goblinHits();
    expect(logText(reply)).toMatch(/sets like stone: 11 off the damage/);
    expect(pc().hp_current).toBe(hp);
    expect(usedOf(id, 'giant_ancestry')).toBe(1);
    expect(pc().flags.stones_endurance_ready).toBeUndefined();
    expect(reply.deflect_redirect_available).toBeUndefined();
  });

  it("Storm's Thunder: the Reaction declared before the blow answers it with 1d8 Thunder", async () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Storm's Thunder" });
    await ambush(1);
    turnOf(foe());
    await use('storms_thunder', { out_of_turn: true, reason: 'the goblin swings' });
    const reply = await goblinHits();
    const thunder = reply.log.find((e) => e.kind === 'feature_damage' && e.payload.feature === "Storm's Thunder")!;
    expect(thunder.payload.type).toBe('thunder');
    expect(foe().hp_current).toBe(200 - (thunder.payload.applied as number));
    expect(usedOf(id, 'giant_ancestry')).toBe(1);
    expect(pc().flags.storms_thunder_ready).toBeUndefined();
  });

  it("Cloud's Jaunt: a Bonus Action and a use, with the teleport left to the DM", async () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Cloud's Jaunt" });
    await ambush(1);
    turnOf(pc());
    const reply = await use('clouds_jaunt');
    expect(pc().bonus_used).toBe(true);
    expect(usedOf(id, 'giant_ancestry')).toBe(1);
    expect(reply.log.find((e) => e.kind === 'feature_action')!.payload.dm_note).toMatch(/Move the token/);
  });

  it('holds only the lineage the character chose, and none from a sheet that lists every lineage', () => {
    const id = make('Goliath', { lineage: "Giant Ancestry: Fire's Burn" });
    const held = heldFeatures(combatSheet(db, id)).map((h) => h.handler.index);
    expect(held).toContain('giant-ancestry-fires-burn');
    expect(held).not.toContain('giant-ancestry-storms-thunder');
    // An older sheet with no lineage carries every benefit's row, and none of them is the character's own.
    const row = db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string };
    const features = JSON.parse(row.features_json) as Array<Record<string, unknown>>;
    features.push({ name: "Giant Ancestry: Storm's Thunder", source: 'species', text: 'Storm' });
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), id);
    const legacy = heldFeatures(combatSheet(db, id)).map((h) => h.handler.index);
    expect(legacy.filter((index) => index.startsWith('giant-ancestry-'))).toEqual([]);
  });
});

// --- save context and Halfling Luck at the turn and rider call sites --------------

describe('the call sites wired here', () => {
  it("passes a hit rider's condition to the save, so a Dwarf saves against Poisoned with Advantage", async () => {
    const id = make('Dwarf');
    await ambush(1);
    const rider: HitRider = { kind: 'save', feature: 'Test venom', ability: 'con', dc: 30, condition: 'poisoned', ends: 'minute', note: 'Venom.' };
    const done = await applyHitRiders(db, encounter(), foe(), pc(), combatSheet(db, id), [rider], new Map(), false);
    expect((done.applied[0]!.save as { advantage: string }).advantage).toBe('advantage');
  });

  async function dyingOnTheirTurn(species: string): Promise<Reply> {
    const id = make(species);
    await ambush(1);
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(id);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE character_id = ?').run(id);
    await goblinHits();
    expect(pc().hp_current).toBe(0);
    // The goblin's turn ends and the hero's opens with a death save: a natural 1, then an 18.
    queueRolls([D20_1, D20_18]);
    return (await advanceTurn(db, campaignId)) as unknown as Reply;
  }

  it('rerolls a natural 1 on a Halfling death save, and the new roll stands', async () => {
    const reply = await dyingOnTheirTurn('Halfling');
    const save = reply.log.find((e) => e.kind === 'death_save')!;
    expect(save.text).toMatch(/Halfling Luck: the natural 1 is rerolled and the d20 now reads 18/);
    expect(save.payload.result).toBe('success');
  });

  it("leaves a Human's natural 1 on a death save as two failures", async () => {
    const reply = await dyingOnTheirTurn('Human');
    const save = reply.log.find((e) => e.kind === 'death_save')!;
    expect(save.text).not.toMatch(/Halfling Luck/);
    expect(save.payload.failures).toBe(2);
  });
});

// --- the homebrew guard on the class-feature loop ---------------------------------

describe('a homebrew row named like an SRD class feature', () => {
  it('runs its own clauses and never the SRD handler of that name', async () => {
    const id = make('Human');
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Improved Critical',
      schema: {
        name: 'Improved Critical',
        text: 'Improved Critical',
        clauses: clausesSchema.parse([
          { when: 'roll', if: { kind: 'save', save: ['con'] }, do: [{ kind: 'advantage' }] },
        ] satisfies ClauseInput[]),
      },
    }).id;
    grantFeature(db, { campaign_id: campaignId, character_id: id, name: 'Improved Critical', text: 'x', source: 'homebrew', mechanics: { homebrew_id: entry } });
    const sheet = combatSheet(db, id);
    const held = heldFeatures(sheet).map((h) => h.handler.index);
    // A level 1 Fighter is no Champion: the name does not buy the 19-20 critical range.
    expect(held).not.toContain('champion-improved-critical');
    expect(held).toContain(`homebrew:${entry}`);
    expect(critRangeOf(sheet)).toBe(20);
    await ambush(1);
    expect((await rollSave(db, encounter(), pc(), 'con' as Ability, 12)).advantage).toBe('advantage');
  });

  it('leaves a real Champion its Improved Critical', () => {
    const id = make('Human', { level: 3 });
    expect(critRangeOf(combatSheet(db, id))).toBe(19);
  });
});

