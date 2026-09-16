import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, campaignSnapshot, getCharacterSheet } from '../src/core/campaign.js';
import { clausesSchema } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { setOverrides } from '../src/core/overrides.js';
import { luckBiasFor, updateSettings } from '../src/core/settings.js';
import { applyDamage, createCharacter, createCompanion, grantFeature, heal, rest, setCondition } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import {
  addCombatant,
  advanceTurn,
  applyEffect,
  attack,
  criticalExpr,
  endEffectById,
  endEncounter,
  findPositions,
  moveToken,
  setCombatCondition,
  startEncounter,
  tacticsBetween,
  undoLastCombatAction,
  useAction,
  xpForCr,
} from '../src/combat/engine.js';
import {
  aoeTargets,
  canStand,
  coverBetween,
  distanceBetween,
  hasLineOfSight,
  planMove,
  sizeCode,
  type Token,
} from '../src/combat/grid.js';
import { generateBattleMap, type BattleMap } from '../src/combat/map.js';
import { combatLog, getBattleState, listCombatants, listEffects, renderBattle, type BattleState } from '../src/combat/state.js';
import { legalActions, sheetActions } from '../src/combat/actions.js';
import { combatSheet } from '../src/combat/sheet.js';
import { boxDistance, boxesOverlap, distance, isInCone, isInLine } from '../src/combat/vendor/combat-geometry.js';
import { bresenhamLine } from '../src/combat/vendor/line-of-sight.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

/** Pins the RNG. The mapping is not linear, so the handful of values used here are named. */
const NAT_20 = 0.041;
const NAT_1 = 0;
const HIGH_D20 = 0.6; // 18, plus 4 on a d6
const MID_D20 = 0.5; // 9, plus 3 on a d6

function fixRolls(value: number): void {
  Math.random = () => value;
}

function makeCampaign(database: Db): number {
  // The engine's own dice are what these tests measure, so the player is not asked to click any.
  const id = createCampaign(database, {
    name: 'Combat',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  createCharacter(database, {
    campaign_id: id,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  return id;
}

async function ambush(options: { enemies?: number; creature?: string } = {}): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: options.creature ?? 'Goblin Warrior', count: options.enemies ?? 1 }],
  });
  return getBattleState(db, campaignId)!;
}

function place(id: number, x: number, y: number): void {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
}

/** Replaces the generated map with a hand-built one, so the geometry under test is exactly known. */
function setMap(rows: string[]): void {
  const encounterId = getBattleState(db, campaignId)!.encounter.id;
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(plainMap(rows)), encounterId);
}

const ids = (): { pc: number; enemy: number[] } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    enemy: combatants.filter((c) => c.team === 'enemy').map((c) => c.id),
  };
};

/** A hand-built map, so the geometry tests do not depend on the generator. */
function plainMap(rows: string[]): BattleMap {
  return { w: rows[0]!.length, h: rows.length, rows, features: [] };
}

const token = (id: number, x: number, y: number, size: Token['size'] = 'M'): Token => ({ id, x, y, size, alive: true });

/** Acting out of turn is a reaction: it needs a stated trigger, so every off-turn call in here carries one. */
const REACTION = { out_of_turn: true, reason: 'a reaction the fiction called for' };

/** A new round refreshes the reaction; these scenario tests only want the turn order bypassed. */
const clearReaction = (id: number): void => {
  db.prepare('UPDATE combatant SET reaction_used = 0 WHERE id = ?').run(id);
};

/** The PC's own hit points, so a test that needs them at a given number does not hard-code the maximum. */
const pcHpMax = (): number =>
  (db.prepare('SELECT hp_max FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as { hp_max: number })
    .hp_max;

/** Puts the turn on one combatant, so a test can act with them without walking the order round. */
const giveTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  const index = state.combatants.findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
});

afterEach(() => {
  Math.random = realRandom;
});

describe('vendored geometry', () => {
  it('measures Chebyshev distance in feet and honours footprints', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(15);
    expect(distance({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
    // A Large creature at (0,0) fills (0,0)-(1,1), so a Medium at (2,1) is adjacent.
    expect(boxDistance({ x: 0, y: 0, fp: 2 }, { x: 2, y: 1, fp: 1 })).toBe(5);
    expect(boxDistance({ x: 0, y: 0, fp: 2 }, { x: 1, y: 1, fp: 1 })).toBe(0);
  });

  it('detects footprint overlap, cones and lines', () => {
    expect(boxesOverlap({ x: 0, y: 0, fp: 2 }, { x: 1, y: 1, fp: 1 })).toBe(true);
    expect(boxesOverlap({ x: 0, y: 0, fp: 2 }, { x: 2, y: 0, fp: 1 })).toBe(false);
    expect(isInCone({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }, 20)).toBe(true);
    expect(isInCone({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 3 }, 20)).toBe(false);
    expect(isInLine({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, 30)).toBe(true);
    expect(isInLine({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 2 }, 30)).toBe(false);
  });

  it('traces a Bresenham line between two cells', () => {
    expect(bresenhamLine(0, 0, 3, 0)).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(bresenhamLine(0, 0, 2, 2)).toHaveLength(3);
  });
});

describe('map generator', () => {
  it('is deterministic for a seed and different for another', () => {
    const a = generateBattleMap(99, { terrain: 'forest', size: 'medium' });
    const b = generateBattleMap(99, { terrain: 'forest', size: 'medium' });
    const c = generateBattleMap(100, { terrain: 'forest', size: 'medium' });
    expect(a).toEqual(b);
    expect(a.rows).not.toEqual(c.rows);
    expect(a.rows).toHaveLength(a.h);
    expect(new Set(a.rows.map((r) => r.length))).toEqual(new Set([a.w]));
  });

  it('keeps both deployment strips walkable and labels the features it places', () => {
    const map = generateBattleMap(3, { terrain: 'cave', size: 'large', features: ['river', 'pillars'] });
    for (let y = 1; y < map.h - 1; y += 1) {
      expect(map.rows[y]![1]).toBe('.');
      expect(map.rows[y]![map.w - 2]).toBe('.');
    }
    expect(map.features.map((f) => f.kind)).toEqual(['river', 'pillars']);
    expect(map.features[0]!.label).toContain('River');
  });
});

describe('movement', () => {
  const open = plainMap([
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
  ]);

  it('spends 5 ft per cell and stops at the movement budget', () => {
    const mover = token(1, 0, 0);
    const plan = planMove(open, [mover], mover, { x: 9, y: 0 }, 30);
    expect(plan.cost_ft).toBe(30);
    expect(plan.destination).toEqual({ x: 6, y: 0 });
    expect(plan.reached).toBe(false);
  });

  it('pays double for difficult terrain', () => {
    const rough = plainMap(['.~~~......']);
    const mover = token(1, 0, 0);
    const plan = planMove(rough, [mover], mover, { x: 3, y: 0 }, 60);
    expect(plan.cost_ft).toBe(30);
  });

  it('walks around blocked cells and other creatures', () => {
    const walled = plainMap(['..#.......', '..#.......', '..........']);
    const mover = token(1, 0, 0);
    const blocker = token(2, 1, 0);
    const plan = planMove(walled, [mover, blocker], mover, { x: 3, y: 0 }, 60);
    expect(plan.reached).toBe(true);
    expect(plan.path.some((step) => step.x === 2 && step.y === 0)).toBe(false);
    expect(canStand(walled, [mover, blocker], mover, 1, 0)).toBe(false);
  });

  it('refuses a footprint that does not fit', () => {
    const gap = plainMap(['..#', '...', '..#']);
    const large = { ...token(1, 0, 0, 'L') };
    expect(canStand(gap, [large], large, 1, 0)).toBe(false);
    expect(canStand(gap, [large], large, 0, 0)).toBe(true);
    expect(sizeCode('gargantuan')).toBe('G');
  });
});

describe('line of sight and cover (the DMG corner rule)', () => {
  it('gives no cover across an open field', () => {
    const map = plainMap(['.....', '.....', '.....', '.....', '.....']);
    const a = token(1, 0, 2);
    const b = token(2, 4, 2);
    const result = coverBetween(map, [a, b], a, b);
    expect(result.cover).toBe('none');
    expect(result.ac_bonus).toBe(0);
    expect(result.line_of_sight).toBe(true);
    expect(hasLineOfSight(map, a, b)).toBe(true);
  });

  it('gives half cover to a target peeked at round the end of a wall', () => {
    // The wall fills x = 2 down to y = 2; the shooter has stepped past its end into the open row below.
    const map = plainMap(['..#..', '..#..', '..#..', '.....', '.....']);
    const shooter = token(1, 1, 3);
    const target = token(2, 4, 1);
    const result = coverBetween(map, [shooter, target], shooter, target);
    expect(result.cover).toBe('half');
    expect(result.ac_bonus).toBe(2);
    expect(result.line_of_sight).toBe(true);
  });

  it('gives total cover and no line of sight to a target squarely behind a wall', () => {
    const map = plainMap(['..#..', '..#..', '..#..', '..#..', '..#..']);
    const a = token(1, 0, 2);
    const b = token(2, 4, 2);
    const result = coverBetween(map, [a, b], a, b);
    expect(result.cover).toBe('total');
    expect(result.line_of_sight).toBe(false);
    expect(hasLineOfSight(map, a, b)).toBe(false);
  });

  it('gives three-quarters cover when only one corner line is clear', () => {
    // The wall at x = 2 has a gap at y = 2; shooting through it at a target off to the side leaves
    // three of the four corner lines against the wall.
    const map = plainMap(['..#..', '..#..', '.....', '..#..', '..#..']);
    const a = token(1, 0, 2);
    const b = token(2, 4, 4);
    const result = coverBetween(map, [a, b], a, b);
    expect(result.cover).toBe('three_quarters');
    expect(result.ac_bonus).toBe(5);
    expect(result.line_of_sight).toBe(true);
  });

  it('counts a cell a steep line only clips', () => {
    // A corner-to-corner line down a shallow slope clips a cell for a fraction of its width - the
    // line (0,0)->(10,9) crosses cell (1,0) for a ninth of a cell - which the old 1/8-cell sampling
    // stepped straight over, so the wall went unseen and the cover came out too low.
    const open = '...........';
    const shooter = token(1, 0, 0);
    const target = token(2, 9, 8);

    const oneWall = plainMap([open, '.#.........', open, open, open, open, open, open, open, open]);
    expect(coverBetween(oneWall, [shooter, target], shooter, target).cover).toBe('half');

    const corner = plainMap(['.#.........', '.#.........', open, open, open, open, open, open, open, open]);
    const result = coverBetween(corner, [shooter, target], shooter, target);
    expect(result.cover).toBe('total');
    expect(result.line_of_sight).toBe(false);
  });

  it('gives half cover for a creature standing in the way and none for one standing aside', () => {
    const map = plainMap(['.....', '.....', '.....']);
    const a = token(1, 0, 1);
    const b = token(2, 4, 1);
    const between = token(3, 2, 1);
    expect(coverBetween(map, [a, b, between], a, b).cover).toBe('half');
    expect(coverBetween(map, [a, b, { ...between, y: 0 }], a, b).cover).toBe('none');
    expect(coverBetween(map, [a, b], a, b).cover).toBe('none');
  });
});

describe('the luck dial in the engine', () => {
  it('pulls only the player character dice, and never says so to the DM', async () => {
    updateSettings(db, campaignId, { luck_bias: 2 });
    const cleric = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    }).companion!.id;
    fixRolls(MID_D20);
    const state = await ambush();
    const { pc, enemy } = ids();
    const companion = state.combatants.find((c) => c.character_id === cleric)!.id;
    place(pc, 1, 5);
    place(companion, 1, 6);
    place(enemy[0]!, 2, 5);

    const byPc = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Greatsword',
      ...REACTION,
    });
    // The dial reaches the player character alone, and the attack the DM reads back never shows its pool.
    expect(luckBiasFor(db, campaignId, true)).toBe(2);
    expect(luckBiasFor(db, campaignId, false)).toBe(0);
    expect(byPc.roll.expr).toBe('1d20+5');
    expect(byPc.roll.output).not.toContain('3d20');

    clearReaction(companion);
    const byCompanion = await attack(db, {
      campaign_id: campaignId,
      attacker_id: companion,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      ...REACTION,
    });
    expect(byCompanion.roll.expr).not.toContain('d20k');

    clearReaction(enemy[0]!);
    const byMonster = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Scimitar',
      ...REACTION,
    });
    expect(byMonster.roll.expr).toBe('1d20+4');
  });
});

