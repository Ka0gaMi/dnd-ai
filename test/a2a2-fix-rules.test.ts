// A2a-2 review fixes on the rules: a Wild Shape form keeps no species trait in a fight or out of one, a Druid
// who fell between fights comes into the next one unshaped, and Halfling Luck on a clicked d20 keeps its pool.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rollSave } from '../src/combat/d20.js';
import { startEncounter, useAction } from '../src/combat/engine.js';
import { featureActionIds } from '../src/combat/features.js';
import type { BattleMap } from '../src/combat/map.js';
import { combatSheet } from '../src/combat/sheet.js';
import { combatLog, getBattleState, listCombatants, requireEncounter, type Combatant } from '../src/combat/state.js';
import { useFeatureOutsideCombat } from '../src/combat/use-action.js';
import { advanceTime } from '../src/core/calendar.js';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  applyDamage,
  awardXp,
  createCharacter,
  levelUp,
  levelUpOptions,
  setCondition,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData } from './helpers/reply.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

// rpg-dice-roller turns each Math.random into one die through its own integer step, so these are measured.
const D20_1 = 0;
const D20_4 = 0.45;
const D20_18 = 0.6;

/** The next dice the engine rolls, in order; anything after them rolls as 0.5. */
function queueRolls(values: number[]): void {
  let index = 0;
  Math.random = () => values[index++] ?? 0.5;
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Fixes', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- building a Druid ---------------------------------------------------------

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

function skillPicks(species: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass('druid'), findSpecies(species))) {
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

/** A Druid of that species at the level given; level 2 is the first with Wild Shape. */
function druid(species: string, options: { lineage?: string; level?: number } = {}): number {
  const data = findClass('druid');
  const casting = classLevelRow(data.index, 1).spellcasting;
  const id = createCharacter(db, {
    campaign_id: campaignId,
    name: `${species} Druid`,
    class: 'druid',
    species,
    ...(options.lineage ? { lineage: options.lineage } : {}),
    background: 'Acolyte',
    ability_method: 'manual',
    abilities: { str: 10, dex: 14, con: 13, int: 15, wis: 15, cha: 15 },
    ability_bonuses: { wis: 2, cha: 1 },
    skill_choices: skillPicks(species),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
  } as CreateCharacterInput).character!.id;
  const level = options.level ?? 2;
  if (level > 1) awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[level - 1]! });
  while (sheetOf(id).level < level) {
    const asks = levelUpOptions(db, campaignId, id) as {
      subclass_choice?: unknown;
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
      spellcasting?: { cantrips_to_add: number; spells_to_add: number; cantrip_options: string[]; spell_options: Record<string, string[]> };
    };
    const spells = sheetOf(id).spells as { cantrips: string[]; known: string[] };
    const choices: LevelUpChoices = { hp: 'average' };
    if (asks.subclass_choice) choices.subclass = 'Circle of the Land';
    if (asks.feature_choices) {
      choices.feature_options = Object.fromEntries(asks.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]));
    }
    if (asks.spellcasting) {
      choices.cantrips = asks.spellcasting.cantrip_options
        .filter((name) => !spells.cantrips.includes(name))
        .slice(0, asks.spellcasting.cantrips_to_add);
      choices.spells = Object.values(asks.spellcasting.spell_options)
        .flat()
        .filter((name) => !spells.known.includes(name))
        .slice(0, asks.spellcasting.spells_to_add);
    }
    levelUp(db, { campaign_id: campaignId, character_id: id, choices });
  }
  return id;
}

// --- the battlefield ----------------------------------------------------------

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
  db.prepare("UPDATE combatant SET x = 3, y = 5 WHERE kind = 'pc'").run();
  db.prepare("UPDATE combatant SET x = 5, y = 5, hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
}

const encounter = () => requireEncounter(db, campaignId);
const combatants = (): Combatant[] => listCombatants(db, encounter().id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (): Combatant => combatants().find((c) => c.team === 'enemy')!;

/** Hands the turn to the PC with its whole economy back. */
const myTurn = (): void => {
  const me = pc();
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(me.id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    getBattleState(db, campaignId)!.combatants.findIndex((c) => c.id === me.id),
    encounter().id,
  );
};

const use = (action: string, extra: Record<string, unknown> = {}) =>
  useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: action, ...extra });

