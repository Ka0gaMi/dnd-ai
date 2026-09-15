// H2: the clauses the DM writes run at the engine's own hooks. One test per thing that used to be
// remembered by nobody - a rider, a bonus against one kind of creature, a boost on a roll, the
// passives on the sheet, a declared stance, a reminder, the undo, and a magic item's own clause.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  addItem,
  checkModifier,
  createCharacter,
  grantFeature,
  rest,
  spendFeatureResource,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { sheetExtras } from '../src/core/character.js';
import {
  CLAUSE_SUPPORT,
  classifyClause,
  clauseSchema,
  clausesSchema,
  describeClause,
  type ClauseInput,
} from '../src/core/mechanics.js';
import { clauseApplies, type ClauseSheet } from '../src/combat/homebrew.js';
import { CREATURE_TAGS } from '../src/srd/data.js';
import { powerReport, saveHomebrew } from '../src/core/progression.js';
import {
  applyRollBoost,
  createPendingRoll,
  inspirePendingRoll,
  openPendingRolls,
  previewPendingRoll,
  resolvePendingRoll,
  rollBoosts,
  type PendingRollRow,
} from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { advanceTime } from '../src/core/calendar.js';
import { advanceTurn, attack, startEncounter, undoLastCombatAction, useAction } from '../src/combat/engine.js';
import { classFeatures } from '../src/combat/features.js';
import { initiativeBonus, legalActions } from '../src/combat/actions.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { awardXp, levelUp, levelUpOptions } from '../src/core/character.js';
import { XP_THRESHOLDS } from '../src/core/rules.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// CHA 16 plus the background's +1 is the 17 the ability score clause is tried against.
const SORCERER_CANTRIPS = ['Fire Bolt', 'Light', 'Mage Hand', 'Mending'];

const ABILITIES = { str: 14, dex: 14, con: 13, int: 10, wis: 12, cha: 16 };

function skillPicks(cls: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass(cls), findSpecies('Human'))) {
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

/** A character of that class at level 1, with the spells the test needs. */
function make(cls: string, extra: Partial<CreateCharacterInput> = {}): number {
  const data = findClass(cls);
  const casting = data.spellcasting ? classLevelRow(data.index, 1).spellcasting : undefined;
  return createCharacter(db, {
    campaign_id: campaignId,
    name: cls,
    class: cls,
    species: 'Human',
    background: 'Acolyte',
    ability_method: 'manual',
    abilities: ABILITIES,
    ability_bonuses: { cha: 1, wis: 1, int: 1 },
    skill_choices: skillPicks(cls),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
    ...extra,
  } as CreateCharacterInput).character!.id;
}

/** Levels the character up, taking whatever each level asks for. */
function climbTo(characterId: number, level: number): void {
  const owed = XP_THRESHOLDS[level - 1]!;
  awardXp(db, { campaign_id: campaignId, character_id: characterId, amount: owed });
  while (
    (db.prepare('SELECT level FROM character WHERE id = ?').get(characterId) as { level: number }).level < level
  ) {
    const options = levelUpOptions(db, campaignId, characterId) as {
      subclass_choice?: unknown;
      ability_score_improvement?: unknown;
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
      spellcasting?: { cantrips_to_add: number; spells_to_add: number; cantrip_options: string[]; spell_options: Record<string, string[]> };
    };
    const choices: Record<string, unknown> = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = 'Draconic Sorcery';
    if (options.ability_score_improvement) choices.ability_increases = { con: 1, dex: 1 };
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]),
      );
    }
    if (options.spellcasting) {
      choices.cantrips = options.spellcasting.cantrip_options.slice(0, options.spellcasting.cantrips_to_add);
      choices.spells = Object.values(options.spellcasting.spell_options)
        .flat()
        .slice(0, options.spellcasting.spells_to_add);
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices: choices as never });
  }
}

/** Writes the homebrew row and puts the feature it stands for on the sheet. */
function grant(characterId: number, name: string, clauses: ClauseInput[]): number {
  const entry = saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'feature',
    name,
    schema: { name, text: name, clauses: clausesSchema.parse(clauses) },
  });
  grantFeature(db, {
    campaign_id: campaignId,
    character_id: characterId,
    name,
    text: name,
    source: 'homebrew',
    mechanics: { homebrew_id: entry.id },
  });
  return entry.id;
}

const arm = (id: number, items: Array<Record<string, unknown>>): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(JSON.stringify(items), id);
};

async function ambush(enemies: Array<{ creature: string; count: number }>): Promise<void> {
  await startEncounter(db, { campaign_id: campaignId, seed: 7, terrain: 'road', size: 'small', enemies });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  let x = 3;
  for (const c of listCombatants(db, state.encounter.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
}

/** Puts a combatant on a square of the map. */
const place = (who: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, who);
};

/** Writes a spell onto the sheet, for a test that needs one the level-up never offered. */
const knowSpell = (characterId: number, name: string): void => {
  const row = db.prepare('SELECT spells_json FROM character WHERE id = ?').get(characterId) as { spells_json: string };
  const spells = JSON.parse(row.spells_json) as { known?: string[]; prepared?: string[] };
  spells.known = [...(spells.known ?? []), name];
  spells.prepared = [...(spells.prepared ?? []), name];
  db.prepare('UPDATE character SET spells_json = ? WHERE id = ?').run(JSON.stringify(spells), characterId);
};

/** The flat modifier of a rolled expression: "1d20+7" is 7. */
const exprBonus = (expr: string): number => Number(/([+-]\d+)/.exec(expr)?.[1] ?? 0);

/** The bonus the spell attack roll of the first target was made with. */
const spellAttackBonus = (result: unknown): number =>
  exprBonus(
    ((result as { targets: Array<{ attack: { roll: { expr: string } } }> }).targets[0]!.attack.roll.expr),
  );

/** Stands the combatant on the square next to another, so a melee swing can reach it. */
const beside = (who: number, other: Combatant): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(other.x, other.y + 1, who);
};

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (n = 0): Combatant => combatants().filter((c) => c.team === 'enemy')[n]!;
const foeNamed = (name: string): Combatant => combatants().find((c) => c.name.includes(name))!;

/** Gives the combatant their turn back without ending anyone's: the once-a-turn flags stay as they are. */
const resetAction = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

/**
 * A fresh turn for them: the order is walked round until it is theirs again, so the once-a-turn flags
 * are cleared by the engine's own turn edge rather than by the test wiping the row.
 */
const newTurn = async (id: number): Promise<void> => {
  const order = getBattleState(db, campaignId)!.combatants;
  for (let step = 0; step <= order.length; step += 1) {
    await advanceTurn(db, campaignId);
    const state = getBattleState(db, campaignId)!;
    if (state.combatants[state.encounter.turn_index]?.id === id) break;
  }
  resetAction(id);
};

interface FeatureEffect {
  feature: string;
  damage?: number;
  note?: string;
  reminder?: string;
}
const featuresIn = (result: unknown): FeatureEffect[] => (result as { features?: FeatureEffect[] }).features ?? [];
const named = (result: unknown, name: string): FeatureEffect | undefined =>
  featuresIn(result).find((f) => f.feature === name);
/** The card the engine is waiting on right now; the chain moves on a microtask, so give it a moment. */
async function nextAsk(): Promise<PendingRollRow> {
  for (let tries = 0; tries < 100; tries += 1) {
    const open = openPendingRolls(db, campaignId);
    if (open.length > 0) return open[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The engine never asked the player to roll.');
}

/** The boosts a tool reply put on the table. */
const boostsOf = (result: unknown): Array<{ id: string; uses_left: number }> =>
  (result as { boosts_available?: Array<{ id: string; uses_left: number }> }).boosts_available ?? [];

/** The clauses a call handed back rather than running. */
const remindersOf = (result: unknown): Array<{ feature: string; reason: string }> =>
  (result as { reminders?: Array<{ feature: string; reason: string }> }).reminders ?? [];

const logOf = (result: unknown): Array<{ kind: string; text: string }> =>
  (result as { log: Array<{ kind: string; text: string }> }).log;
const texts = (result: unknown): string => logOf(result).map((e) => e.text).join('\n');

const usesOf = (characterId: number, feature: string): { max?: number; used?: number } =>
  (
    JSON.parse(
      (db.prepare('SELECT features_json FROM character WHERE id = ?').get(characterId) as { features_json: string })
        .features_json,
    ) as Array<{ name: string; mechanics?: { max?: number; used?: number } }>
  ).find((f) => f.name === feature)?.mechanics ?? {};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Homebrew',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- 1. a rider on one damage type, once a turn --------------------------------

describe('Forceful Focus', () => {
  const FORCEFUL: ClauseInput[] = [
    {
      when: 'spell_damage',
      if: { damage_type: ['force'] },
      do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
      uses: 'once_per_turn',
    },
  ];

  it('adds its die to a force spell, once a turn, and never to a fire one', async () => {
    const id = make('sorcerer', { spells: ['Magic Missile', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Forceful Focus', FORCEFUL);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Magic Missile',
      spell: 'Magic Missile',
      slot_level: 2,
      target_id: foe().id,
    });
    const rider = named(cast, 'Forceful Focus');
    expect(rider).toBeDefined();
    expect(rider!.damage).toBeGreaterThan(0);
    expect(texts(cast)).toMatch(/Forceful Focus/);

    // A second force spell on the same turn finds the use already spent.
    resetAction(pc().id);
    const again = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Magic Missile',
      spell: 'Magic Missile',
      slot_level: 2,
      target_id: foe().id,
    });
    expect(named(again, 'Forceful Focus')).toBeUndefined();

    // On the next turn it fires again.
    await newTurn(pc().id);
    const next = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Magic Missile',
      spell: 'Magic Missile',
      slot_level: 2,
      target_id: foe().id,
    });
    expect(named(next, 'Forceful Focus')).toBeDefined();

    // Fire Bolt deals fire damage, which the clause never narrows to.
    await newTurn(pc().id);
    const fire = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
      roll: hit,
    });
    expect(named(fire, 'Forceful Focus')).toBeUndefined();
  });

  it('is a clause the engine runs, and check_mechanics says so', async () => {
    expect(classifyClause(clauseSchema.parse(FORCEFUL[0])).status).toBe('runs');
    const client = await connect();
    const result = (await client.callTool({
      name: 'check_mechanics',
      arguments: { campaign_id: campaignId, text: 'When a spell of yours deals force damage, it deals 1d6 more.', clauses: FORCEFUL },
    })) as { content: Array<{ text: string }> };
    const reply = JSON.parse(result.content[0]!.text) as { clauses: Array<{ status: string }> };
    expect(reply.clauses[0]!.status).toBe('runs');
  });
});