describe('areas of effect', () => {
  const tokens = [token(1, 5, 5), token(2, 7, 5), token(3, 5, 9), token(4, 12, 5)];

  it('selects targets for a sphere, a cone, a line and a cube', () => {
    const sphere = aoeTargets(tokens, null, { x: 6, y: 5 }, { kind: 'sphere', size_ft: 10 });
    expect(sphere.map((t) => t.id).sort()).toEqual([1, 2]);

    const cone = aoeTargets(tokens, { x: 0, y: 5 }, { x: 1, y: 5 }, { kind: 'cone', size_ft: 40 });
    expect(cone.map((t) => t.id)).toEqual([1, 2]);

    const line = aoeTargets(tokens, { x: 0, y: 5 }, { x: 1, y: 5 }, { kind: 'line', size_ft: 60 });
    expect(line.map((t) => t.id)).toEqual([1, 2, 4]);

    const cube = aoeTargets(tokens, null, { x: 6, y: 5 }, { kind: 'cube', size_ft: 15 });
    expect(cube.map((t) => t.id).sort()).toEqual([1, 2]);
  });
});

describe('attacks', () => {
  it('hits, crits with doubled dice and misses on a natural 1', async () => {
    expect(criticalExpr('1d6+2')).toBe('2d6+2');
    expect(criticalExpr('2d8')).toBe('4d8');

    await ambush({ enemies: 2 });
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    place(enemy[1]!, 1, 4);

    fixRolls(NAT_20);
    const critical = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Greatsword',
      ...REACTION,
    });
    expect(critical.critical).toBe(true);
    expect(critical.hit).toBe(true);
    expect(critical.damage[0]!.expr).toBe('4d6+3');
    expect(critical.total_damage).toBe(11);
    expect(critical.target_hp.alive).toBe(false);
    expect(critical.log.map((l) => l.kind)).toContain('kill');

    fixRolls(NAT_1);
    const missed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[1]!,
      target_id: pc,
      action_name: 'Scimitar',
      ...REACTION,
    });
    expect(missed.roll.natural).toBe(1);
    expect(missed.hit).toBe(false);
    expect(missed.total_damage).toBe(0);
  });

  it('accepts a pre-rolled d20 so a player click can decide the hit', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    fixRolls(MID_D20);
    const result = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Greatsword',
      roll: { total: 20, natural: null },
      ...REACTION,
    });
    expect(result.roll.injected).toBe(true);
    expect(result.roll.total).toBe(20);
    expect(result.hit).toBe(true);
  });

  it('halves damage a creature resists and spends temporary hit points first', async () => {
    await ambush({ creature: 'Dretch' });
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    db.prepare('UPDATE combatant SET temp_hp = 4 WHERE id = ?').run(enemy[0]!);

    fixRolls(MID_D20);
    const result = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Flask of oil',
      target_id: enemy[0]!,
      damage_expr: '10',
      damage_type: 'fire',
      ...REACTION,
    });
    const damage = result.targets[0] as { damage: { applied: number; absorbed_by_temp_hp: number; resistance: string } };
    expect(damage.damage.resistance).toBe('resistant');
    expect(damage.damage.applied).toBe(5);
    expect(damage.damage.absorbed_by_temp_hp).toBe(4);
    expect(listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === enemy[0])!.hp_current).toBe(17);
  });

  it('halves area damage on a successful save', async () => {
    await ambush({ enemies: 2 });
    const { pc, enemy } = ids();
    place(enemy[0]!, 4, 5);
    place(enemy[1]!, 5, 5);
    fixRolls(HIGH_D20); // an 18 on the die beats DC 11
    const result = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Burning Hands',
      point: { x: 4, y: 5 },
      shape: { kind: 'sphere', size_ft: 10 },
      damage_expr: '10',
      damage_type: 'fire',
      save_ability: 'dex',
      save_dc: 11,
      half_on_save: true,
      ...REACTION,
    });
    expect(result.targets).toHaveLength(2);
    for (const entry of result.targets as Array<{ save: { success: boolean }; damage: { applied: number } }>) {
      expect(entry.save.success).toBe(true);
      expect(entry.damage.applied).toBe(5);
    }
  });

  it('cancels advantage at long range instead of stacking disadvantage on it', async () => {
    fixRolls(MID_D20);
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'large',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    setMap(Array.from({ length: 20 }, () => '.'.repeat(28)));
    const { pc, enemy } = ids();
    place(pc, 0, 5);
    place(enemy[0]!, 27, 5); // 135 ft: past the 80 ft normal range of a shortbow, inside its long range

    const shot = { campaign_id: campaignId, attacker_id: enemy[0]!, target_id: pc, action_name: 'Shortbow', ...REACTION };
    expect((await attack(db, { ...shot, advantage: 'advantage' })).advantage).toBe('none');
    clearReaction(enemy[0]!);
    expect((await attack(db, shot)).advantage).toBe('disadvantage');
    clearReaction(enemy[0]!);
    expect((await attack(db, { ...shot, advantage: 'disadvantage' })).advantage).toBe('disadvantage');
  });

  it('gives an area target behind a pillar cover on its DEX save', async () => {
    fixRolls(MID_D20);
    await ambush({ enemies: 2 });
    setMap(Array.from({ length: 10 }, (_, y) => (y === 3 ? '...#..........' : '..............')));
    const { pc, enemy } = ids();
    place(pc, 0, 3);
    place(enemy[0]!, 6, 3); // the pillar at (3,3) stands between the caster and this one
    place(enemy[1]!, 6, 8);

    const blast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Fireball',
      point: { x: 6, y: 5 },
      shape: { kind: 'sphere', size_ft: 20 },
      damage_expr: '2d6',
      damage_type: 'fire',
      save_ability: 'dex',
      save_dc: 13,
      half_on_save: true,
      ...REACTION,
    });
    const targets = blast.targets as Array<{ target_id: number; save: { bonus: number } }>;
    expect(targets.map((t) => t.target_id).sort()).toEqual([enemy[0]!, enemy[1]!].sort());
    expect(targets.find((t) => t.target_id === enemy[0])!.save.bonus).toBe(4); // +2 DEX and +2 for half cover
    expect(targets.find((t) => t.target_id === enemy[1])!.save.bonus).toBe(2);
  });

  it('takes a pre-rolled saving throw for the target that rolled it', async () => {
    fixRolls(NAT_1); // the server's own save would fail
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    const blast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Burning Hands',
      target_id: enemy[0]!,
      damage_expr: '2d6',
      damage_type: 'fire',
      save_ability: 'dex',
      save_dc: 13,
      half_on_save: true,
      rolls: { [String(enemy[0]!)]: { total: 18 } },
      ...REACTION,
    });
    const target = blast.targets[0] as { save: { total: number; success: boolean }; damage: { applied: number } };
    expect(target.save.total).toBe(18);
    expect(target.save.success).toBe(true);
    expect(target.damage.applied).toBe(1); // 2d6 rolls 2 at this seed, halved by the save
  });

  it('gives cover to a spell attack as it does to a weapon swing', async () => {
    fixRolls(HIGH_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 0, 3);
    place(enemy[0]!, 6, 3);
    // The wall at x = 3 runs the height of the map, except for a gap level with the two of them.
    setMap(Array.from({ length: 10 }, (_, y) => (y === 3 ? '...#..........' : '..............')));

    const targetAc = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === enemy[0])!.ac;
    const halved = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: enemy[0]!,
      ...REACTION,
    });
    const attack = (halved.targets[0] as { attack: { ac: number } }).attack;
    expect(attack.ac).toBe(targetAc + 2);
    const payload = halved.log.find((entry) => entry.kind === 'attack')!.payload as {
      cover: string;
      effective_ac: number;
    };
    expect(payload.cover).toBe('half');
    expect(payload.effective_ac).toBe(targetAc + 2);

    // The same wall squarely between them is total cover: the spell attack is refused, not re-aimed.
    setMap(Array.from({ length: 10 }, () => '...#..........'));
    clearReaction(pc);
    await expect(
      useAction(db, {
        campaign_id: campaignId,
        actor_id: pc,
        action_name: 'Fire Bolt',
        spell: 'Fire Bolt',
        target_id: enemy[0]!,
        ...REACTION,
      }),
    ).rejects.toThrow(/total cover/);
  });
});