const save = (ability: Ability, against?: string[]) =>
  rollSave(db, encounter(), pc(), ability, 12, against ? { against } : {});

const outside = (id: number, action: string, option?: string) =>
  useFeatureOutsideCombat(db, { campaign_id: campaignId, actor_id: id, action_name: action, ...(option ? { option } : {}) });

const record = (id: number): { form: string } | null => {
  const row = db.prepare('SELECT wild_shape_json FROM character WHERE id = ?').get(id) as { wild_shape_json: string | null };
  return row.wild_shape_json ? (JSON.parse(row.wild_shape_json) as { form: string }) : null;
};

// --- the roll tool, with no fight running -------------------------------------

interface RollReply {
  advantage?: string;
  natural_d20?: number | null;
  rerolled?: { trait: string; from: number; to: number };
  rules_applied?: string[];
}

/** One roll tool call for the campaign's PC, its reply data back. */
async function roll(args: Record<string, unknown>): Promise<RollReply> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({
      name: 'roll',
      arguments: { campaign_id: campaignId, purpose: 'A test roll', roller: 'dm', ...args },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    if (result.isError) throw new Error(result.content[0]!.text);
    return replyData<RollReply>(result);
  } finally {
    void client.close();
  }
}

const rules = (reply: RollReply): string => (reply.rules_applied ?? []).join(' ');

// --- 1. species traits stay behind in a Beast form ----------------------------

describe('species traits in a Wild Shape form', () => {
  it('gives a Halfling Druid in a Beast form no Brave and no Halfling Luck in a fight, and both back with the own shape', async () => {
    druid('Halfling');
    await ambush();
    // Unshaped first, so the test shows what the form takes away.
    expect((await save('wis', ['frightened'])).advantage).toBe('advantage');
    myTurn();
    await use('wild_shape', { option: 'Wolf' });
    expect(pc().flags.wild_shape?.form).toBe('Wolf');

    const scared = await save('wis', ['frightened']);
    expect(scared.advantage).toBe('none');
    expect(scared.notes.join(' ')).not.toMatch(/Brave/);
    queueRolls([D20_1, D20_18]);
    const unlucky = await save('dex');
    expect(unlucky.natural).toBe(1);
    expect(unlucky.notes.join(' ')).not.toMatch(/Halfling Luck/);

    myTurn();
    await use('wild_shape_revert');
    expect((await save('wis', ['frightened'])).notes.join(' ')).toMatch(/Brave/);
    queueRolls([D20_1, D20_18]);
    expect((await save('dex')).natural).toBe(18);
  });

  it('gives a Halfling Druid in a Beast form no Brave and no Halfling Luck outside a fight, until the form runs out', async () => {
    const id = druid('Halfling');
    expect(rules(await roll({ save: 'wis', against: ['frightened'] }))).toMatch(/Brave/);
    outside(id, 'wild_shape', 'Wolf');

    const scared = await roll({ save: 'wis', against: ['frightened'] });
    expect(scared.advantage).toBe('none');
    expect(rules(scared)).not.toMatch(/Brave/);
    queueRolls([D20_1, D20_18]);
    const check = await roll({ skill: 'nature' });
    expect(check.rerolled).toBeUndefined();
    expect(check.natural_d20).toBe(1);
    expect(rules(check)).not.toMatch(/Halfling Luck/);

    // The hour is up: a record still on the row is no form, and the traits are back.
    advanceTime(db, campaignId, { minutes: 60 });
    expect(rules(await roll({ save: 'wis', against: ['frightened'] }))).toMatch(/Brave/);
  });

  it('refuses a Dragonborn Druid Breath Weapon in a Beast form, at no cost', async () => {
    const id = druid('Dragonborn', { lineage: 'Draconic Ancestor: Red' });
    await ambush();
    expect(featureActionIds(combatSheet(db, id))).toContain('breath_weapon');
    myTurn();
    await use('wild_shape', { option: 'Wolf' });
    expect(featureActionIds(combatSheet(db, id))).not.toContain('breath_weapon');

    const usedBreath = (): number =>
      combatSheet(db, id).features.find((f) => f.mechanics?.resource === 'breath_weapon')?.mechanics?.used ?? 0;
    const before = { me: pc(), hp: combatants().map((c) => c.hp_current), log: combatLog(db, encounter().id).length };
    await expect(use('breath_weapon', { target_id: foe().id })).rejects.toThrow(/no class feature action called "breath_weapon"/);
    const after = pc();
    expect(usedBreath()).toBe(0);
    expect([after.action_used, after.bonus_used, after.reaction_used]).toEqual([
      before.me.action_used,
      before.me.bonus_used,
      before.me.reaction_used,
    ]);
    expect(combatants().map((c) => c.hp_current)).toEqual(before.hp);
    expect(combatLog(db, encounter().id)).toHaveLength(before.log);
  });

  it("leaves a Dragonborn Druid's Fire resistance behind in the Beast form outside a fight", () => {
    const id = druid('Dragonborn', { lineage: 'Draconic Ancestor: Red' });
    expect(combatSheet(db, id).resistances).toContain('fire');
    outside(id, 'wild_shape', 'Wolf');
    expect(combatSheet(db, id).resistances).not.toContain('fire');
    outside(id, 'wild_shape_revert');
    expect(combatSheet(db, id).resistances).toContain('fire');
  });
});