// --- 2. a bonus against one kind of creature -----------------------------------

describe('Goblin-Bane', () => {
  it('adds its point against a goblinoid and nothing against a wolf', async () => {
    const id = make('fighter');
    grant(id, 'Goblin-Bane', [
      { when: 'damage_dealt', if: { target: { type: ['goblinoid'] } }, do: [{ kind: 'bonus', to: 'damage', amount: 1 }] },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([
      { creature: 'Goblin Warrior', count: 1 },
      { creature: 'Wolf', count: 1 },
    ]);
    beside(foeNamed('Goblin').id, pc());
    resetAction(pc().id);
    const onGoblin = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foeNamed('Goblin').id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(named(onGoblin, 'Goblin-Bane')?.damage).toBe(1);

    await newTurn(pc().id);
    beside(foeNamed('Wolf').id, pc());
    const onWolf = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foeNamed('Wolf').id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(named(onWolf, 'Goblin-Bane')).toBeUndefined();
  });
});

// --- 3. a proficiency and a boost the player spends ----------------------------

describe('Mystic Investigator', () => {
  const CLAUSES: ClauseInput[] = [
    { when: 'always', do: [{ kind: 'proficiency', skill: 'investigation' }] },
    {
      when: 'roll',
      if: { kind: 'check', skill: ['arcana', 'investigation'] },
      do: [{ kind: 'advantage' }],
      uses: { per: 'long', count: 1 },
      decide: 'ask_before',
    },
  ];

  it('gives the proficiency, offers the boost once, and gets it back on a long rest', () => {
    const id = make('wizard');
    grant(id, 'Mystic Investigator', CLAUSES);

    const investigation = checkModifier(db, campaignId, id, { skill: 'investigation' });
    expect(investigation.proficiency).toBeGreaterThan(0);
    expect(investigation.boosts_available).toHaveLength(1);
    const boostId = investigation.boosts_available![0]!.id;
    expect(investigation.boosts_available![0]!.uses_left).toBe(1);
    // The same boost is on an Arcana check, and on no Stealth check at all.
    expect(checkModifier(db, campaignId, id, { skill: 'arcana' }).boosts_available).toHaveLength(1);
    expect(checkModifier(db, campaignId, id, { skill: 'stealth' }).boosts_available).toBeUndefined();

    const pending = createPendingRoll(db, {
      campaign_id: campaignId,
      character_id: id,
      expr: `1d20+${investigation.total_modifier}`,
      purpose: 'Investigation check',
      roll_type: 'check',
      boosts_available: investigation.boosts_available,
    });
    const boosted = applyRollBoost(db, pending.id, boostId);
    expect(boosted.advantage).toBe('advantage');
    expect(boosted.boosts_chosen).toEqual([boostId]);
    // Nothing is spent until the roll stands.
    expect(checkModifier(db, campaignId, id, { skill: 'arcana' }).boosts_available![0]!.uses_left).toBe(1);

    const rolled = resolvePendingRoll(db, pending.id);
    expect(rolled.expr).toMatch(/2d20kh1/);
    expect(checkModifier(db, campaignId, id, { skill: 'investigation' }).boosts_available).toBeUndefined();

    rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(checkModifier(db, campaignId, id, { skill: 'investigation' }).boosts_available).toHaveLength(1);
  });
});

describe('a boost in a fight', () => {
  it('is offered on the attack, applied when the DM names it, and spent there', async () => {
    const id = make('fighter');
    grant(id, "Hunter's Certainty", [
      {
        when: 'roll',
        if: { kind: 'attack' },
        do: [{ kind: 'advantage' }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foeNamed('Goblin').id, pc());
    resetAction(pc().id);
    const plain = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foeNamed('Goblin').id,
      action_name: 'Longsword',
      roll: hit,
    });
    const offered = (plain as { boosts_available?: Array<{ id: string; uses_left: number }> }).boosts_available;
    expect(offered).toHaveLength(1);
    expect(plain.advantage).toBe('none');

    await newTurn(pc().id);
    const boosted = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foeNamed('Goblin').id,
      action_name: 'Longsword',
      roll: hit,
      boosts: [offered![0]!.id],
    });
    expect(boosted.advantage).toBe('advantage');
    expect(usesOf(id, "Hunter's Certainty").used).toBe(1);
    // Spent: it is no longer on offer, and asking for it again is refused.
    await newTurn(pc().id);
    await expect(
      attack(db, {
        campaign_id: campaignId,
        attacker_id: pc().id,
        target_id: foeNamed('Goblin').id,
        action_name: 'Longsword',
        roll: hit,
        boosts: [offered![0]!.id],
      }),
    ).rejects.toThrow(/no boost/i);
  });
});

// --- 4. the passives ------------------------------------------------------------

describe('the always clauses', () => {
  it('puts the armour class, the speed, the resistance and the ability score on the sheet', async () => {
    const id = make('fighter');
    const plainAc = (db.prepare('SELECT ac FROM character WHERE id = ?').get(id) as { ac: number }).ac;
    grant(id, 'Warded Step', [
      { when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 1 }] },
      { when: 'always', do: [{ kind: 'resistance', types: ['fire'] }] },
      { when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] },
      { when: 'always', do: [{ kind: 'asi', ability: 'cha', amount: 1 }] },
    ]);
    const before = combatSheet(db, id);
    const bare = (db.prepare('SELECT ac, speed FROM character WHERE id = ?').get(id) as { ac: number; speed: number });
    // One source: the clause armour class is worked into the column, and the combat sheet reads it.
    expect(before.ac).toBe(bare.ac);
    expect(before.ac).toBe(plainAc + 1);
    expect(before.speed).toBe(bare.speed + 10);
    expect(before.resistances).toContain('fire');
    // CHA 17 plus the clause is 18, and no clause takes a score past 20.
    expect(before.abilities.cha!.score).toBe(18);

    const extras = sheetExtras(db, campaignId, id);
    expect(extras.ac_breakdown.total).toBe(plainAc + 1);
    expect(extras.speed).toBe(bare.speed + 10);

    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(foe().id);
    const burned = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'Gout of Flame',
      target_id: pc().id,
      damage_expr: '10',
      damage_type: 'fire',
    });
    expect(texts(burned)).toMatch(/resist/i);
    expect((burned as { targets: Array<{ damage: { applied: number } }> }).targets[0]!.damage.applied).toBe(5);
  });

  it('caps an ability score increase at 20', () => {
    const id = make('fighter');
    db.prepare('UPDATE character SET abilities_json = ? WHERE id = ?').run(
      JSON.stringify({ ...combatSheet(db, id).abilities, cha: { score: 20, mod: 5 } }),
      id,
    );
    grant(id, 'Overreach', [{ when: 'always', do: [{ kind: 'asi', ability: 'cha', amount: 2 }] }]);
    expect(combatSheet(db, id).abilities.cha!.score).toBe(20);
  });
});

// --- 5. a stance declared before the roll ---------------------------------------