describe('turn ownership', () => {
  it('refuses an action from anyone but the active combatant unless out_of_turn is passed', async () => {
    fixRolls(MID_D20);
    const state = await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    const active = state.active!;
    const idle = state.combatants.find((c) => c.id !== active.id)!;
    const weapon = (id: number): string => (id === pc ? 'Greatsword' : 'Scimitar');
    const foe = (id: number): number => (id === pc ? enemy[0]! : pc);

    const offTurn = { campaign_id: campaignId, attacker_id: idle.id, target_id: foe(idle.id), action_name: weapon(idle.id) };
    await expect(attack(db, offTurn)).rejects.toThrow(`It is ${active.name}'s turn`);
    expect(() => moveToken(db, { campaign_id: campaignId, combatant_id: idle.id, to: { x: 1, y: 7 } })).toThrow(
      `It is ${active.name}'s turn`,
    );
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: idle.id, action_name: 'Shove', target_id: foe(idle.id) }),
    ).rejects.toThrow(`It is ${active.name}'s turn`);

    // Whoever is up needs no flag; everyone else gets through as a reaction or a DM ruling.
    const inTurn = await attack(db, {
      campaign_id: campaignId,
      attacker_id: active.id,
      target_id: foe(active.id),
      action_name: weapon(active.id),
    });
    expect(inTurn.attacker_id).toBe(active.id);
    const reaction = await attack(db, { ...offTurn, ...REACTION });
    expect(reaction.attacker_id).toBe(idle.id);
    expect(getBattleState(db, campaignId)!.active!.id).toBe(active.id);
  });

  it('spends the reaction out of turn, needs a reason for it and refuses a second one', async () => {
    fixRolls(MID_D20);
    const state = await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    const idle = state.combatants.find((c) => c.id !== state.active!.id)!;
    const shot = {
      campaign_id: campaignId,
      attacker_id: idle.id,
      target_id: idle.id === pc ? enemy[0]! : pc,
      action_name: idle.id === pc ? 'Greatsword' : 'Scimitar',
    };

    await expect(attack(db, { ...shot, out_of_turn: true })).rejects.toThrow('needs a reason');
    await expect(attack(db, { ...shot, out_of_turn: true, reason: '  ' })).rejects.toThrow('needs a reason');

    const reaction = await attack(db, { ...shot, out_of_turn: true, reason: 'opportunity attack as they slip past' });
    expect(reaction.out_of_turn).toBe(true);
    expect(reaction.log[0]!.text).toContain('REACTION: opportunity attack as they slip past.');
    const after = listCombatants(db, state.encounter.id).find((c) => c.id === idle.id)!;
    expect(after.reaction_used).toBe(true);
    expect(after.action_used).toBe(false);

    await expect(attack(db, { ...shot, out_of_turn: true, reason: 'and another one' })).rejects.toThrow(
      'already used their reaction this round',
    );
    expect(() =>
      moveToken(db, { campaign_id: campaignId, combatant_id: idle.id, to: { x: 1, y: 7 }, out_of_turn: true, reason: 'step back' }),
    ).toThrow('already used their reaction this round');
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: idle.id, action_name: 'Shove', out_of_turn: true, reason: 'shove back' }),
    ).rejects.toThrow('already used their reaction this round');
  });
});