// --- 2. a Druid who fell between fights ---------------------------------------

describe('a recorded form on a Druid who is down', () => {
  it('brings a Druid at 0 HP into the next fight unshaped, and clears the record', async () => {
    const id = druid('Human');
    outside(id, 'wild_shape', 'Wolf');
    const sheet = combatSheet(db, id);
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: sheet.temp_hp + sheet.hp_current });
    expect(combatSheet(db, id).hp_current).toBe(0);
    // Dropping outside a fight leaves the record; the next fight is where it goes.
    expect(record(id)?.form).toBe('Wolf');
    await ambush();
    expect(pc().flags.wild_shape).toBeUndefined();
    expect(pc().stat_block).toBeNull();
    expect(record(id)).toBeNull();
    expect(combatLog(db, encounter().id).map((e) => e.text).join('\n')).not.toMatch(/still in the Wolf form/);
  });

  it('brings an Incapacitated Druid in unshaped as well', async () => {
    const id = druid('Human');
    outside(id, 'wild_shape', 'Wolf');
    setCondition(db, { campaign_id: campaignId, character_id: id, condition: 'stunned', active: true });
    await ambush();
    expect(pc().flags.wild_shape).toBeUndefined();
    expect(record(id)).toBeNull();
  });
});

// --- 3. Halfling Luck on a clicked d20 ----------------------------------------

describe('Halfling Luck on a d20 the player clicks', () => {
  it('keeps the other die of a Disadvantage pool: a clicked [1, 4] whose 1 comes back an 18 reads 4', async () => {
    druid('Halfling', { level: 1 });
    await ambush();
    updateSettings(db, campaignId, { player_rolls: 'd20_only' });
    const stopClicking = resolvePendingRollsImmediately(db);
    try {
      queueRolls([D20_1, D20_4, D20_18]);
      const rolled = await rollSave(db, encounter(), pc(), 'dex', 12, { advantage: 'disadvantage' });
      // The card really was clicked, with both dice of the pool on it.
      const card = db.prepare('SELECT source, result_json FROM pending_roll ORDER BY id DESC LIMIT 1').get() as {
        source: string;
        result_json: string;
      };
      expect(card.source).toBe('player');
      const groups = (JSON.parse(card.result_json) as { roll: { groups: Array<{ dice: Array<{ value: number }> }> } }).roll.groups;
      expect(groups[0]!.dice.map((d) => d.value)).toEqual([1, 4]);

      expect(rolled.advantage).toBe('disadvantage');
      expect(rolled.natural).toBe(4);
      expect(rolled.total).toBe(4 + rolled.bonus);
      expect(rolled.notes.join(' ')).toMatch(/Halfling Luck: the natural 1 is rerolled and the d20 now reads 4/);
    } finally {
      stopClicking();
    }
  });

  it('lets the new die stand alone on a bare total handed in with no pool', async () => {
    druid('Halfling', { level: 1 });
    await ambush();
    queueRolls([D20_18]);
    const rolled = await rollSave(db, encounter(), pc(), 'dex', 12, { advantage: 'disadvantage', roll: { total: 1, natural: 1 } });
    expect(rolled.natural).toBe(18);
  });
});