describe('an ask_after clause', () => {
  it('is declared like a d20 stance and spent only when it fires', async () => {
    const id = make('fighter');
    grant(id, 'Second Thought', [
      {
        when: 'roll',
        if: { kind: 'save' },
        do: [{ kind: 'reroll', keep: 'new' }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_after',
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);
    const sheet = combatSheet(db, pc().character_id!);
    const declare = classFeatures(sheet).find((f) => f.name.startsWith('Second Thought'));
    expect(declare).toBeDefined();
    const actionId = `homebrew_${grantedId(id)}_0_declare`;
    const armed = await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: actionId });
    expect((armed as { d20_stance?: { feature: string } }).d20_stance?.feature).toBe('Second Thought');
    expect(pc().flags.d20_stance?.on).toEqual(['save']);
    // Declared, not spent: the use waits for the roll it was bought for.
    expect(usesOf(id, 'Second Thought').used ?? 0).toBe(0);
  });
});

/** The homebrew row id behind the one clause feature the character holds. */
function grantedId(characterId: number): number {
  const features = JSON.parse(
    (db.prepare('SELECT features_json FROM character WHERE id = ?').get(characterId) as { features_json: string })
      .features_json,
  ) as Array<{ mechanics?: { homebrew_id?: number } }>;
  return features.find((f) => f.mechanics?.homebrew_id !== undefined)!.mechanics!.homebrew_id!;
}

// --- 6. the reminder ------------------------------------------------------------

describe('a clause the engine cannot judge', () => {
  it('reminds at the hook and does nothing else', async () => {
    const id = make('fighter');
    grant(id, 'Gloomstrike', [
      { when: 'hit', if: { light: 'dim' }, do: [{ kind: 'extra_damage', dice: '1d6', type: 'necrotic' }] },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    const reminders = (swing as { reminders?: Array<{ feature: string; reason: string }> }).reminders;
    expect(reminders).toHaveLength(1);
    expect(reminders![0]!.feature).toBe('Gloomstrike');
    expect(reminders![0]!.reason).toMatch(/light/i);
    expect(logOf(swing).some((entry) => entry.kind === 'reminder')).toBe(true);
    // Nothing was applied: no extra damage rode on the swing.
    expect(named(swing, 'Gloomstrike')?.damage).toBeUndefined();
  });
});

// --- 7. the undo ----------------------------------------------------------------

describe('undo', () => {
  it('gives back a use a clause spent during the call', async () => {
    const id = make('sorcerer', { spells: ['Magic Missile', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Arcane Surge', [
      {
        when: 'spell_damage',
        do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
        uses: { per: 'long', count: 2 },
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Magic Missile',
      spell: 'Magic Missile',
      slot_level: 2,
      target_id: foe().id,
    });
    expect(usesOf(id, 'Arcane Surge').used).toBe(1);
    undoLastCombatAction(db, campaignId);
    expect(usesOf(id, 'Arcane Surge').used ?? 0).toBe(0);
  });
});

// --- 8. a magic item's own clause ------------------------------------------------

describe('a worn magic item', () => {
  const CLOAK = (attuned: boolean) => [
    {
      name: 'Cloak of the Northern Wind',
      qty: 1,
      equipped: true,
      magic: {
        rarity: 'rare',
        attunement: true,
        attuned,
        identified: true,
        mechanics: { clauses: clausesSchema.parse([{ when: 'always', do: [{ kind: 'resistance', types: ['cold'] }] }]) },
      },
    },
  ];

  it('gives what its clauses say only while it is worn and attuned', () => {
    const id = make('fighter');
    arm(id, CLOAK(true));
    expect(combatSheet(db, id).resistances).toContain('cold');

    arm(id, CLOAK(false));
    expect(combatSheet(db, id).resistances).not.toContain('cold');

    arm(id, [{ ...CLOAK(true)[0]!, equipped: false }]);
    expect(combatSheet(db, id).resistances).not.toContain('cold');
  });
});

// --- 9/10. the language ----------------------------------------------------------

describe('the new verbs', () => {
  it('prices an extra action at two feats and reads a scaling die', () => {
    expect(powerReport({ clauses: clausesSchema.parse([{ when: 'action', do: [{ kind: 'extra_action' }] }]) }).budget_used).toBe(2);
    const scaling = clauseSchema.parse({
      when: 'action',
      do: [{ kind: 'bonus', to: 'heal', amount: '1d10+level' }],
      uses: { per: 'short', count: 2 },
    });
    expect(describeClause(scaling)).toMatch(/1d10 \+ your level/);
    expect(() =>
      clauseSchema.parse({ when: 'cast', do: [{ kind: 'bonus', to: 'spell_save_dc', amount: 1 }] }),
    ).not.toThrow();
  });
});

// --- 11. the SRD creature tags --------------------------------------------------

describe('a clause narrowed to a kind of creature', () => {
  const BARE: ClauseSheet = { level: 1, proficiency_bonus: 2, abilities: {}, features: [], inventory: [] };
  const stands = (name: string, type: string): Combatant =>
    ({ name, stat_block: { type }, conditions: [], flags: {}, hp_current: 10, hp_max: 10 }) as unknown as Combatant;
  const matches = (types: string[], target: Combatant): boolean =>
    clauseApplies(
      clauseSchema.parse({ when: 'hit', if: { target: { type: types } }, do: [{ kind: 'bonus', to: 'damage', amount: 1 }] }),
      { sheet: BARE, target },
    ).ok;

  it('matches the stat block type and the SRD tag table, and nothing that merely sounds alike', () => {
    // The tag: a Goblin Warrior and a Hobgoblin Warrior are Fey (Goblinoid) in the 2024 stat blocks.
    expect(matches(['goblinoid'], stands('Goblin Warrior', 'fey'))).toBe(true);
    expect(matches(['goblinoid'], stands('Hobgoblin Warrior', 'fey'))).toBe(true);
    expect(matches(['goblinoid'], stands('Wolf', 'beast'))).toBe(false);
    // Two of a kind on the field are numbered; the tag still finds them.
    expect(matches(['goblinoid'], stands('Goblin Warrior 2', 'fey'))).toBe(true);

    // The type, exactly: a Giant Ape is a Beast, whatever its name begins with.
    expect(matches(['giant'], stands('Giant Ape', 'beast'))).toBe(false);
    expect(matches(['giant'], stands('Hill Giant', 'giant'))).toBe(true);
    // A Dragonborn companion has no stat block type at all, and is not a Dragon.
    expect(matches(['dragon'], stands('Rowan the Dragonborn', ''))).toBe(false);
    expect(matches(['dragon'], stands('Young Red Dragon', 'dragon'))).toBe(true);

    expect(CREATURE_TAGS.goblinoid).toContain('Bugbear Stalker');
  });
});

// --- 12. a use no rest gives back -----------------------------------------------

describe('once_ever', () => {
  it('stays spent through a long rest', () => {
    const id = make('fighter');
    grant(id, 'Last Word', [
      { when: 'roll', if: { kind: 'save' }, do: [{ kind: 'bonus', to: 'save', amount: 5 }], uses: 'once_ever' },
    ]);
    const before = checkModifier(db, campaignId, id, { save: 'wis' });
    expect(before.feature_bonus).toBe(5);

    spendFeatureResource(db, {
      campaign_id: campaignId,
      character_id: id,
      resource: `homebrew:${grantedId(id)}:0`,
      label: 'Last Word',
      max: 1,
      per: 'never',
    });
    expect(checkModifier(db, campaignId, id, { save: 'wis' }).feature_bonus).toBe(0);

    rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(usesOf(id, 'Last Word').used).toBe(1);
    expect(checkModifier(db, campaignId, id, { save: 'wis' }).feature_bonus).toBe(0);
  });
});

// --- 13. the save and the expertise the sheet was dropping ----------------------

describe('the passives the sheet used to drop', () => {
  it('puts a save proficiency on the combat sheet and doubles an expertise with no proficiency under it', () => {
    const id = make('fighter');
    const plain = combatSheet(db, id);
    grant(id, 'Warded Mind', [
      { when: 'always', do: [{ kind: 'proficiency', save: 'wis' }] },
      { when: 'always', do: [{ kind: 'expertise', skill: 'arcana' }] },
    ]);
    const sheet = combatSheet(db, id);
    expect(sheet.saves.wis!.proficient).toBe(true);
    expect(sheet.saves.wis!.bonus).toBe(plain.saves.wis!.bonus + sheet.proficiency_bonus);
    // The DM wrote Expertise: the proficiency comes with it, and then it is doubled.
    const arcana = plain.skills.arcana;
    const bare = (arcana?.bonus ?? 0) - (arcana?.proficient ? plain.proficiency_bonus : 0);
    expect(sheet.skills.arcana!.bonus).toBe(bare + sheet.proficiency_bonus * 2);
    expect(checkModifier(db, campaignId, id, { save: 'wis' }).proficiency).toBe(sheet.proficiency_bonus);
  });
});

// --- 14. what a roll outside a fight can and cannot judge ------------------------

describe('a check made outside a fight', () => {
  it('applies what it can match, reminds about what it cannot, and never misses a capital letter', () => {
    const id = make('wizard');
    grant(id, 'Lamplight Lore', [
      // The skill is written the way the DM wrote it, capital and all.
      { when: 'roll', if: { kind: 'check', skill: ['Investigation'] }, do: [{ kind: 'bonus', to: 'check', amount: 'prof' }] },
      { when: 'roll', if: { kind: 'check', light: 'dim' }, do: [{ kind: 'advantage' }] },
    ]);
    const investigation = checkModifier(db, campaignId, id, { skill: 'investigation' });
    expect(investigation.feature_bonus).toBe(investigation.proficiency > 0 ? 2 : 2);
    expect(investigation.feature_note).toMatch(/Lamplight Lore/);
    // The dim-light clause is handed back, never applied.
    expect(investigation.feature_advantage).toBeUndefined();
    expect(investigation.reminders?.map((one) => one.reason).join(' ')).toMatch(/light/i);

    // A different skill gets neither the bonus nor a claim that it did.
    expect(checkModifier(db, campaignId, id, { skill: 'stealth' }).feature_bonus).toBe(0);
  });

  it('hands back a clause whose narrowing only a fight can answer', () => {
    const id = make('fighter');
    grant(id, 'Bane of the Boss', [
      {
        when: 'roll',
        if: { kind: 'check', target: { type: ['goblinoid'] } },
        do: [{ kind: 'bonus', to: 'check', amount: 2 }],
      },
    ]);
    const rolled = checkModifier(db, campaignId, id, { skill: 'perception' });
    expect(rolled.feature_bonus).toBe(0);
    expect(rolled.reminders?.[0]!.reason).toMatch(/target/i);
  });
});

// --- 15. the passive check --------------------------------------------------------

describe('a passive check', () => {
  it('takes the 2024 +5 from a clause that gives the check Advantage', async () => {
    const id = make('wizard');
    grant(id, 'Ever Watchful', [
      { when: 'roll', if: { kind: 'check', skill: ['perception'] }, do: [{ kind: 'advantage' }] },
    ]);
    const client = await connect();
    const result = (await client.callTool({
      name: 'roll',
      arguments: { campaign_id: campaignId, purpose: 'Passive Perception', skill: 'perception', passive: true, character_id: id },
    })) as { content: Array<{ text: string }> };
    const reply = JSON.parse(result.content[0]!.text) as { total: number; advantage: string; modifier: { total_modifier: number } };
    expect(reply.advantage).toBe('advantage');
    expect(reply.total).toBe(10 + reply.modifier.total_modifier + 5);
  });
});

// --- 16. a rationed rider on an area spell --------------------------------------

describe('a limited-use rider on a spell with two targets', () => {
  it('fires once, on the first target, and the cast is not refused by the second', async () => {
    const id = make('sorcerer', { spells: ['Magic Missile', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    knowSpell(id, 'Burning Hands');
    grant(id, 'Ember Rider', [
      {
        when: 'spell_damage',
        do: [{ kind: 'extra_damage', dice: '1d6', type: 'fire' }],
        uses: { per: 'long', count: 1 },
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 2 }]);
    place(pc().id, 1, 5);
    const goblins = combatants().filter((c) => c.team === 'enemy');
    place(goblins[0]!.id, 2, 5);
    place(goblins[1]!.id, 3, 5);
    resetAction(pc().id);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Burning Hands',
      spell: 'Burning Hands',
      slot_level: 1,
      point: { x: 3, y: 5 },
    });
    expect((cast as { targets: unknown[] }).targets.length).toBeGreaterThan(1);
    // One rider, on the first creature the spell damaged, and one use gone.
    expect(featuresIn(cast).filter((f) => f.feature === 'Ember Rider' && f.damage !== undefined)).toHaveLength(1);
    expect(usesOf(id, 'Ember Rider').used).toBe(1);
  });
});

// --- 17. the bonuses a roll clause puts on the roll ------------------------------

describe('a clause that adds to a roll', () => {
  it('puts the legacy to_hit on the attack expression and names itself', async () => {
    const id = make('fighter');
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const plain = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
    });

    // The old flat field, read as a clause: +1 on every attack roll.
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Steady Hand',
      schema: { name: 'Steady Hand', text: 'Steady Hand', mechanics: { to_hit: 1 } },
    });
    grantFeature(db, {
      campaign_id: campaignId,
      character_id: id,
      name: 'Steady Hand',
      text: 'Steady Hand',
      source: 'homebrew',
      mechanics: { homebrew_id: entry.id },
    });

    await newTurn(pc().id);
    const steadier = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
    });
    expect(exprBonus(steadier.roll.expr)).toBe(exprBonus(plain.roll.expr) + 1);
    expect(steadier.notes.join(' ')).toMatch(/Steady Hand/);
  });

  it('adds its points to the damage of a hit', async () => {
    const id = make('fighter');
    grant(id, 'Heavy Hand', [{ when: 'hit', do: [{ kind: 'bonus', to: 'damage', amount: 2 }] }]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(named(swing, 'Heavy Hand')?.damage).toBe(2);
  });

  it('raises a spell attack roll', async () => {
    const id = make('sorcerer', { spells: ['Magic Missile', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);
    const plain = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
    });

    grant(id, 'Focused Aim', [
      { when: 'cast', do: [{ kind: 'bonus', to: 'spell_attack', amount: 1 }] },
    ]);
    await newTurn(pc().id);
    const sharper = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
    });
    expect(spellAttackBonus(sharper)).toBe(spellAttackBonus(plain) + 1);
  });
});