describe('concentration', () => {
  it('breaks on a failed save and ends the effects it held', async () => {
    await ambush({ enemies: 2 });
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    place(enemy[1]!, 1, 6);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;

    fixRolls(MID_D20);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Hold Person',
      target_id: enemy[0]!,
      concentration: true,
      effect: { name: 'paralyzed', kind: 'condition', tick: 'start', ends: 'concentration' },
      ...REACTION,
    });
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(1);

    fixRolls(NAT_1); // the concentration save fails
    const hit = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[1]!,
      target_id: pc,
      action_name: 'Scimitar',
      roll: { total: 25, natural: null },
      ...REACTION,
    });
    expect(hit.hit).toBe(true);
    expect(hit.log.map((l) => l.kind)).toContain('concentration');
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);
    expect(listCombatants(db, encounterId).find((c) => c.id === pc)!.concentration).toBeNull();
  });

  it('ends without a save when the concentrating holder drops to 0 HP', async () => {
    await ambush({ enemies: 2 });
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    place(enemy[1]!, 1, 6);

    fixRolls(MID_D20);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Hold Person',
      target_id: enemy[0]!,
      concentration: true,
      effect: { name: 'paralyzed', kind: 'condition', tick: 'start', ends: 'concentration' },
      ...REACTION,
    });
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(1);

    applyDamage(db, { campaign_id: campaignId, amount: pcHpMax() - 3 }); // down to 3 HP, still up and concentrating

    fixRolls(NAT_1); // minimum weapon damage (1d6+2 = 3), just enough to land exactly on 0 HP
    const hit = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[1]!,
      target_id: pc,
      action_name: 'Scimitar',
      roll: { total: 25, natural: null },
      ...REACTION,
    });
    expect(hit.hit).toBe(true);
    expect(getBattleState(db, campaignId)!.combatants.find((c) => c.id === pc)!.hp_current).toBe(0);
    expect(hit.log.map((l) => l.kind)).toContain('effect_end');
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);
  });

  it('ends with the caster, without a save, when they are killed', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: enemy[0]!,
      action_name: 'Hex',
      target_id: pc,
      concentration: true,
      effect: { name: 'hexed', kind: 'damage', damage_expr: '1d4', damage_type: 'necrotic', tick: 'start', ends: 'concentration' },
      ...REACTION,
    });
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(1);

    const killed = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Coup de grace',
      target_id: enemy[0]!,
      damage_expr: '30',
      damage_type: 'slashing',
      ...REACTION,
    });
    expect(killed.log.map((entry) => entry.kind)).toContain('effect_end');
    expect(killed.log.map((entry) => entry.kind)).not.toContain('concentration');
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);

    const ticks: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      for (const entry of (await advanceTurn(db, campaignId)).log) if (entry.kind === 'effect_tick') ticks.push(entry.text);
    }
    expect(ticks).toEqual([]);
  });

  it('ends what a killed source held, whether or not it carries the concentration flag', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;

    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc,
      source_id: enemy[0]!,
      name: 'hexed',
      kind: 'damage',
      damage_expr: '1d4',
      damage_type: 'necrotic',
      tick: 'start',
      ends: 'concentration',
    });
    // apply_effect makes the source concentrate on what it just started.
    expect(listCombatants(db, encounterId).find((c) => c.id === enemy[0])!.concentration).toEqual({ name: 'hexed' });
    // ... and the effect ends with the source even when the flag is missing.
    db.prepare('UPDATE combatant SET concentration_json = NULL WHERE id = ?').run(enemy[0]!);

    const killed = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Coup de grace',
      target_id: enemy[0]!,
      damage_expr: '30',
      damage_type: 'slashing',
      ...REACTION,
    });
    expect(killed.log.map((entry) => entry.kind)).toContain('effect_end');
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);

    const ticks: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      for (const entry of (await advanceTurn(db, campaignId)).log) if (entry.kind === 'effect_tick') ticks.push(entry.text);
    }
    expect(ticks).toEqual([]);
  });
});

describe('ongoing effects', () => {
  it('rolls damage on every tick and expires after its rounds', async () => {
    await ambush();
    const { pc, enemy } = ids();
    fixRolls(MID_D20);
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: enemy[0]!,
      name: 'on fire',
      kind: 'damage',
      damage_expr: '1d6',
      damage_type: 'fire',
      tick: 'start',
      ends: 'rounds',
      remaining_rounds: 2,
    });

    const ticks: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const turn = await advanceTurn(db, campaignId);
      for (const entry of turn.log) if (entry.kind === 'effect_tick' || entry.kind === 'effect_end') ticks.push(entry.kind);
    }
    expect(ticks.filter((k) => k === 'effect_tick')).toHaveLength(2);
    expect(ticks).toContain('effect_end');
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);
    expect(listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === enemy[0])!.hp_current).toBe(4);
    expect(pc).toBeGreaterThan(0);
  });

  it('ends a save-ends effect when the save succeeds', async () => {
    await ambush();
    const { enemy } = ids();
    fixRolls(HIGH_D20); // the save always succeeds
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: enemy[0]!,
      name: 'poisoned',
      kind: 'condition',
      save_ability: 'con',
      save_dc: 12,
      tick: 'end',
      ends: 'save',
    });
    expect(getBattleState(db, campaignId)!.combatants.find((c) => c.id === enemy[0])!.conditions).toEqual(['poisoned']);

    for (let i = 0; i < 3; i += 1) await advanceTurn(db, campaignId);
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);
    expect(getBattleState(db, campaignId)!.combatants.find((c) => c.id === enemy[0])!.conditions).toEqual([]);
  });

  it('takes pre-rolled saves for the effects ticking on advance_turn', async () => {
    fixRolls(NAT_1); // the server's own save would fail
    await ambush();
    const { enemy } = ids();
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: enemy[0]!,
      name: 'poisoned',
      kind: 'condition',
      save_ability: 'con',
      save_dc: 12,
      tick: 'end',
      ends: 'save',
    });
    for (let i = 0; i < 3; i += 1) await advanceTurn(db, campaignId, { [String(enemy[0]!)]: { total: 19 } });
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);
  });

  it('refuses either rest mid-encounter and clears whatever is left when the fight ends', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const winded = { campaign_id: campaignId, target_id: pc, name: 'winded', kind: 'buff' as const, tick: 'start' as const, ends: 'manual' as const };
    applyEffect(db, winded);
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: enemy[0]!,
      name: 'marked',
      kind: 'buff',
      tick: 'start',
      ends: 'manual',
    });

    // Neither rest can be taken while the fight runs, so both effects stay put.
    expect(() => rest(db, { campaign_id: campaignId, kind: 'short' })).toThrow(/active encounter/i);
    expect(getBattleState(db, campaignId)!.effects.map((e) => e.name)).toEqual(['winded', 'marked']);
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long' })).toThrow(/active encounter/i);
    expect(getBattleState(db, campaignId)!.effects.map((e) => e.name)).toEqual(['winded', 'marked']);

    endEncounter(db, { campaign_id: campaignId, outcome: 'retreat' });
    expect(listEffects(db, encounterId)).toHaveLength(0);
  });

  it('ends an effect by id when the DM says it is over', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc } = ids();
    const applied = applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc,
      name: 'blinded',
      kind: 'condition',
      tick: 'start',
      ends: 'manual',
    });
    expect(campaignSnapshot(db, campaignId).pc!.conditions).toEqual(['blinded']);

    const ended = endEffectById(db, { campaign_id: campaignId, effect_id: applied.effect.id });
    expect(ended.log[0]!.kind).toBe('effect_end');
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);
    expect(getBattleState(db, campaignId)!.combatants.find((c) => c.id === pc)!.conditions).toEqual([]);
    expect(campaignSnapshot(db, campaignId).pc!.conditions).toEqual([]);
    expect(() => endEffectById(db, { campaign_id: campaignId, effect_id: applied.effect.id })).toThrow('already ended');
  });

  it('counts a timed condition down and mirrors an untimed one onto the sheet', async () => {
    await ambush();
    const { pc } = ids();
    fixRolls(MID_D20);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'prone', active: true });
    expect(campaignSnapshot(db, campaignId).pc!.conditions).toEqual(['prone']);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'prone', active: false });
    expect(campaignSnapshot(db, campaignId).pc!.conditions).toEqual([]);

    expect(() =>
      setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'confused', active: true }),
    ).toThrow(/not an SRD condition/);
  });
});