// --- 18. one more action ---------------------------------------------------------

describe('extra_action', () => {
  it('gives the turn its action back, the way Action Surge does', async () => {
    const id = make('fighter');
    grant(id, 'Second Surge', [
      { when: 'action', do: [{ kind: 'extra_action' }], uses: { per: 'long', count: 1 } },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(pc().action_used).toBe(true);

    await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: `homebrew_${grantedId(id)}_0` });
    expect(pc().action_used).toBe(false);
    const again = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(again.hit).toBe(true);
    expect(usesOf(id, 'Second Surge').used).toBe(1);
  });
});

// --- 19. the always verbs the sheet used to drop ----------------------------------

describe('the always verbs', () => {
  it('trains the holder in a weapon the class never taught them', async () => {
    const id = make('wizard');
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    expect(combatSheet(db, id).proficiencies.weapons).not.toContain('Longsword');
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const unskilled = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
    });

    grant(id, 'Bladesinger Lite', [{ when: 'always', do: [{ kind: 'proficiency', weapon: 'Longsword' }] }]);
    const sheet = combatSheet(db, id);
    expect(sheet.proficiencies.weapons).toContain('Longsword');
    await newTurn(pc().id);
    const trained = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
    });
    // The proficiency bonus rides on the swing now, which is the whole of what the clause bought.
    expect(exprBonus(trained.roll.expr)).toBe(exprBonus(unskilled.roll.expr) + sheet.proficiency_bonus);
  });

  it('puts a granted cantrip in the actions the fight offers', async () => {
    const id = make('fighter');
    grant(id, 'Spark of Magic', [{ when: 'always', do: [{ kind: 'cantrip_known', name: 'Fire Bolt' }] }]);
    expect(combatSheet(db, id).spells.cantrips).toContain('Fire Bolt');
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);
    expect(legalActions(pc(), combatSheet(db, id)).some((a) => a.id === 'cast:Fire Bolt')).toBe(true);
  });

  it('applies an armour class clause only while the armour is on', () => {
    const id = make('fighter');
    arm(id, []);
    const bare = sheetExtras(db, campaignId, id).ac_breakdown.total;
    grant(id, 'Plated Ward', [
      { when: 'always', if: { self: { wearing: 'armor' } }, do: [{ kind: 'bonus', to: 'ac', amount: 2 }] },
    ]);
    expect(sheetExtras(db, campaignId, id).ac_breakdown.total).toBe(bare);

    arm(id, [{ name: 'Leather Armor', qty: 1, equipped: true }]);
    const armoured = sheetExtras(db, campaignId, id).ac_breakdown;
    expect(armoured.total).toBeGreaterThanOrEqual(bare + 2);
    expect(armoured.notes.join(' ')).toMatch(/homebrew/);
  });

  it('hands back the hit points it cannot write, once per sheet read', () => {
    const id = make('fighter');
    grant(id, 'Iron Constitution', [
      { when: 'always', do: [{ kind: 'hp_per_level', amount: 2 }] },
      { when: 'always', do: [{ kind: 'bonus', to: 'hp_max', amount: 5 }] },
    ]);
    const reasons = combatSheet(db, id).clause_reminders.map((one) => one.reason).join(' ');
    expect(reasons).toMatch(/hit point/i);
    expect(combatSheet(db, id).clause_reminders).toHaveLength(2);
  });
});

// --- 20. the choice made before the swing ----------------------------------------

describe('an ask_before rider', () => {
  const FORCEFUL: ClauseInput[] = [
    {
      when: 'spell_damage',
      do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
      uses: { per: 'long', count: 1 },
      decide: 'ask_before',
    },
  ];

  it('is offered before the casting, costs nothing on a miss and is spent when it lands', async () => {
    const id = make('sorcerer', { spells: ['Magic Missile', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Forceful Focus', FORCEFUL);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);

    // Nothing is applied unless it is taken, and the reply says it is on the table.
    const unchosen = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
      roll: hit,
    });
    const offered = boostsOf(unchosen);
    expect(offered.map((one) => one.id)).toContain(`homebrew:${grantedId(id)}:0`);
    expect(named(unchosen, 'Forceful Focus')?.damage).toBeUndefined();

    // Taken and missed: the rider never lands, so the use is still there.
    await newTurn(pc().id);
    const missed = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
      roll: { total: 2, natural: 1 },
      boosts: [offered[0]!.id],
    });
    expect(missed).toBeDefined();
    expect(usesOf(id, 'Forceful Focus').used ?? 0).toBe(0);

    // Taken and landed: the rider rides on the hit and the use goes with it.
    await newTurn(pc().id);
    const landed = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
      roll: hit,
      boosts: [offered[0]!.id],
    });
    expect(named(landed, 'Forceful Focus')?.damage).toBeGreaterThan(0);
    expect(usesOf(id, 'Forceful Focus').used).toBe(1);
  });
});

// --- 21. an automatic clause with uses fires by itself ----------------------------

describe('an auto clause with uses', () => {
  it('applies itself and pays for itself, and stops when the uses run out', async () => {
    const id = make('fighter');
    grant(id, 'Sure Strike', [
      { when: 'roll', if: { kind: 'attack' }, do: [{ kind: 'advantage' }], uses: { per: 'long', count: 1 } },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const first = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(first.advantage).toBe('advantage');
    expect(usesOf(id, 'Sure Strike').used).toBe(1);
    // It was never on offer as a boost: decision 1 says an automatic clause is not the player's to take.
    expect(boostsOf(first)).toHaveLength(0);

    await newTurn(pc().id);
    const second = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(second.advantage).toBe('none');
    expect(usesOf(id, 'Sure Strike').used).toBe(1);
  });
});

// --- 22. the crit range -----------------------------------------------------------

describe('crit_range', () => {
  it('widens the range when nothing narrows it', async () => {
    const id = make('fighter');
    grant(id, 'Keen Edge', [{ when: 'always', do: [{ kind: 'crit_range', min: 19 }] }]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: { total: 30, natural: 19 },
    });
    expect(swing.critical).toBe(true);
  });

  it('reminds instead when the clause narrows or rations it', async () => {
    const id = make('fighter');
    grant(id, 'Undead Bane', [
      { when: 'always', if: { target: { type: ['undead'] } }, do: [{ kind: 'crit_range', min: 19 }] },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: { total: 30, natural: 19 },
    });
    expect(swing.critical).toBe(false);
    expect(remindersOf(swing).map((one) => one.reason).join(' ')).toMatch(/crit range/i);
  });
});

// --- 23. how long a condition stays on --------------------------------------------

describe('a condition a rider leaves', () => {
  it('runs the rounds the clause named', async () => {
    const id = make('fighter');
    grant(id, 'Rattling Blow', [
      { when: 'hit', do: [{ kind: 'condition', name: 'frightened', until: 'rounds', rounds: 3 }] },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    const effect = db
      .prepare("SELECT ends, remaining_rounds FROM effect WHERE name = 'frightened' ORDER BY id DESC")
      .get() as { ends: string; remaining_rounds: number } | undefined;
    expect(effect).toMatchObject({ ends: 'rounds', remaining_rounds: 3 });
  });

  it('hands a save-ends duration back rather than inventing one', async () => {
    const id = make('fighter');
    grant(id, 'Creeping Venom', [
      { when: 'hit', do: [{ kind: 'condition', name: 'poisoned', until: 'save_ends' }] },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(remindersOf(swing).map((one) => one.reason).join(' ')).toMatch(/save-ends/i);
    expect(foe().conditions).not.toContain('poisoned');
  });
});

// --- 24. a subclass bundle ---------------------------------------------------------

describe('a homebrew subclass bundle', () => {
  it('gives the level it was granted at, once, and none of the other levels', () => {
    const id = make('fighter');
    const plainAc = (db.prepare('SELECT ac, speed FROM character WHERE id = ?').get(id) as { ac: number; speed: number });
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'subclass',
      name: 'Order of the Bulwark',
      schema: {
        name: 'Order of the Bulwark',
        features: {
          '3': [
            {
              name: 'Bulwark Stance',
              text: 'Bulwark Stance',
              clauses: clausesSchema.parse([{ when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 1 }] }]),
            },
          ],
          '6': [
            {
              name: 'Bulwark Stride',
              text: 'Bulwark Stride',
              clauses: clausesSchema.parse([{ when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] }]),
            },
          ],
        },
      },
    });
    // The sheet at level 3 holds only the level 3 feature, pointing at the bundle it came from.
    const features = [
      ...(JSON.parse(
        (db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string })
          .features_json,
      ) as Array<Record<string, unknown>>),
      { name: 'Bulwark Stance', source: 'subclass', text: 'Bulwark Stance', mechanics: { homebrew_id: entry.id } },
    ];
    db.prepare('UPDATE character SET features_json = ?, subclass_homebrew_id = ? WHERE id = ?').run(
      JSON.stringify(features),
      entry.id,
      id,
    );

    const sheet = combatSheet(db, id);
    // +1 once, and not the level 6 feet: the other levels of the bundle are not on this sheet.
    expect(sheetExtras(db, campaignId, id).ac_breakdown.total).toBe(plainAc.ac + 1);
    expect(sheet.speed).toBe(plainAc.speed);
  });
});


// --- 25. what the reply says is left ----------------------------------------------

describe('boosts_available', () => {
  it('counts what the call has already spent', async () => {
    const id = make('fighter');
    grant(id, 'Twice Sure', [
      {
        when: 'roll',
        if: { kind: 'attack' },
        do: [{ kind: 'advantage' }],
        uses: { per: 'long', count: 2 },
        decide: 'ask_before',
      },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const key = `homebrew:${grantedId(id)}:0`;
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
      boosts: [key],
    });
    expect(swing.advantage).toBe('advantage');
    // One spent in this very call, so the reply offers one - not the two it started with.
    expect(boostsOf(swing).find((one) => one.id === key)?.uses_left).toBe(1);
  });
});

// --- 26. the boost on the player's own card ----------------------------------------