describe('going down', () => {
  it('takes a PC through character.ts death saves and kills a monster at 0 HP', async () => {
    await ambush({ enemies: 2 });
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    place(enemy[1]!, 1, 4);
    fixRolls(HIGH_D20);

    const killed = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Coup de grace',
      target_id: enemy[0]!,
      damage_expr: '30',
      damage_type: 'slashing',
      ...REACTION,
    });
    expect((killed.targets[0] as { damage: { dead: boolean } }).damage.dead).toBe(true);
    expect(getBattleState(db, campaignId)!.combatants.find((c) => c.id === enemy[0])!.alive).toBe(false);
    expect(killed.log.map((entry) => entry.kind)).toContain('kill');

    await useAction(db, {
      campaign_id: campaignId,
      actor_id: enemy[1]!,
      action_name: 'Ambush',
      target_id: pc,
      damage_expr: String(pcHpMax()),
      damage_type: 'slashing',
      ...REACTION,
    });
    const downed = getBattleState(db, campaignId)!.combatants.find((c) => c.id === pc)!;
    expect(downed.hp_current).toBe(0);
    expect(downed.alive).toBe(true);
    expect(downed.conditions).toContain('unconscious');
    expect(campaignSnapshot(db, campaignId).pc!.hp_current).toBe(0);

    // The engine rolls the death save itself when the PC's turn comes round.
    let saves = 0;
    for (let i = 0; i < 4; i += 1) {
      const turn = await advanceTurn(db, campaignId);
      saves += turn.log.filter((entry) => entry.kind === 'death_save').length;
    }
    expect(saves).toBeGreaterThan(0);
    const deathSaves = campaignSnapshot(db, campaignId).pc!.death_saves as { successes: number; failures: number };
    expect(deathSaves.successes + deathSaves.failures).toBeGreaterThan(0);
  });

  it('refuses to open a fight without a living player character', async () => {
    fixRolls(MID_D20);
    applyDamage(db, { campaign_id: campaignId, amount: 100, source: 'a falling rock' });
    expect(campaignSnapshot(db, campaignId).pc!.status).toBe('dead');

    await expect(ambush()).rejects.toThrow('No living player character');
    expect(getBattleState(db, campaignId)).toBeNull();
  });

  it('logs one kill when a rider and a second damage component take the creature to 0', async () => {
    fixRolls(HIGH_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);

    const characterId = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === pc)!
      .character_id!;
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
    // One hit point: the weapon part kills it, and the rider used to log a second "drops dead".
    db.prepare('UPDATE combatant SET hp_max = 1, hp_current = 1 WHERE id = ?').run(enemy[0]!);

    const killed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Greatsword',
      ...REACTION,
    });
    expect(killed.target_hp.alive).toBe(false);
    expect(killed.log.filter((entry) => entry.kind === 'kill')).toHaveLength(1);

    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Greatsword' }),
    ).rejects.toThrow('already dead');
  });
});

describe('character tools during a fight', () => {
  const rowOf = (id: number) =>
    listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === id)!;

  it('mirrors damage, conditions and healing into the combatant row', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc } = ids();
    const encounterId = getBattleState(db, campaignId)!.encounter.id;

    const max = pcHpMax();
    applyDamage(db, { campaign_id: campaignId, amount: 8, source: 'a falling rock' });
    expect(rowOf(pc).hp_current).toBe(max - 8);
    expect(rowOf(pc).hp_max).toBe(max);

    setCondition(db, { campaign_id: campaignId, condition: 'prone', active: true });
    expect(rowOf(pc).conditions).toContain('prone');

    heal(db, { campaign_id: campaignId, amount: 5 });
    expect(rowOf(pc).hp_current).toBe(max - 3);
    expect(getBattleState(db, campaignId)!.combatants.find((c) => c.id === pc)!.hp_current).toBe(max - 3);

    const synced = combatLog(db, encounterId).filter((entry) => entry.kind === 'sync');
    expect(synced.length).toBeGreaterThan(0);
    expect(synced.every((entry) => entry.target_id === pc)).toBe(true);
  });

  it('does not mirror an engine attack (the engine already updates its own row)', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;

    await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Scimitar',
      roll: { total: 25, natural: null },
      ...REACTION,
    });

    expect(combatLog(db, encounterId).filter((entry) => entry.kind === 'sync')).toHaveLength(0);
  });

  it('kills the combatant and skips its turns when the sheet dies', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc } = ids();

    applyDamage(db, { campaign_id: campaignId, amount: 100, source: 'a falling rock' });
    expect(rowOf(pc).alive).toBe(false);

    for (let i = 0; i < 4; i += 1) {
      expect((await advanceTurn(db, campaignId)).active?.id ?? null).not.toBe(pc);
    }
  });
});

describe('turn state and legal actions', () => {
  it('warns about opportunity attacks when leaving reach', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 3, 5);
    place(enemy[0]!, 4, 5);
    fixRolls(MID_D20);
    const moved = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 1, y: 5 }, ...REACTION });
    expect(moved.opportunity_attack_warning).toHaveLength(1);
    expect(moved.opportunity_attack_warning[0]!.id).toBe(enemy[0]);
    expect(moved.movement_left).toBe(20);
    expect(moved.adjacent_enemies).toHaveLength(0);
  });

  it('warns about the reach the path crossed, not only the one it started in', async () => {
    fixRolls(MID_D20);
    await ambush({ enemies: 2 });
    setMap(Array.from({ length: 10 }, () => '.'.repeat(14)));
    const { pc, enemy } = ids();
    place(pc, 3, 5);
    place(enemy[0]!, 4, 5);
    place(enemy[1]!, 7, 6);

    // Stepping round a foe and ending back in its reach never leaves it.
    const flank = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 5, y: 5 }, ...REACTION });
    expect(flank.opportunity_attack_warning).toHaveLength(0);

    // Walking on past both of them does leave both.
    clearReaction(pc);
    const past = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 9, y: 5 }, ...REACTION });
    expect(past.opportunity_attack_warning.map((w) => w.id).sort()).toEqual([enemy[0]!, enemy[1]!].sort());
  });

  it('arms an empty hand with a proficient unarmed strike', () => {
    const sheet = combatSheet(db, getCharacterSheet(db, campaignId)!.id);
    const strike = sheetActions(sheet).find((a) => a.name === 'Unarmed Strike')!;
    expect(strike.attack_bonus).toBe(5); // +3 STR and +2 proficiency
    expect(strike.damage).toEqual([{ dice: '4', type: 'bludgeoning' }]);

    const weakling = { ...sheet, abilities: { ...sheet.abilities, str: { score: 8, mod: -1 } } };
    const feeble = sheetActions(weakling).find((a) => a.name === 'Unarmed Strike')!;
    expect(feeble.attack_bonus).toBe(1);
    expect(feeble.damage).toEqual([{ dice: '1', type: 'bludgeoning' }]); // never less than 1 damage
  });

  it('lists a fighter with a longsword the actions they can actually take', async () => {
    db.prepare('UPDATE character SET inventory_json = ? WHERE campaign_id = ?').run(
      JSON.stringify([{ name: 'Longsword', qty: 1, equipped: true }]),
      campaignId,
    );
    fixRolls(MID_D20);
    const state = await ambush();
    const combatants = listCombatants(db, state.encounter.id);
    const pc = combatants.find((c) => c.kind === 'pc')!;
    const actions = legalActions(pc, combatSheet(db, pc.character_id!));
    const longsword = actions.find((a) => a.id === 'attack:Longsword')!;
    expect(longsword.label).toBe('Attack: Longsword');
    expect(longsword.hint).toContain('+5 to hit');
    expect(longsword.hint).toContain('1d10+3 slashing'); // versatile, and no shield in the other hand
    expect(actions.map((a) => a.id)).toEqual(
      expect.arrayContaining(['move', 'dash', 'disengage', 'dodge', 'help', 'hide', 'ready', 'utilize']),
    );
    expect(actions.find((a) => a.id === 'move')!.label).toBe('Move (30 ft left)');
  });

  it('renders an ASCII grid with a legend', async () => {
    fixRolls(MID_D20);
    const text = renderBattle(await ambush());
    expect(text).toContain('Terrain: . open, ~ difficult');
    expect(text).toContain('Tokens: upper case = party');
    expect(text).toContain(`B = Borg (party, ${pcHpMax()}/${pcHpMax()} HP, AC 16`);
    expect(text).toContain('g = Goblin Warrior (enemy');
  });
});

describe('combatant views', () => {
  it('carries allow-listed enemy stats and the sheet flags the battle screen shows', async () => {
    createCompanion(db, { campaign_id: campaignId, name: 'Digger', source: { creature: 'Badger' } });
    db.prepare('UPDATE character SET inspiration = 1, exhaustion = 2 WHERE campaign_id = ? AND is_pc = 1').run(campaignId);
    fixRolls(MID_D20);
    const state = await ambush();

    const goblin = state.combatants.find((c) => c.kind === 'monster')!;
    expect(goblin.known).toEqual({
      cr: 0.25,
      type: 'fey',
      size: 'small',
      speed: { walk: 30 },
      senses: ['darkvision 60 ft.'],
      damage_resistances: '',
      damage_immunities: '',
      damage_vulnerabilities: '',
      condition_immunities: '',
    });
    expect(goblin.inspiration).toBeNull();
    expect(goblin.exhaustion).toBeNull();
    expect(goblin).not.toHaveProperty('stat_block');

    const pc = state.combatants.find((c) => c.kind === 'pc')!;
    expect(pc.known).toBeNull();
    expect({ inspiration: pc.inspiration, exhaustion: pc.exhaustion }).toEqual({ inspiration: 1, exhaustion: 2 });

    const digger = state.combatants.find((c) => c.name === 'Digger')!;
    expect(digger.known?.cr).toBe(0);
    expect(digger.known?.damage_resistances).toBe('poison');
    expect(digger.known?.speed).toEqual({ walk: 20, burrow: 5 });
    expect({ inspiration: digger.inspiration, exhaustion: digger.exhaustion }).toEqual({ inspiration: 0, exhaustion: 0 });
  });
});

describe('companions', () => {
  /** A cleric built from a class and a wolf built from a stat block, the two kinds of companion. */
  function companions(): { cleric: number; wolf: number } {
    const cleric = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    }).companion!.id;
    const wolf = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Fang',
      source: { creature: 'Wolf' },
    }).companion!.id;
    return { cleric, wolf };
  }

  const sheetOf = (id: number) => getCharacterSheet(db, campaignId, id)!;

  it('places every active companion and arms them from their sheet or stat block', async () => {
    const { cleric, wolf } = companions();
    fixRolls(MID_D20);
    const state = await ambush();

    const party = state.combatants.filter((c) => c.kind === 'companion');
    expect(party.map((c) => c.name).sort()).toEqual(['Fang', 'Sella']);
    expect(party.every((c) => c.team === 'party')).toBe(true);
    const fang = party.find((c) => c.name === 'Fang')!;
    expect(fang.character_id).toBe(wolf);
    expect({ hp_max: fang.hp_max, ac: fang.ac, speed: fang.speed, size: fang.size }).toEqual({
      hp_max: 11,
      ac: 12,
      speed: 40,
      size: 'M',
    });

    const combatants = listCombatants(db, state.encounter.id);
    const bite = legalActions(combatants.find((c) => c.id === fang.id)!, combatSheet(db, wolf)).find(
      (a) => a.id === 'attack:Bite',
    )!;
    expect(bite.label).toBe('Attack: Bite');
    expect(bite.hint).toContain('+4 to hit');
    expect(bite.hint).toContain('1d6+2 piercing');

    const sellaId = party.find((c) => c.name === 'Sella')!.id;
    const sellaActions = legalActions(combatants.find((c) => c.id === sellaId)!, combatSheet(db, cleric));
    expect(sellaActions.map((a) => a.id)).toContain('attack:Unarmed Strike');
    expect(sellaActions.some((a) => a.id.startsWith('cast:'))).toBe(true);
  });

  it('brings a companion in only once when extra_party names them again', async () => {
    const { wolf } = companions();
    fixRolls(MID_D20);
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
      extra_party: [wolf],
    });
    const state = getBattleState(db, campaignId)!;
    expect(state.combatants.filter((c) => c.name === 'Fang')).toHaveLength(1);
    expect(state.combatants).toHaveLength(4);
  });

  it('writes companion damage, healing and death saves to the character row', async () => {
    const { wolf } = companions();
    fixRolls(MID_D20);
    const state = await ambush();
    const fang = state.combatants.find((c) => c.name === 'Fang')!;
    const { pc, enemy } = ids();

    const bite = async (amount: string): Promise<void> => {
      clearReaction(enemy[0]!);
      await useAction(db, {
        campaign_id: campaignId,
        actor_id: enemy[0]!,
        action_name: 'Bite',
        target_id: fang.id,
        damage_expr: amount,
        damage_type: 'piercing',
        ...REACTION,
      });
    };

    await bite('4');
    expect(sheetOf(wolf).hp_current).toBe(7);
    expect(getBattleState(db, campaignId)!.combatants.find((c) => c.id === fang.id)!.hp_current).toBe(7);

    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Healing word',
      target_id: fang.id,
      heal_expr: '2',
      ...REACTION,
    });
    expect(sheetOf(wolf).hp_current).toBe(9);

    await bite('9');
    const downed = getBattleState(db, campaignId)!.combatants.find((c) => c.id === fang.id)!;
    expect(downed.hp_current).toBe(0);
    expect(downed.conditions).toContain('unconscious');
    expect(sheetOf(wolf).hp_current).toBe(0);
    expect(sheetOf(wolf).conditions).toContain('unconscious');

    // The engine rolls the companion's death saves through character.ts, three failures and it dies.
    let saves = 0;
    for (let i = 0; i < 16; i += 1) {
      const turn = await advanceTurn(db, campaignId);
      saves += turn.log.filter((entry) => entry.kind === 'death_save' && entry.actor_id === fang.id).length;
    }
    expect(saves).toBeGreaterThan(0);
    expect(sheetOf(wolf).status).toBe('dead');
    expect(getBattleState(db, campaignId)!.combatants.find((c) => c.id === fang.id)!.alive).toBe(false);
    expect(campaignSnapshot(db, campaignId).pc!.hp_current).toBe(campaignSnapshot(db, campaignId).pc!.hp_max);
  });

  it('halves damage a stat-block companion resists, reading its anchor feature', async () => {
    const badger = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Digger',
      source: { creature: 'Badger' },
    }).companion!.id;
    fixRolls(MID_D20);
    const state = await ambush();
    const digger = state.combatants.find((c) => c.name === 'Digger')!;
    const { enemy } = ids();

    const result = await useAction(db, {
      campaign_id: campaignId,
      actor_id: enemy[0]!,
      action_name: 'Poison spray',
      target_id: digger.id,
      damage_expr: '4',
      damage_type: 'poison',
      ...REACTION,
    });
    const hit = result.targets[0] as { damage: { applied: number; resistance: string } };
    expect(hit.damage.resistance).toBe('resistant');
    expect(hit.damage.applied).toBe(2);
    expect(sheetOf(badger).hp_current).toBe(3);
  });

  it('mirrors a companion condition onto their sheet', async () => {
    const { wolf } = companions();
    fixRolls(MID_D20);
    const state = await ambush();
    const fang = state.combatants.find((c) => c.name === 'Fang')!;

    setCombatCondition(db, { campaign_id: campaignId, combatant_id: fang.id, condition: 'prone', active: true });
    expect(sheetOf(wolf).conditions).toEqual(['prone']);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: fang.id, condition: 'prone', active: false });
    expect(sheetOf(wolf).conditions).toEqual([]);
  });
});