describe('a boost on the roll card', () => {
  it('is offered in a fight, applied when the player takes it, spent once, and given back by undo', async () => {
    const id = make('fighter');
    grant(id, 'Steady Nerve', [
      {
        when: 'roll',
        if: { kind: 'attack' },
        do: [{ kind: 'advantage' }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    updateSettings(db, campaignId, { roll_mode: 'player', player_rolls: 'd20_only' });

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
    });
    const card = await nextAsk();
    const offered = rollBoosts(card).boosts_available;
    expect(offered.map((one) => one.id)).toEqual([`homebrew:${grantedId(id)}:0`]);

    const boosted = applyRollBoost(db, card.id, offered[0]!.id);
    expect(boosted.advantage).toBe('advantage');
    resolvePendingRoll(db, card.id);
    await running;

    // The engine spent it, inside its own snapshot - not the roll path.
    expect(usesOf(id, 'Steady Nerve').used).toBe(1);
    undoLastCombatAction(db, campaignId);
    expect(usesOf(id, 'Steady Nerve').used ?? 0).toBe(0);
  });
});

// --- 27. a boost on a spell attack --------------------------------------------------

describe('a boost on a casting', () => {
  it('is offered on use_action with the casting ctx, applied to the spell attack and spent there', async () => {
    const id = make('sorcerer', { spells: ['Magic Missile', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Arcane Certainty', [
      {
        when: 'roll',
        if: { kind: 'attack' },
        do: [{ kind: 'advantage' }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    // Well out of reach: a crowded shot would put Disadvantage on the bolt and cancel the boost.
    place(pc().id, 2, 5);
    place(foe().id, 20, 5);
    resetAction(pc().id);
    const key = `homebrew:${grantedId(id)}:0`;

    const plain = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
    });
    // The casting is an attack roll, so the attack clause is on the table here.
    expect(boostsOf(plain).map((one) => one.id)).toContain(key);

    await newTurn(pc().id);
    const boosted = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe().id,
      boosts: [key],
    });
    const shot = (boosted as unknown as { targets: Array<{ attack: { advantage: string } }> }).targets[0]!;
    expect(shot.attack.advantage).toBe('advantage');
    expect(usesOf(id, 'Arcane Certainty').used).toBe(1);
    expect(boostsOf(boosted).map((one) => one.id)).not.toContain(key);
  });
});

// --- 28. Heroic Inspiration keeps the boost it was rolled with ------------------------

describe('a boost on a roll the player rerolls', () => {
  it('is spent even when Heroic Inspiration takes the second roll', () => {
    const id = make('wizard');
    grant(id, 'Mystic Investigator', [
      {
        when: 'roll',
        if: { kind: 'check', skill: ['arcana'] },
        do: [{ kind: 'advantage' }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    db.prepare('UPDATE character SET inspiration = 1 WHERE id = ?').run(id);
    updateSettings(db, campaignId, { cheat_mode: true });
    const modifier = checkModifier(db, campaignId, id, { skill: 'arcana' });
    const pending = createPendingRoll(db, {
      campaign_id: campaignId,
      character_id: id,
      expr: `1d20+${modifier.total_modifier}`,
      purpose: 'Arcana check',
      roll_type: 'check',
      boosts_available: modifier.boosts_available,
    });
    applyRollBoost(db, pending.id, modifier.boosts_available![0]!.id);
    previewPendingRoll(db, pending.id);
    inspirePendingRoll(db, pending.id);
    expect(usesOf(id, 'Mystic Investigator').used).toBe(1);
    expect(checkModifier(db, campaignId, id, { skill: 'arcana' }).boosts_available).toBeUndefined();
  });
});

// --- 29. the armour class stays one number -------------------------------------------

describe('a clause that gives Armor Class', () => {
  it('is counted once, in the column and on the combat sheet, and survives a change of gear', () => {
    const id = make('fighter');
    const before = sheetExtras(db, campaignId, id).ac_breakdown.total;
    grant(id, 'Warded', [{ when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 1 }] }]);
    const stored = (db.prepare('SELECT ac FROM character WHERE id = ?').get(id) as { ac: number }).ac;
    expect(stored).toBe(before + 1);
    expect(combatSheet(db, id).ac).toBe(before + 1);

    addItem(db, { campaign_id: campaignId, character_id: id, name: 'Rope', qty: 1 });
    const after = (db.prepare('SELECT ac FROM character WHERE id = ?').get(id) as { ac: number }).ac;
    expect(after).toBe(before + 1);
    expect(combatSheet(db, id).ac).toBe(before + 1);
  });
});

// --- 30. the table tells the truth -----------------------------------------------------

describe('CLAUSE_SUPPORT', () => {
  it('says runs only for what the interpreter runs, and names a reason for everything else', () => {
    for (const [verb, capability] of Object.entries(CLAUSE_SUPPORT.do)) {
      if (capability.status === 'runs') continue;
      expect(capability.reason, `${verb} has no reason`).toBeTruthy();
    }
    expect(CLAUSE_SUPPORT.do.extra_action.status).toBe('runs');
    expect(CLAUSE_SUPPORT.do.min_die.status).toBe('reminds');
    expect(CLAUSE_SUPPORT.do.max_damage_dice.status).toBe('reminds');
    expect(CLAUSE_SUPPORT.do.hp_per_level.status).toBe('reminds');
    expect(CLAUSE_SUPPORT.do.effect.status).toBe('planned');
    expect(
      classifyClause(
        clauseSchema.parse({
          when: 'action',
          do: [{ kind: 'effect', effect: { kind: 'auto', damage: { dice: '1d6', type: 'force' } }, economy: 'action' }],
        }),
      ).status,
    ).toBe('runs');
    expect(
      classifyClause(
        clauseSchema.parse({
          when: 'turn_start',
          do: [{ kind: 'effect', effect: { kind: 'auto', damage: { dice: '1d6', type: 'force' } }, economy: 'free' }],
        }),
      ).status,
    ).toBe('reminds');
    expect(
      classifyClause(
        clauseSchema.parse({
          when: 'action',
          do: [
            {
              kind: 'effect',
              effect: { kind: 'auto', damage: { dice: '1d6', type: 'force' }, targets: 2 },
              economy: 'action',
            },
          ],
        }),
      ).status,
    ).toBe('planned');
    // A bonus runs everywhere it can land, and reminds where it cannot.
    expect(CLAUSE_SUPPORT.bonus_to.attack.status).toBe('runs');
    expect(CLAUSE_SUPPORT.bonus_to.spell_attack.status).toBe('runs');
    expect(CLAUSE_SUPPORT.bonus_to.heal.status).toBe('runs');
    expect(CLAUSE_SUPPORT.bonus_to.hp_max.status).toBe('reminds');

    // Per hook, not only per verb: a reroll on a D20 Test runs, on damage dice it reminds.
    const d20 = clauseSchema.parse({ when: 'roll', if: { kind: 'save' }, do: [{ kind: 'reroll', keep: 'new' }] });
    expect(classifyClause(d20).status).toBe('runs');
    const dice = clauseSchema.parse({ when: 'roll', if: { kind: 'damage' }, do: [{ kind: 'reroll', keep: 'higher' }] });
    expect(classifyClause(dice).status).toBe('reminds');

    // And a crit range only runs when nothing narrows or rations it.
    const keen = clauseSchema.parse({ when: 'always', do: [{ kind: 'crit_range', min: 19 }] });
    expect(classifyClause(keen).status).toBe('runs');
    const narrowed = clauseSchema.parse({
      when: 'always',
      if: { target: { type: ['undead'] } },
      do: [{ kind: 'crit_range', min: 19 }],
    });
    expect(classifyClause(narrowed).status).toBe('reminds');

    const saveEnds = clauseSchema.parse({
      when: 'hit',
      do: [{ kind: 'condition', name: 'poisoned', until: 'save_ends' }],
    });
    expect(classifyClause(saveEnds).status).toBe('reminds');
  });
});

// --- 31. the damage dice the engine does not operate on -------------------------------

describe('a clause that would cut into the damage dice', () => {
  it('hands the line back at the damage roll instead of pretending', async () => {
    const id = make('fighter');
    grant(id, 'Savage Hands', [
      { when: 'roll', if: { kind: 'damage' }, do: [{ kind: 'reroll', keep: 'higher' }], uses: 'once_per_turn' },
      { when: 'roll', if: { kind: 'damage' }, do: [{ kind: 'min_die', value: 3 }] },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    const reasons = remindersOf(swing).map((one) => one.reason);
    expect(reasons.filter((one) => /damage-die surgery/i.test(one))).toHaveLength(2);
    expect(logOf(swing).some((entry) => entry.kind === 'reminder')).toBe(true);
  });
});

// --- 32. an automatic reroll on a D20 Test ---------------------------------------------

describe('an auto reroll clause', () => {
  it('arms itself on every qualifying roll and is spent only when it fires', async () => {
    const id = make('fighter');
    grant(id, 'Second Nature', [
      {
        when: 'roll',
        if: { kind: 'attack' },
        do: [{ kind: 'reroll', keep: 'new' }],
        uses: { per: 'long', count: 1 },
      },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);

    // A swing that lands leaves the stance alone: nothing was declared and nothing is spent.
    await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(usesOf(id, 'Second Nature').used ?? 0).toBe(0);

    // A swing that would miss is made again, and the use goes with the reroll.
    await newTurn(pc().id);
    const missed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: { total: 2, natural: 2 },
    });
    expect(missed.notes.join(' ')).toMatch(/Second Nature/);
    expect(usesOf(id, 'Second Nature').used).toBe(1);
  });
});

// --- 33. an automatic clause pays for itself out of a fight ----------------------------

describe('an auto clause with uses on a check', () => {
  it('adds its points and is spent once the roll stands', async () => {
    const id = make('wizard');
    grant(id, 'Sudden Insight', [
      {
        when: 'roll',
        if: { kind: 'check', skill: ['arcana'] },
        do: [{ kind: 'bonus', to: 'check', amount: 3 }],
        uses: { per: 'long', count: 1 },
      },
    ]);
    const before = checkModifier(db, campaignId, id, { skill: 'arcana' });
    expect(before.feature_bonus).toBe(3);
    // It is not a boost: decision 1 says an automatic clause fires by itself.
    expect(before.boosts_available).toBeUndefined();
    expect(before.feature_spends).toHaveLength(1);

    const client = await connect();
    await client.callTool({
      name: 'roll',
      arguments: { campaign_id: campaignId, purpose: 'Arcana check', skill: 'arcana', character_id: id, roller: 'dm' },
    });
    expect(usesOf(id, 'Sudden Insight').used).toBe(1);
    expect(checkModifier(db, campaignId, id, { skill: 'arcana' }).feature_bonus).toBe(0);

    rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(checkModifier(db, campaignId, id, { skill: 'arcana' }).feature_bonus).toBe(3);
  });
});

// --- 34. a flat bonus on a saving throw in a fight ---------------------------------------

describe('a clause that adds to a saving throw', () => {
  it('rides on the save the engine rolls in a fight', async () => {
    const id = make('fighter');
    grant(id, 'Iron Will', [
      { when: 'roll', if: { kind: 'save', save: ['wis'] }, do: [{ kind: 'bonus', to: 'save', amount: 4 }] },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(foe().id);
    const scared = await useAction(db, {
      campaign_id: campaignId,
      actor_id: foe().id,
      action_name: 'Wail',
      target_id: pc().id,
      save_ability: 'wis',
      save_dc: 12,
    });
    const save = (scared as unknown as { targets: Array<{ save: { bonus: number } }> }).targets[0]!.save;
    const bare = combatSheet(db, id).saves.wis!.bonus;
    expect(save.bonus).toBe(bare + 4);
  });
});

// --- 35. the hooks that used to log without applying --------------------------------------

describe('a clause at the Initiative hook', () => {
  it('applies what it says and spends the use once', async () => {
    const id = make('fighter');
    grant(id, 'First Blood', [
      { when: 'initiative', do: [{ kind: 'temp_hp', amount: 5 }], uses: { per: 'long', count: 1 } },
    ]);
    arm(id, []);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    expect(pc().temp_hp).toBe(5);
    expect(usesOf(id, 'First Blood').used).toBe(1);
  });

  it('puts its bonus on the Initiative roll and hands back only what it cannot run', async () => {
    const id = make('fighter');
    grant(id, 'Alert', [
      { when: 'initiative', do: [{ kind: 'bonus', to: 'initiative', amount: 'prof' }] },
      {
        when: 'initiative',
        decide: 'ask_after',
        do: [{ kind: 'note', text: 'You can swap your Initiative with a willing ally who is not Incapacitated.' }],
      },
    ]);
    arm(id, []);
    const started = await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior', count: 1 }],
    });
    const sheet = combatSheet(db, id);
    expect(initiativeBonus(pc(), sheet)).toBe(sheet.initiative_bonus + sheet.proficiency_bonus);
    // The swap is the DM's; the bonus ran, so nothing of it comes back as a reminder.
    const reasons = remindersOf(started).map((one) => one.reason);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/chooses this one/);
  });
});

describe('a clause at a turn edge', () => {
  it('applies its temporary hit points, decrements the counter and stops at zero', async () => {
    const id = make('fighter');
    grant(id, 'Second Breath', [
      { when: 'turn_start', do: [{ kind: 'temp_hp', amount: 3 }], uses: { per: 'long', count: 1 } },
    ]);
    arm(id, []);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    await newTurn(pc().id);
    expect(pc().temp_hp).toBe(3);
    expect(usesOf(id, 'Second Breath').used).toBe(1);

    // Nothing left to spend: the next turn neither charges it again nor says it fired.
    await newTurn(pc().id);
    expect(usesOf(id, 'Second Breath').used).toBe(1);
  });
});

describe('a clause at the kill hook the outcome cannot carry', () => {
  it('reminds and spends nothing', async () => {
    const id = make('fighter');
    grant(id, 'Deathward Shove', [
      { when: 'kill', do: [{ kind: 'push_ft', amount: 10 }], uses: { per: 'long', count: 1 } },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(foe().id);
    resetAction(pc().id);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    const reminder = remindersOf(swing).find((one) => one.feature === 'Deathward Shove');
    expect(reminder?.reason).toMatch(/kill hook/);
    expect(usesOf(id, 'Deathward Shove').used ?? 0).toBe(0);
  });
});

// --- 36. Initiative carries its proficiency bonus once -------------------------------------

describe('a Bard rolling Initiative', () => {
  it('counts Jack of All Trades once, and a clause bonus on top of it', async () => {
    const id = make('bard');
    climbTo(id, 2);
    arm(id, []);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    const sheet = combatSheet(db, id);
    expect(sheet.features.some((f) => f.name === 'Jack of All Trades')).toBe(true);
    expect(initiativeBonus(pc(), sheet)).toBe(sheet.initiative_bonus);

    grant(id, 'Quick Draw', [{ when: 'initiative', do: [{ kind: 'bonus', to: 'initiative', amount: 1 }] }]);
    const after = combatSheet(db, id);
    expect(initiativeBonus(pc(), after)).toBe(after.initiative_bonus + 1);
  });
});

// --- 37. the stance nothing can arm ---------------------------------------------------------

describe('an auto reroll narrowed by more than the kind of roll', () => {
  it('does not fire against a creature it was never meant for, and keeps its use', async () => {
    const id = make('fighter');
    grant(id, 'Undead Bane', [
      {
        when: 'roll',
        if: { kind: 'attack', target: { type: ['undead'] } },
        do: [{ kind: 'reroll', keep: 'new' }],
        uses: { per: 'long', count: 1 },
      },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const missed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: { total: 2, natural: 2 },
    });
    expect(missed.notes.join(' ')).not.toMatch(/Undead Bane/);
    expect(usesOf(id, 'Undead Bane').used ?? 0).toBe(0);

    // The line is handed back on the swing instead of being armed before it.
    await newTurn(pc().id);
    const landed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(remindersOf(landed).some((one) => one.feature === 'Undead Bane')).toBe(true);
  });
});

// --- 38. a clause on a casting the player chooses --------------------------------------------

describe('an ask_before clause on a casting', () => {
  it('is offered rather than applied, and applied and spent once it is named', async () => {
    const id = make('sorcerer', { spells: ['Burning Hands', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Focused Will', [
      {
        when: 'cast',
        do: [{ kind: 'bonus', to: 'spell_save_dc', amount: 2 }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);
    const dc = combatSheet(db, id).spells.save_dc!;
    const key = `homebrew:${grantedId(id)}:0`;

    const plain = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Burning Hands',
      spell: 'Burning Hands',
      slot_level: 1,
      point: { x: foe().x, y: foe().y },
    });
    expect(boostsOf(plain).map((one) => one.id)).toContain(key);
    expect(texts(plain)).toMatch(new RegExp(`vs DC ${dc}\\b`));
    expect(usesOf(id, 'Focused Will').used ?? 0).toBe(0);

    await newTurn(pc().id);
    const taken = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Burning Hands',
      spell: 'Burning Hands',
      slot_level: 1,
      point: { x: foe().x, y: foe().y },
      boosts: [key],
    });
    expect(texts(taken)).toMatch(new RegExp(`vs DC ${dc + 2}\\b`));
    expect(usesOf(id, 'Focused Will').used).toBe(1);
  });
});

// --- 39. the counters a two-clause feature keeps ----------------------------------------------

describe('a feature with two counters', () => {
  it('shows the use it just spent gone in the same reply', async () => {
    const id = make('fighter');
    grant(id, 'Twin Tricks', [
      {
        when: 'roll',
        if: { kind: 'attack' },
        do: [{ kind: 'advantage' }],
        uses: { per: 'long', count: 2 },
        decide: 'ask_before',
      },
      {
        when: 'roll',
        if: { kind: 'save' },
        do: [{ kind: 'bonus', to: 'save', amount: 2 }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const key = `homebrew:${grantedId(id)}:0`;
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
      boosts: [key],
    });
    expect(swing.advantage).toBe('advantage');
    expect(boostsOf(swing).find((one) => one.id === key)?.uses_left).toBe(1);
    expect(usesOf(id, 'Twin Tricks #1').used).toBe(1);
  });
});

// --- 40. a rationed rider on a casting that heals more than one creature -----------------------

describe('a rationed heal rider', () => {
  it('lands on the first creature the casting heals and is spent once', async () => {
    const id = make('sorcerer', { spells: ['Burning Hands', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Kind Flame', [
      { when: 'roll', do: [{ kind: 'bonus', to: 'heal', amount: 2 }], uses: { per: 'long', count: 2 } },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 2 }]);
    place(pc().id, 2, 5);
    place(foe(0).id, 4, 5);
    place(foe(1).id, 4, 6);
    resetAction(pc().id);
    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Burning Hands',
      spell: 'Burning Hands',
      slot_level: 1,
      heal_expr: '1d4',
      point: { x: 4, y: 5 },
    });
    const healed = logOf(cast).filter((entry) => entry.kind === 'heal');
    expect(healed).toHaveLength(2);
    expect(healed.filter((entry) => /Kind Flame/.test(entry.text))).toHaveLength(1);
    expect(usesOf(id, 'Kind Flame').used).toBe(1);
  });
});

describe('a homebrew healing bonus', () => {
  it('adds to the hit points a spell restores', async () => {
    const id = make('sorcerer', { spells: ['Burning Hands', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Kind Flame', [{ when: 'roll', do: [{ kind: 'bonus', to: 'heal', amount: 2 }] }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    place(pc().id, 2, 5);
    place(foe().id, 4, 5);
    db.prepare('UPDATE combatant SET hp_current = 100 WHERE id = ?').run(foe().id);
    resetAction(pc().id);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Burning Hands',
      spell: 'Burning Hands',
      slot_level: 1,
      damage_expr: '0',
      heal_expr: '1',
      point: { x: 4, y: 5 },
    });

    expect(logOf(cast).filter((entry) => entry.kind === 'heal')[0]?.text).toContain('regains 3 HP (103/200)');
    expect(foe().hp_current).toBe(103);
  });
});

describe('a limited boost in a group check', () => {
  it('is spent once by the member whose roll it improves', async () => {
    const first = make('fighter');
    const second = make('fighter');
    grant(first, 'Group Focus', [
      {
        when: 'roll',
        if: { kind: 'check', skill: ['athletics'] },
        do: [{ kind: 'bonus', to: 'check', amount: 2 }],
        uses: { per: 'long', count: 1 },
      },
    ]);
    const client = await connect();

    await client.callTool({
      name: 'roll',
      arguments: {
        campaign_id: campaignId,
        purpose: 'Cross the river',
        skill: 'athletics',
        dc: 10,
        group: [first, second],
        roller: 'dm',
      },
    });

    expect(usesOf(first, 'Group Focus').used).toBe(1);
  });
});

// --- 41. the boost a contest spends -------------------------------------------------------------

describe('a boost on a contest', () => {
  it('is spent where the contest is rolled', async () => {
    const id = make('fighter');
    grant(id, 'Wrestler', [
      {
        when: 'roll',
        if: { kind: 'check', skill: ['athletics'] },
        do: [{ kind: 'advantage' }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    const key = `homebrew:${grantedId(id)}:0`;
    const client = await connect();
    await client.callTool({
      name: 'roll',
      arguments: {
        campaign_id: campaignId,
        purpose: 'Shove',
        skill: 'athletics',
        character_id: id,
        roller: 'dm',
        boosts: [key],
        contest: { opponent: { bonus: 3, name: 'the goblin' } },
      },
    });
    expect(usesOf(id, 'Wrestler').used).toBe(1);
  });
});

// --- 42. what the card bought is what the swing says ---------------------------------------------

describe('a boost taken on the roll card', () => {
  it('is reported on the attack it boosted', async () => {
    const id = make('fighter');
    grant(id, 'Steady Nerve', [
      {
        when: 'roll',
        if: { kind: 'attack' },
        do: [{ kind: 'advantage' }, { kind: 'bonus', to: 'attack', amount: 2 }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const sheet = combatSheet(db, id);
    const plain = sheet.proficiency_bonus + (sheet.abilities.str?.mod ?? 0);
    updateSettings(db, campaignId, { roll_mode: 'player', player_rolls: 'd20_only' });

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
    });
    const card = await nextAsk();
    const offered = rollBoosts(card).boosts_available;
    applyRollBoost(db, card.id, offered[0]!.id);
    resolvePendingRoll(db, card.id);
    const swing = await running;
    // What the card bought is what the result and the log line say: Advantage, and the boosted number.
    expect(swing.advantage).toBe('advantage');
    expect(exprBonus(swing.roll.expr)).toBe(plain + 2);
  });
});

// --- 43. the numbers the sheet column shows -------------------------------------------------------

describe('the character summary', () => {
  it('counts an always clause in the Initiative bonus the fight rolls with', () => {
    const id = make('fighter');
    const before = getCharacterSheet(db, campaignId, id)!.initiative_bonus;
    grant(id, 'Watchful', [{ when: 'always', do: [{ kind: 'bonus', to: 'initiative', amount: 2 }] }]);
    expect(getCharacterSheet(db, campaignId, id)!.initiative_bonus).toBe(before + 2);
    expect(combatSheet(db, id).initiative_bonus).toBe(before + 2);
  });
});

// --- 44. the feature a casting's spend is logged under ---------------------------------------------

describe('the spend a cast clause asks for', () => {
  it('is written to the fight log under the name of the feature that asked for it', async () => {
    const id = make('sorcerer', { spells: ['Burning Hands', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Surging Words', [
      { when: 'cast', do: [{ kind: 'bonus', to: 'spell_save_dc', amount: 1 }], uses: { per: 'long', count: 1 } },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);
    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: 'Burning Hands',
      spell: 'Burning Hands',
      slot_level: 1,
      point: { x: foe().x, y: foe().y },
    });
    const spend = (cast.log as Array<{ kind: string; payload: { feature?: string } }>).find(
      (entry) => entry.kind === 'feature_resource',
    );
    expect(spend?.payload.feature).toBe('Surging Words');
    expect(usesOf(id, 'Surging Words').used).toBe(1);
  });
});

// --- 45. what the table says per hook ----------------------------------------------------------------

describe('CLAUSE_SUPPORT per hook', () => {
  it('says runs only where that hook can run the verb', () => {
    const runs = (clause: ClauseInput): string => classifyClause(clauseSchema.parse(clause)).status;
    // The outcome hooks apply what the engine writes on the spot, and hand the rest back.
    expect(runs({ when: 'turn_start', do: [{ kind: 'temp_hp', amount: 5 }] })).toBe('runs');
    expect(runs({ when: 'kill', do: [{ kind: 'push_ft', amount: 10 }] })).toBe('reminds');
    expect(runs({ when: 'turn_end', do: [{ kind: 'recover_slot', level: 1 }] })).toBe('reminds');
    // A bonus to Initiative rides on the Initiative roll; every other bonus there reminds.
    expect(runs({ when: 'initiative', do: [{ kind: 'bonus', to: 'initiative', amount: 'prof' }] })).toBe('runs');
    expect(runs({ when: 'initiative', do: [{ kind: 'bonus', to: 'damage', amount: 2 }] })).toBe('reminds');
    // A casting takes its save DC, its attack roll and Advantage on it, and nothing else.
    expect(runs({ when: 'cast', do: [{ kind: 'bonus', to: 'spell_save_dc', amount: 1 }] })).toBe('runs');
    expect(runs({ when: 'cast', do: [{ kind: 'advantage' }] })).toBe('runs');
    expect(runs({ when: 'cast', do: [{ kind: 'extra_damage', dice: '1d6' }] })).toBe('reminds');
  });
});

// --- H3 package 1: action clauses use the shared spell-effect runner -----------------------------

describe('a spell-shaped homebrew action', () => {
  it('spends one use and resolves failed and successful saves, including half damage', async () => {
    const id = make('sorcerer');
    grant(id, 'Cinder Pulse', [
      {
        when: 'action',
        uses: { per: 'long', count: 1 },
        do: [
          {
            kind: 'effect',
            economy: 'action',
            effect: {
              kind: 'save',
              damage: { dice: '2d6', type: 'fire' },
              save_ability: 'dex',
              half_on_save: true,
              shape: { kind: 'sphere', size_ft: 10 },
            },
          },
        ],
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 2 }]);
    place(pc().id, 1, 5);
    place(foe(0).id, 3, 5);
    place(foe(1).id, 3, 6);
    resetAction(pc().id);

    const pulse = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: `homebrew_${grantedId(id)}_0`,
      point: { x: 3, y: 5 },
      rolls: {
        [foe(0).id]: { total: 1, natural: 1 },
        [foe(1).id]: { total: 30, natural: 20 },
      },
    });

    const enemyIds = new Set([foe(0).id, foe(1).id]);
    const targets = pulse.targets as Array<{ target_id: number; damage: { applied: number } }>;
    expect(
      targets
        .filter((target) => enemyIds.has(target.target_id))
        .map((target) => target.damage.applied)
        .sort((a, b) => a - b),
    ).toEqual([3, 6]);
    expect(usesOf(id, 'Cinder Pulse').used).toBe(1);
    expect(pc().action_used).toBe(true);
  });

  it('heals through the same runner and spends the declared bonus action', async () => {
    const id = make('fighter');
    grant(id, 'Mending Touch', [
      {
        when: 'action',
        do: [{ kind: 'effect', economy: 'bonus', effect: { kind: 'heal', healing: { dice: '1d6' }, targets: 1 } }],
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    db.prepare('UPDATE character SET hp_current = hp_max - 5 WHERE id = ?').run(id);
    db.prepare('UPDATE combatant SET hp_current = hp_max - 5 WHERE id = ?').run(pc().id);
    resetAction(pc().id);

    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: `homebrew_${grantedId(id)}_0`,
      target_id: pc().id,
    });

    expect(pc().hp_current).toBe(pc().hp_max - 2);
    expect(pc().bonus_used).toBe(true);
    expect(pc().action_used).toBe(false);
  });

  it('runs attack and utility effects, including concentration and duration', async () => {
    const id = make('sorcerer');
    grant(id, 'Arcane Forms', [
      {
        when: 'action',
        do: [
          {
            kind: 'effect',
            economy: 'action',
            concentration: true,
            effect: {
              kind: 'attack',
              damage: { dice: '1d6', type: 'psychic' },
              condition: { name: 'frightened' },
              targets: 1,
            },
          },
        ],
      },
      {
        when: 'action',
        do: [
          {
            kind: 'effect',
            economy: 'free',
            duration_rounds: 2,
            effect: { kind: 'utility', condition: { name: 'prone' }, targets: 1 },
          },
        ],
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);

    const attackResult = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: `homebrew_${grantedId(id)}_0`,
      target_id: foe().id,
      roll: hit,
    });
    expect((attackResult.targets[0] as { damage: { applied: number } }).damage.applied).toBe(3);
    expect(foe().conditions).toContain('frightened');
    expect(pc().concentration?.name).toBe('Arcane Forms');

    const utilityResult = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: `homebrew_${grantedId(id)}_1`,
      target_id: foe().id,
    });
    expect(utilityResult.targets).toHaveLength(1);
    expect(foe().conditions).toContain('prone');
    const prone = db
      .prepare("SELECT ends, remaining_rounds FROM effect WHERE name = 'prone' ORDER BY id DESC")
      .get() as { ends: string; remaining_rounds: number };
    expect(prone).toEqual({ ends: 'rounds', remaining_rounds: 2 });
  });

  it('refuses missing area placement before spending its use or economy', async () => {
    const id = make('sorcerer');
    grant(id, 'Cinder Pulse', [
      {
        when: 'action',
        uses: { per: 'long', count: 1 },
        do: [
          {
            kind: 'effect',
            economy: 'action',
            effect: {
              kind: 'save',
              damage: { dice: '2d6', type: 'fire' },
              save_ability: 'dex',
              shape: { kind: 'sphere', size_ft: 10 },
            },
          },
        ],
      },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);

    await expect(
      useAction(db, {
        campaign_id: campaignId,
        actor_id: pc().id,
        action_name: `homebrew_${grantedId(id)}_0`,
        target_id: foe().id,
      }),
    ).rejects.toThrow(/pass point/i);
    expect(usesOf(id, 'Cinder Pulse').used ?? 0).toBe(0);
    expect(pc().action_used).toBe(false);
  });
});

describe("a magic item's spell-shaped action", () => {
  const item = (active: boolean) => ({
    name: 'Cloak of Sparks',
    qty: 1,
    equipped: active,
    magic: {
      rarity: 'rare',
      attunement: true,
      attuned: active,
      identified: true,
      mechanics: {
        clauses: clausesSchema.parse([
          {
            when: 'action',
            do: [
              {
                kind: 'effect',
                economy: 'action',
                effect: { kind: 'auto', damage: { dice: '1d6', type: 'lightning' }, targets: 1 },
              },
            ],
          },
        ]),
      },
    },
  });

  it('is offered and runs only while worn and attuned', async () => {
    const id = make('fighter');
    arm(id, [item(true)]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    resetAction(pc().id);
    const actionId = 'homebrew_cloak_of_sparks_0';
    expect(legalActions(pc(), combatSheet(db, id)).some((action) => action.id === `feature:${actionId}`)).toBe(true);

    const used = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc().id,
      action_name: actionId,
      target_id: foe().id,
    });
    expect((used.targets[0] as { damage: { applied: number } }).damage.applied).toBe(3);

    arm(id, [item(false)]);
    expect(legalActions(pc(), combatSheet(db, id)).some((action) => action.id === `feature:${actionId}`)).toBe(false);
  });
});

// --- H3 package 2: post-result and post-damage clause seams ----------------------

describe('post-result homebrew clauses', () => {
  it('judges natural, success, failure, and margin only after a result exists', async () => {
    const id = make('fighter');
    grant(id, 'Perfect Cut', [
      {
        when: 'hit',
        if: { roll: { natural_min: 20, succeeded: true, margin_at_least: 5 } },
        do: [{ kind: 'temp_hp', amount: 4 }],
        uses: { per: 'long', count: 1 },
      },
    ]);
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);

    await attack(db, {
      campaign_id: campaignId, attacker_id: pc().id, target_id: foe().id, action_name: 'Longsword', roll: { total: 30, natural: 19 },
    });
    expect(pc().temp_hp).toBe(0);
    expect(usesOf(id, 'Perfect Cut').used ?? 0).toBe(0);
    await newTurn(pc().id);
    await attack(db, {
      campaign_id: campaignId, attacker_id: pc().id, target_id: foe().id, action_name: 'Longsword', roll: { total: 30, natural: 20 },
    });
    expect(pc().temp_hp).toBe(4);
    expect(usesOf(id, 'Perfect Cut').used).toBe(1);

    const failed = clauseApplies(
      clauseSchema.parse({ when: 'miss', if: { roll: { failed: true } }, do: [{ kind: 'temp_hp', amount: 1 }] }),
      { sheet: { level: 1, proficiency_bonus: 2, abilities: {}, features: [], inventory: [] }, roll: { natural: 1, total: 2, dc: 15, success: false } },
    );
    expect(failed.ok).toBe(true);
    expect(classifyClause(clauseSchema.parse({ when: 'hit', if: { roll: { succeeded: true } }, do: [{ kind: 'temp_hp', amount: 1 }] })).status).toBe('runs');
    expect(classifyClause(clauseSchema.parse({ when: 'roll', if: { roll: { succeeded: true } }, do: [{ kind: 'advantage' }] })).status).toBe('planned');
  });
});

describe('damage_taken clauses', () => {
  it('applies a self effect after damage and never spends an unsupported effect', async () => {
    const id = make('fighter');
    grant(id, 'Pain into Guard', [
      { when: 'damage_taken', do: [{ kind: 'temp_hp', amount: 3 }], uses: { per: 'long', count: 1 } },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(foe().id);
    await attack(db, {
      campaign_id: campaignId, attacker_id: foe().id, target_id: pc().id, action_name: 'Scimitar', roll: hit,
    });
    expect(pc().temp_hp).toBe(3);
    expect(usesOf(id, 'Pain into Guard').used).toBe(1);

    const other = make('fighter');
    grant(other, 'Impossible Riposte', [
      { when: 'damage_taken', do: [{ kind: 'extra_damage', dice: '1d6' }], uses: { per: 'long', count: 1 } },
    ]);
    expect(classifyClause(clauseSchema.parse({ when: 'damage_taken', do: [{ kind: 'extra_damage', dice: '1d6' }] })).status).toBe('reminds');
    expect(usesOf(other, 'Impossible Riposte').used ?? 0).toBe(0);
  });

  it('also fires on the damage a save spell dealt, once per cast across an area', async () => {
    const id = make('sorcerer', { spells: ['Burning Hands', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    knowSpell(id, 'Shatter');
    grant(id, 'Warded Skin', [
      { when: 'damage_taken', do: [{ kind: 'temp_hp', amount: 4 }], uses: { per: 'long', count: 2 } },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 2 }]);
    place(pc().id, 1, 5);
    const goblins = combatants().filter((c) => c.team === 'enemy');
    for (const [at, goblin] of goblins.entries()) place(goblin.id, 2 + at, 5);
    resetAction(pc().id);
    // A sphere centred on the holder catches them and both goblins; everyone fails the save.
    await useAction(db, {
      campaign_id: campaignId, actor_id: pc().id, action_name: 'Shatter', spell: 'Shatter', slot_level: 2,
      point: { x: 1, y: 5 },
      rolls: { [pc().id]: { total: 2, natural: 1 }, ...Object.fromEntries(goblins.map((goblin) => [goblin.id, { total: 2, natural: 1 }])) },
    });
    // The holder caught their own blast: one effect on the first hurt creature it applies to, one use.
    expect(pc().temp_hp).toBe(4);
    expect(usesOf(id, 'Warded Skin').used).toBe(1);
  });
});

describe('save_succeeded clauses', () => {
  it('applies its holder effect through a successful save without claiming half damage', async () => {
    const id = make('sorcerer', { spells: ['Burning Hands', 'Shield'], cantrips: SORCERER_CANTRIPS });
    climbTo(id, 4);
    arm(id, []);
    grant(id, 'Defiant Spark', [
      { when: 'save_succeeded', do: [{ kind: 'temp_hp', amount: 2 }], uses: { per: 'long', count: 1 } },
    ]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    place(pc().id, 1, 5);
    place(foe().id, 2, 5);
    resetAction(pc().id);
    await useAction(db, {
      campaign_id: campaignId, actor_id: pc().id, action_name: 'Burning Hands', spell: 'Burning Hands', slot_level: 1,
      point: { x: 2, y: 5 }, rolls: { [foe().id]: { total: 30, natural: 20 } },
    });
    expect(pc().temp_hp).toBe(2);
    expect(usesOf(id, 'Defiant Spark').used).toBe(1);
    expect(classifyClause(clauseSchema.parse({ when: 'save_succeeded', do: [{ kind: 'extra_damage', dice: '1d6' }] })).status).toBe('reminds');
  });
});


// --- clauses that fire on a rest ------------------------------------------------

describe('a clause that fires on a rest', () => {
  it('applies on a long rest once, spends the use, and applies again after a long rest gives it back', async () => {
    const id = make('fighter');
    grant(id, 'Evening Ward', [{ when: 'rest_long', do: [{ kind: 'temp_hp', amount: 5 }], uses: { per: 'long', count: 1 } }]);
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const first = rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(((first ?? {}) as { temp_hp?: number }).temp_hp).toBe(5);
    expect((first as { rest_effects?: string[] }).rest_effects?.join(' ')).toMatch(/Evening Ward.*Temporary Hit Points/);
    expect(usesOf(id, 'Evening Ward').used).toBe(1);

    const again = rest(db, { campaign_id: campaignId, character_id: id, kind: 'long', force: true });
    expect((again as { rest_effects?: string[] }).rest_effects?.join(' ')).toMatch(/Temporary Hit Points/);
    expect(usesOf(id, 'Evening Ward').used).toBe(1);
  });

  it('runs a short-rest clause on a short rest and not on a long one', async () => {
    const id = make('fighter');
    grant(id, 'Second Wind Habit', [{ when: 'rest_short', do: [{ kind: 'temp_hp', amount: 2 }], uses: { per: 'short', count: 1 } }]);
    const short = rest(db, { campaign_id: campaignId, character_id: id, kind: 'short' });
    expect((short as { rest_effects?: string[] }).rest_effects?.join(' ')).toMatch(/Second Wind Habit.*Temporary Hit Points/);
    expect(usesOf(id, 'Second Wind Habit').used).toBe(1);

    const long = rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect((long as { rest_effects?: string[] }).rest_effects).toBeUndefined();
  });

  it('hands a verb the rest cannot run back as a reminder and never spends', async () => {
    const id = make('fighter');
    grant(id, 'Broken Promise', [
      { when: 'rest_long', do: [{ kind: 'extra_damage', dice: '1d6' }], uses: { per: 'long', count: 2 } },
    ]);
    const taken = rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect((taken as { rest_effects?: string[] }).rest_effects).toBeUndefined();
    expect((taken as { notes?: string[] }).notes?.join(' ')).toMatch(/does not land at the rest_long hook/);
    expect(usesOf(id, 'Broken Promise').used ?? 0).toBe(0);
  });

  it('gives an interrupted rest nothing, clause effects included', async () => {
    const id = make('fighter');
    grant(id, 'Evening Ward', [{ when: 'rest_long', do: [{ kind: 'temp_hp', amount: 5 }], uses: { per: 'long', count: 1 } }]);
    const broken = rest(db, { campaign_id: campaignId, character_id: id, kind: 'long', hours: 4 });
    expect((broken as { interrupted?: boolean }).interrupted).toBe(true);
    expect((broken as { rest_effects?: string[] }).rest_effects).toBeUndefined();
    expect(usesOf(id, 'Evening Ward').used ?? 0).toBe(0);
  });
});

describe("a worn magic item's limited clause", () => {
  const CLOAK = (over: Partial<Record<string, unknown>> = {}): Array<Record<string, unknown>> => [
    {
      name: 'Cloak of Sparks',
      qty: 1,
      equipped: true,
      ...over,
      magic: {
        rarity: 'rare',
        attunement: true,
        attuned: true,
        identified: true,
        mechanics: {
          clauses: clausesSchema.parse([
            {
              when: 'hit',
              do: [{ kind: 'extra_damage', dice: '1d6', type: 'cold' }],
              uses: { charges: { max: 1, recharge: 'dawn' } },
            },
          ]),
        },
        ...((over.magic as Record<string, unknown> | undefined) ?? {}),
      },
    },
  ];

  it('spends its use once, carries the sheet, refuses re-fire, and undo gives it back', async () => {
    const id = make('fighter');
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }, ...CLOAK()]);
    const sheet = combatSheet(db, id);
    expect(sheet.features.find((f) => f.name === 'Cloak of Sparks')?.mechanics).toMatchObject({
      resource: 'homebrew:cloak_of_sparks:0',
      max: 1,
      used: 0,
    });
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    const first = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(named(first, 'Cloak of Sparks')).toBeDefined();
    expect(usesOf(id, 'Cloak of Sparks').used).toBe(1);

    // The spend is on the character's own rows: a fresh sheet still reads it spent.
    expect(combatSheet(db, id).features.find((f) => f.mechanics?.resource === 'homebrew:cloak_of_sparks:0')!.mechanics!.used).toBe(1);
    undoLastCombatAction(db, campaignId);
    expect(usesOf(id, 'Cloak of Sparks').used ?? 0).toBe(0);
    resetAction(pc().id);
    const fired =
      await attack(db, { campaign_id: campaignId, attacker_id: pc().id, target_id: foe().id, action_name: 'Longsword', roll: hit });
    expect(named(fired, 'Cloak of Sparks')).toBeDefined();
  });

  it('recharges at dawn on the clock, never on a mere long rest, and pays nothing while unworn', async () => {
    const id = make('fighter');
    arm(id, [{ name: 'Longsword', qty: 1, equipped: true }, ...CLOAK()]);
    await ambush([{ creature: 'Goblin Warrior', count: 1 }]);
    beside(foe().id, pc());
    resetAction(pc().id);
    await attack(db, { campaign_id: campaignId, attacker_id: pc().id, target_id: foe().id, action_name: 'Longsword', roll: hit });
    expect(usesOf(id, 'Cloak of Sparks').used).toBe(1);
    // An hour before the mark, and a long rest that never crosses it, gave nothing back.
    advanceTime(db, campaignId, { hours: 1 });
    rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(usesOf(id, 'Cloak of Sparks').used ?? 0).toBe(1);
    advanceTime(db, campaignId, { hours: 24 });
    expect(usesOf(id, 'Cloak of Sparks').used ?? 0).toBe(0);

    arm(id, CLOAK({ equipped: false }));
    expect(combatSheet(db, id).features.some((f) => f.name === 'Cloak of Sparks')).toBe(false);
  });
});