describe('persistence', () => {
  it('reads an encounter back from the database unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-combat-'));
    const file = join(dir, 'resume.sqlite');
    try {
      const first = openDb(file);
      const id = makeCampaign(first);
      fixRolls(MID_D20);
      await startEncounter(first, {
        campaign_id: id,
        seed: 11,
        terrain: 'ruins',
        enemies: [{ creature: 'Goblin Warrior', count: 2 }],
      });
      const before = getBattleState(first, id)!;
      first.close();

      const second = openDb(file);
      const after = getBattleState(second, id)!;
      expect(after).toEqual(before);
      expect(campaignSnapshot(second, id).encounter!.encounter.id).toBe(before.encounter.id);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suggests XP from the challenge ratings of the enemies that fell', async () => {
    expect(xpForCr(0.25)).toBe(50);
    expect(xpForCr(5)).toBe(1800);
    fixRolls(MID_D20);
    await ambush({ enemies: 2 });
    const { pc, enemy } = ids();
    for (const id of enemy) {
      clearReaction(pc);
      await useAction(db, {
        campaign_id: campaignId,
        actor_id: pc,
        action_name: 'Coup de grace',
        target_id: id,
        damage_expr: '40',
        damage_type: 'slashing',
        ...REACTION,
      });
    }
    const ended = endEncounter(db, { campaign_id: campaignId, outcome: 'victory', summary: 'The goblins fell.' });
    expect(ended.xp_suggestion).toBe(100);
    expect(ended.defeated).toHaveLength(2);
    expect(ended.combatants.find((c) => c.id === pc)!.damage_dealt).toBe(80);
    expect(ended.reminder).toContain('save_checkpoint');
    expect(getBattleState(db, campaignId)).toBeNull();
    expect(campaignSnapshot(db, campaignId).encounter).toBeNull();
  });

  it('counts the damage an effect ticked out in the totals', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: enemy[0]!,
      source_id: pc,
      name: 'on fire',
      kind: 'damage',
      damage_expr: '1d6',
      damage_type: 'fire',
      tick: 'start',
      ends: 'rounds',
      remaining_rounds: 2,
    });
    for (let i = 0; i < 4; i += 1) await advanceTurn(db, campaignId);

    const ended = endEncounter(db, { campaign_id: campaignId, outcome: 'victory' });
    expect(ended.combatants.find((c) => c.id === enemy[0])!.damage_taken).toBe(6);
    expect(ended.combatants.find((c) => c.id === pc)!.damage_dealt).toBe(6);
  });

  it('carries the whole end-of-fight summary in the combat event', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc } = ids();
    const ended = endEncounter(db, { campaign_id: campaignId, outcome: 'retreat' });

    const row = db
      .prepare("SELECT payload_json FROM event WHERE campaign_id = ? AND kind = 'combat' ORDER BY id DESC LIMIT 1")
      .get(campaignId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as {
      tool: string;
      summary: { rounds: number; xp_suggestion: number; defeated: unknown[]; combatants: Array<{ id: number }> };
    };
    expect(payload.tool).toBe('end_encounter');
    expect(payload.summary).toEqual({
      rounds: ended.rounds,
      defeated: ended.defeated,
      xp_suggestion: ended.xp_suggestion,
      combatants: ended.combatants,
    });
    expect(payload.summary.combatants.some((c) => c.id === pc)).toBe(true);
  });

  it('adds a late arrival to the initiative order', async () => {
    fixRolls(MID_D20);
    await ambush();
    const added = await addCombatant(db, { campaign_id: campaignId, creature: 'Wolf', name: 'Grey' });
    expect(added.state.combatants.map((c) => c.name)).toContain('Grey');
    expect(added.state.combatants.map((c) => c.initiative_order).sort()).toEqual([0, 1, 2]);
  });
});

describe('visibility is the player setting', () => {
  it('opens the fight on the campaign setting and follows a toggle mid-fight', async () => {
    updateSettings(db, campaignId, { visibility: 'full' });
    const started = await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    expect(started.state.encounter.visibility).toBe('full');

    updateSettings(db, campaignId, { visibility: 'hidden' });
    expect(getBattleState(db, campaignId)!.encounter.visibility).toBe('hidden');
  });
});

describe('find_position', () => {
  /** An open field with a short wall at x = 8, the PC west of it and one goblin east. */
  async function field(): Promise<{ pc: number; goblin: number }> {
    await ambush();
    setMap(Array.from({ length: 10 }, (_, y) => (y >= 3 && y <= 6 ? '........#.....' : '..............')));
    const { pc, enemy } = ids();
    place(pc, 4, 8);
    place(enemy[0]!, 12, 5);
    giveTurn(pc);
    return { pc, goblin: enemy[0]! };
  }

  it('ranks the cells that give cover from an enemy', async () => {
    const { pc, goblin } = await field();
    const found = findPositions(db, { campaign_id: campaignId, combatant_id: pc, cover_from: goblin });
    expect(found.budget_ft).toBe(30);
    expect(found.reason).toBeNull();
    expect(found.candidates.length).toBeGreaterThan(0);
    for (const cell of found.candidates) {
      expect(cell.cover_from_target).not.toBe('none');
      expect(cell.cost_ft).toBeLessThanOrEqual(30);
      expect(cell.note).toContain('cover from Goblin Warrior');
      expect(cell.distance_ft_to_target).toBe(Math.max(Math.abs(cell.x - 12), Math.abs(cell.y - 5)) * 5);
    }
    const first = found.candidates[0]!;
    expect(first.cover_from_target).toBe('total');
    expect(first.line_of_sight).toBe(false);
  });

  it('keeps the constraints together and says why nothing qualifies', async () => {
    const { pc, goblin } = await field();
    const both = findPositions(db, {
      campaign_id: campaignId,
      combatant_id: pc,
      cover_from: goblin,
      line_of_sight_to: goblin,
      limit: 3,
    });
    expect(both.candidates.length).toBeGreaterThan(0);
    expect(both.candidates.length).toBeLessThanOrEqual(3);
    for (const cell of both.candidates) expect(cell.line_of_sight).toBe(true);

    endEncounter(db, { campaign_id: campaignId, outcome: 'other' });
    await ambush();
    setMap(Array.from({ length: 10 }, () => '..............'));
    const open = ids();
    place(open.pc, 4, 5);
    place(open.enemy[0]!, 12, 5);
    const nothing = findPositions(db, { campaign_id: campaignId, combatant_id: open.pc, cover_from: open.enemy[0]! });
    expect(nothing.candidates).toEqual([]);
    expect(nothing.reason).toContain('cover from Goblin Warrior');
    expect(nothing.reason).toContain('30 ft of movement');
  });

  it('walks move_token to the best cell for the same intent', async () => {
    const { pc, goblin } = await field();
    const best = findPositions(db, { campaign_id: campaignId, combatant_id: pc, cover_from: goblin, limit: 1 })
      .candidates[0]!;
    const moved = moveToken(db, { campaign_id: campaignId, combatant_id: pc, cover_from: goblin });
    expect(moved.position).toEqual({ x: best.x, y: best.y });
    expect(moved.cost_ft).toBe(best.cost_ft);

    expect(() =>
      moveToken(db, { campaign_id: campaignId, combatant_id: pc, adjacent_to_feature: 'nothing like it' }),
    ).toThrow('No cell');
  });
});

describe('tactics between two combatants', () => {
  it('reports distance, sight, cover, reach, range and the walk', async () => {
    await ambush();
    setMap(Array.from({ length: 10 }, () => '..............'));
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 9, 5);
    const far = tacticsBetween(db, campaignId, pc, enemy[0]!);
    expect(far.distance_ft).toBe(40);
    expect(far.line_of_sight).toBe(true);
    expect(far.cover).toBe('none');
    expect(far.in_reach).toBe(false);
    expect(far.path_cost_ft).toBe(35);
    // The goblin carries a shortbow: 40 ft is inside its normal range.
    expect(tacticsBetween(db, campaignId, enemy[0]!, pc).in_range).toEqual({ normal: true, long: true });

    // A wolf has only its bite, so it answers with no range at all.
    const wolf = (await addCombatant(db, { campaign_id: campaignId, creature: 'Wolf', name: 'Grey' })).combatant_id;
    expect(tacticsBetween(db, campaignId, wolf, pc).in_range).toBeNull();

    place(pc, 8, 5);
    const close = tacticsBetween(db, campaignId, pc, enemy[0]!);
    expect(close.in_reach).toBe(true);
    expect(close.path_cost_ft).toBe(0);
  });
});

describe('the hand-set sheet in combat', () => {
  it('fights with the hand-set armour class, at placement and after a mirror', async () => {
    fixRolls(MID_D20);
    const characterId = getCharacterSheet(db, campaignId)!.id;
    setOverrides(db, characterId, { ac: 18 });
    await ambush();
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const { pc } = ids();
    expect(combatSheet(db, characterId).ac).toBe(18);
    expect(listCombatants(db, encounterId).find((c) => c.id === pc)!.ac).toBe(18);

    // A character tool mid-fight mirrors the sheet back, hand-set armour class and all.
    setOverrides(db, characterId, { ac: 12 });
    applyDamage(db, { campaign_id: campaignId, amount: 1 });
    expect(listCombatants(db, encounterId).find((c) => c.id === pc)!.ac).toBe(12);
  });
});

describe('undo_last_combat_action', () => {
  it('takes an attack back, hit points and action flags with it', async () => {
    fixRolls(NAT_20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(pc);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const goblinBefore = listCombatants(db, encounterId).find((c) => c.id === enemy[0])!;

    await attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Greatsword' });
    const hit = listCombatants(db, encounterId);
    expect(hit.find((c) => c.id === enemy[0])!.hp_current).toBeLessThan(goblinBefore.hp_current);
    expect(hit.find((c) => c.id === pc)!.action_used).toBe(true);

    const undone = undoLastCombatAction(db, campaignId);
    expect(undone.undone).toBe('attack');
    expect(undone.log[0]!.kind).toBe('undo');
    expect(undone.log[0]!.text).toContain('attack');
    const after = listCombatants(db, encounterId);
    expect(after.find((c) => c.id === enemy[0])!.hp_current).toBe(goblinBefore.hp_current);
    expect(after.find((c) => c.id === enemy[0])!.alive).toBe(true);
    expect(after.find((c) => c.id === pc)!.action_used).toBe(false);
  });

  it('steps back twice and refuses when there is nothing left to undo', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 6, 5);
    giveTurn(pc);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const start = listCombatants(db, encounterId).find((c) => c.id === pc)!;

    moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 3, y: 5 } });
    const onTurn = getBattleState(db, campaignId)!.turn_index;
    await advanceTurn(db, campaignId);
    const moved = getBattleState(db, campaignId)!;
    expect(moved.combatants.find((c) => c.id === pc)!.x).toBe(3);
    expect(moved.turn_index).not.toBe(onTurn);

    expect(undoLastCombatAction(db, campaignId).undone).toBe('advance_turn');
    expect(getBattleState(db, campaignId)!.turn_index).toBe(onTurn);
    expect(undoLastCombatAction(db, campaignId).undone).toBe('move_token');
    const back = getBattleState(db, campaignId)!.combatants.find((c) => c.id === pc)!;
    expect(back.x).toBe(start.x);
    expect(back.movement_left).toBe(start.movement_left);

    expect(() => undoLastCombatAction(db, campaignId)).toThrow('Nothing to undo');
    endEncounter(db, { campaign_id: campaignId, outcome: 'retreat' });
    expect(() => undoLastCombatAction(db, campaignId)).toThrow('cannot be undone');
  });

  it('puts the character sheet back with the combatant row and says so', async () => {
    fixRolls(NAT_20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(enemy[0]!);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const before = getCharacterSheet(db, campaignId)!;

    await attack(db, { campaign_id: campaignId, attacker_id: enemy[0]!, target_id: pc, action_name: 'Scimitar' });
    expect(getCharacterSheet(db, campaignId)!.hp_current).toBeLessThan(before.hp_current!);
    expect(listCombatants(db, encounterId).find((c) => c.id === pc)!.hp_current).toBeLessThan(before.hp_current!);

    expect(undoLastCombatAction(db, campaignId).undone).toBe('attack');
    expect(getCharacterSheet(db, campaignId)!.hp_current).toBe(before.hp_current);
    expect(listCombatants(db, encounterId).find((c) => c.id === pc)!.hp_current).toBe(before.hp_current);

    const events = db
      .prepare("SELECT text, payload_json FROM event WHERE campaign_id = ? AND kind = 'undo' ORDER BY id")
      .all(campaignId) as Array<{ text: string; payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toContain(`Borg is back at ${before.hp_current}/${before.hp_max} HP`);
    expect(JSON.parse(events[0]!.payload_json)).toMatchObject({ character_id: before.id, tool: 'attack' });
  });

  it('leaves no snapshot and no change behind a refused call', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 8, 5);
    giveTurn(pc);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const undoRows = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM combat_undo WHERE encounter_id = ?').get(encounterId) as { n: number }).n;
    const start = listCombatants(db, encounterId).find((c) => c.id === pc)!;
    const snapshotsBefore = undoRows();

    moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 3, y: 5 } });
    const moved = listCombatants(db, encounterId).find((c) => c.id === pc)!;
    expect(undoRows()).toBe(snapshotsBefore + 1);

    // Refused: the goblin is far out of reach, and a refusal is not something to take back.
    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Greatsword' }),
    ).rejects.toThrow(/reach/);
    expect(() => endEffectById(db, { campaign_id: campaignId, effect_id: 999 })).toThrow(/No effect 999/);
    expect(undoRows()).toBe(snapshotsBefore + 1);
    const after = listCombatants(db, encounterId).find((c) => c.id === pc)!;
    expect({ x: after.x, y: after.y, movement_left: after.movement_left, action_used: after.action_used }).toEqual({
      x: moved.x,
      y: moved.y,
      movement_left: moved.movement_left,
      action_used: moved.action_used,
    });

    // So the one undo there is takes back the move, not a refusal.
    expect(undoLastCombatAction(db, campaignId).undone).toBe('move_token');
    const back = listCombatants(db, encounterId).find((c) => c.id === pc)!;
    expect(back.x).toBe(start.x);
    expect(back.movement_left).toBe(start.movement_left);
    expect(undoRows()).toBe(snapshotsBefore);
  });

  it('keeps the ten snapshots an encounter holds when a call at capacity is refused', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 8, 5);
    giveTurn(pc);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const snapshotIds = (): number[] =>
      (
        db.prepare('SELECT id FROM combat_undo WHERE encounter_id = ? ORDER BY id').all(encounterId) as Array<{
          id: number;
        }>
      ).map((r) => r.id);

    // Past the ten an encounter keeps, so every call after this one is one at capacity.
    for (let i = 0; i < 12; i += 1) {
      applyEffect(db, {
        campaign_id: campaignId,
        target_id: enemy[0]!,
        name: `mark ${i}`,
        kind: 'buff',
        tick: 'start',
        ends: 'manual',
      });
    }
    const full = snapshotIds();
    expect(full).toHaveLength(10);

    expect(() => endEffectById(db, { campaign_id: campaignId, effect_id: 999 })).toThrow(/No effect 999/);
    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Greatsword' }),
    ).rejects.toThrow(/reach/);
    expect(snapshotIds()).toEqual(full);
  });

  it('takes back the fight log lines a refused call had already written', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    giveTurn(pc);
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: enemy[0]!,
      name: 'on fire',
      kind: 'damage',
      damage_expr: '1d6',
      damage_type: 'fire',
      tick: 'start',
      ends: 'rounds',
      remaining_rounds: 3,
    });
    // A damage expression nothing can roll: the turn ends and is logged, then the goblin's tick throws.
    db.prepare("UPDATE effect SET damage_expr = 'wobble' WHERE encounter_id = ?").run(encounterId);
    const lines = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM combat_log WHERE encounter_id = ?').get(encounterId) as { n: number }).n;
    const before = lines();

    await expect(advanceTurn(db, campaignId)).rejects.toThrow(/Invalid dice notation/);
    expect(lines()).toBe(before);
    expect(combatLog(db, encounterId).some((e) => e.kind === 'turn_end')).toBe(false);
  });

  it('sends a reinforcement back where it came from, fight log and all', async () => {
    fixRolls(MID_D20);
    await ambush();
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    const joined = await addCombatant(db, { campaign_id: campaignId, creature: 'Wolf', name: 'Grey' });

    expect(undoLastCombatAction(db, campaignId).undone).toBe('add_combatant');
    const left = listCombatants(db, encounterId);
    expect(left.map((c) => c.name)).not.toContain('Grey');
    // The log keeps the line that named it; only the reference to the row that went is cleared.
    const joinEntry = combatLog(db, encounterId).find((e) => e.kind === 'join')!;
    expect(joinEntry.text).toContain('Grey');
    expect(joinEntry.actor_id).toBeNull();
    expect(joined.combatant_id).toBeGreaterThan(0);
  });

  it('puts a class resource back, so a refused call leaves no use spent behind', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 8, 5);
    giveTurn(pc);
    const characterId = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === pc)!
      .character_id!;
    const used = (): number =>
      combatSheet(db, characterId).features.find((f) => f.mechanics?.resource === 'second_wind')!.mechanics!.used ?? 0;

    applyDamage(db, { campaign_id: campaignId, amount: 5 });
    await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'second_wind' });
    expect(used()).toBe(1);

    // The use rides on the character's own row, and undoing the call has to put that row back too.
    expect(undoLastCombatAction(db, campaignId).undone).toBe('use_action');
    expect(used()).toBe(0);

    // And a call the engine refuses leaves the counter exactly where it found it.
    await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'second_wind' });
    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Greatsword' }),
    ).rejects.toThrow(/reach/);
    expect(used()).toBe(1);
  });
});

describe('the battle text in plain words', () => {
  it('names directions, cover and the nearest feature for every combatant', async () => {
    fixRolls(MID_D20);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 2, 5);
    place(enemy[0]!, 11, 5);
    giveTurn(pc);
    const text = renderBattle(getBattleState(db, campaignId)!);
    expect(text).toContain('Compass: north is up (-y)');
    expect(text).toContain('Borg (B) at 2,5');
    expect(text).toMatch(/Goblin Warrior \(g\) at 11,5 - 45 ft east of Borg/);
    expect(text).toContain('Features: ① Road (open ground)');
  });
});
