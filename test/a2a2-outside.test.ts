// A2a-2 outside a fight: lineage spells learned and cast free once a Long Rest, species traits on the
// roll tool's checks and saves, and three follow-ups (an unidentified item's name, Wild Shape, default picks).
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startEncounter, useAction } from '../src/combat/engine.js';
import type { BattleMap } from '../src/combat/map.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, requireEncounter, type Combatant } from '../src/combat/state.js';
import { useFeatureOutsideCombat } from '../src/combat/use-action.js';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  addItem,
  awardXp,
  createCharacter,
  createCompanion,
  levelUp,
  rest,
  useSpellSlot,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { clausesSchema } from '../src/core/mechanics.js';
import { saveHomebrew, validateBackground } from '../src/core/progression.js';
import { XP_THRESHOLDS } from '../src/core/rules.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { findClass, findSpecies, findSpell, skillChoiceGroups } from '../src/srd/lookup.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData } from './helpers/reply.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

// rpg-dice-roller turns each Math.random into one die through its own integer step, so these are measured.
const D20_1 = 0;
const D20_18 = 0.6;

/** The next dice the engine rolls, in order; anything after them rolls as 0.5. */
function queueRolls(values: number[]): void {
  let index = 0;
  Math.random = () => values[index++] ?? 0.5;
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Outside', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- building characters ------------------------------------------------------

/** The first legal pick of every skill group the class and species ask for, without repeats. */
function skillPicks(cls: string, species: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass(cls), findSpecies(species))) {
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

/** A level 1 Fighter of that species and lineage: STR 17, DEX 14, CON 14, INT 8, WIS 10, CHA 12. */
function fighter(species: string, lineage?: string, extra: Partial<CreateCharacterInput> = {}): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: `${species} Fighter`,
    class: 'Fighter',
    species,
    ...(lineage ? { lineage } : {}),
    background: 'Soldier',
    ability_method: 'manual',
    abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks('fighter', species),
    ...extra,
  } as CreateCharacterInput).character!.id as number;
}

/** Levels a Fighter up to `level`: Champion at 3, STR and CON +1 at 4. */
function climbFighter(id: number, level: number): void {
  awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[level - 1]! });
  for (let at = 2; at <= level; at += 1) {
    const choices: LevelUpChoices = { hp: 'average' };
    if (at === 3) choices.subclass = 'Champion';
    if (at === 4) choices.ability_increases = { str: 1, con: 1 };
    levelUp(db, { campaign_id: campaignId, character_id: id, choices });
  }
}

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;
type Spells = { cantrips: string[]; prepared: string[]; granted?: string[]; spellcasting_ability: string | null };
const spellsOf = (id: number): Spells => sheetOf(id).spells as Spells;
type Row = { name: string; source: string; mechanics?: Record<string, unknown> };
const rowsOf = (id: number): Row[] => sheetOf(id).features as Row[];
const rowOf = (id: number, name: string): Row | undefined => rowsOf(id).find((f) => f.name === name);
const slotsOf = (id: number): Record<string, { max: number; used: number }> =>
  sheetOf(id).spell_slots as Record<string, { max: number; used: number }>;

const cast = (id: number, spell: string, level: number) =>
  useSpellSlot(db, { campaign_id: campaignId, character_id: id, level, spell });

// --- A. lineage spells ----------------------------------------------------------

describe('lineage spells', () => {
  it('teaches a level 5 Drow Dancing Lights, Faerie Fire and Darkness, granted beside the class table', () => {
    const id = fighter('Elf', 'Elven Lineage: Drow');
    expect(spellsOf(id).cantrips).toEqual(['Dancing Lights']);
    expect(spellsOf(id).prepared).toEqual([]);
    climbFighter(id, 5);
    const spells = spellsOf(id);
    expect(spells.cantrips).toContain('Dancing Lights');
    expect(spells.prepared).toEqual(expect.arrayContaining(['Faerie Fire', 'Darkness']));
    expect(spells.granted).toEqual(expect.arrayContaining(['Dancing Lights', 'Faerie Fire', 'Darkness']));
    // A Fighter has no casting of its own, so the lineage's ability is the sheet's: CHA 12 is the highest of the three.
    expect(spells.spellcasting_ability).toBe('cha');
    expect(rowOf(id, 'Darkness')!.mechanics).toMatchObject({
      lineage_spell: 'Darkness',
      resource: 'lineage_darkness',
      max: 1,
      per: 'long',
      used: 0,
      spellcasting_ability: 'cha',
    });
  });

  it('casts Darkness once free, then refuses it when the Drow has no slot to cast it with', () => {
    const id = fighter('Elf', 'Elven Lineage: Drow');
    climbFighter(id, 5);
    const free = cast(id, 'Darkness', 2);
    expect(free.free_cast).toEqual({ feature: 'Darkness', left: 0, max: 1 });
    // Darkness is a Concentration spell; cast free it holds no slot level.
    expect(free.concentrating_on).toMatchObject({ spell: 'Darkness', slot_level: null });
    expect(() => cast(id, 'Darkness', 2)).toThrow(/has no level 2 spell slots/);
    expect(rowOf(id, 'Darkness')!.mechanics!.used).toBe(1);
  });

  it('casts Darkness once free, then with a slot, for a Drow who has slots', () => {
    const { companion } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Viress',
      source: { class: 'Wizard', species: 'Elf', lineage: 'Elven Lineage: Drow', background: 'Sage', level: 5 },
    });
    const id = companion!.id as number;
    expect(spellsOf(id).prepared).toEqual(expect.arrayContaining(['Faerie Fire', 'Darkness']));
    const before = slotsOf(id)['2']!.used;
    expect(cast(id, 'Darkness', 2).free_cast?.left).toBe(0);
    expect(slotsOf(id)['2']!.used).toBe(before);
    const slotted = cast(id, 'Darkness', 2);
    expect(slotted.free_cast).toBeUndefined();
    expect(slotsOf(id)['2']!.used).toBe(before + 1);
  });

  it('gives the free cast back on a Long Rest', () => {
    const id = fighter('Elf', 'Elven Lineage: Drow');
    climbFighter(id, 5);
    cast(id, 'Darkness', 2);
    const short = rest(db, { campaign_id: campaignId, character_id: id, kind: 'short' });
    expect(short.features_restored ?? []).not.toContain('Darkness');
    expect(rowOf(id, 'Darkness')!.mechanics!.used).toBe(1);
    const long = rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(long.features_restored).toContain('Darkness');
    expect(cast(id, 'Darkness', 2).free_cast?.left).toBe(0);
  });

  it('lets a Fighter Tiefling (Infernal) cast Hellish Rebuke free at level 3, with the CHA the legacy uses', async () => {
    const id = fighter('Tiefling', 'Fiendish Legacy: Infernal', { lineage_ability: 'cha' });
    expect(spellsOf(id).cantrips).toEqual(expect.arrayContaining(['Fire Bolt', 'Thaumaturgy']));
    climbFighter(id, 3);
    expect(spellsOf(id).prepared).toContain('Hellish Rebuke');
    const { pc, foe } = await ambush();
    const rebuke = (): ReturnType<typeof useAction> =>
      useAction(db, {
        campaign_id: campaignId,
        actor_id: pc,
        action_name: 'Hellish Rebuke',
        spell: 'Hellish Rebuke',
        target_id: foe,
        out_of_turn: true,
        reason: 'the goblin cut them',
      });
    const done = (await rebuke()) as { log: Array<{ text: string }> };
    const text = done.log.map((entry) => entry.text).join('\n');
    expect(text).toMatch(/Hellish Rebuke: this casting costs no spell slot/);
    // 8 + Proficiency Bonus 2 + CHA 1: the legacy's own ability sets the DC.
    expect(text).toMatch(/DEX save vs DC 11/);
    expect(rowOf(id, 'Hellish Rebuke')!.mechanics!.used).toBe(1);
    db.prepare('UPDATE combatant SET reaction_used = 0 WHERE id = ?').run(pc);
    await expect(rebuke()).rejects.toThrow(/no level 1 spell slot left for Hellish Rebuke/);
  });

  it('does not let a level 1 High Elf know Misty Step or Detect Magic, which come at 5 and 3', () => {
    const id = fighter('Elf', 'Elven Lineage: High Elf');
    const spells = spellsOf(id);
    expect(spells.cantrips).toEqual(['Prestidigitation']);
    expect(spells.prepared).not.toContain('Misty Step');
    expect(spells.prepared).not.toContain('Detect Magic');
    expect(rowOf(id, 'Misty Step')).toBeUndefined();
    expect(() => cast(id, 'Misty Step', 2)).toThrow(/has no level 2 spell slots/);
    climbFighter(id, 3);
    expect(spellsOf(id).prepared).toContain('Detect Magic');
    expect(spellsOf(id).prepared).not.toContain('Misty Step');
  });

  it('casts a Wizard Tiefling\'s lineage cantrip with the chosen CHA, not the class\'s INT', async () => {
    const id = createCharacter(db, {
      campaign_id: campaignId,
      name: 'Zeph',
      species: 'Tiefling',
      lineage: 'Fiendish Legacy: Infernal',
      lineage_ability: 'cha',
      class: 'Wizard',
      background: 'Sage',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'investigation'],
      cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
      spells: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic'],
    }).character!.id as number;
    expect(spellsOf(id).spellcasting_ability).toBe('int');
    expect(rowOf(id, 'Fire Bolt')!.mechanics!.spellcasting_ability).toBe('cha');
    const { pc, foe } = await ambush();
    const bolt = (await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: foe,
    })) as { log: Array<{ text: string }> };
    // Proficiency 2 + CHA 0 is +2, three below the +5 the Wizard's INT would give.
    expect(bolt.log.map((entry) => entry.text).join('\n')).toMatch(/Fire Bolt is cast with CHA/);
  });

  it('defaults the lineage ability to the highest of INT, WIS and CHA, and keeps the one chosen', () => {
    const highest = fighter('Gnome', 'Gnomish Lineage: Forest Gnome', { abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 } });
    expect(rowOf(highest, 'Minor Illusion')!.mechanics!.spellcasting_ability).toBe('wis');
    const chosen = fighter('Gnome', 'Gnomish Lineage: Rock Gnome', { lineage_ability: 'int' });
    expect(rowOf(chosen, 'Mending')!.mechanics!.spellcasting_ability).toBe('int');
    expect(() => fighter('Elf', 'Elven Lineage: Wood Elf', { lineage_ability: 'str' as 'int' })).toThrow(/lineage_ability is int, wis or cha/);
  });

  it("gives a Forest Gnome Proficiency Bonus free Speak with Animals casts, and a Wood Elf Druidcraft", () => {
    const gnome = fighter('Gnome', 'Gnomish Lineage: Forest Gnome');
    expect(spellsOf(gnome).prepared).toContain('Speak with Animals');
    expect(rowOf(gnome, 'Gnomish Lineage: Forest Gnome')!.mechanics).toMatchObject({ resource: 'lineage_speak_with_animals', max: 2 });
    cast(gnome, 'Speak with Animals', 1);
    expect(cast(gnome, 'Speak with Animals', 1).free_cast?.left).toBe(0);
    climbFighter(gnome, 5);
    expect(rowOf(gnome, 'Gnomish Lineage: Forest Gnome')!.mechanics!.max).toBe(3);
    const elf = fighter('Elf', 'Elven Lineage: Wood Elf');
    expect(spellsOf(elf).cantrips).toEqual(['Druidcraft']);
    expect(sheetOf(elf).speed).toBe(35);
  });

  it('resolves the SRD spell for the lineage grant when a homebrew spell shares its name', () => {
    saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'spell',
      name: 'Darkness',
      schema: {
        name: 'Darkness',
        level: 1,
        school: 'evocation',
        casting_time: 'action',
        range: '30 feet',
        components: 'V',
        duration: 'Instantaneous',
        concentration: false,
        ritual: false,
        effect: { kind: 'utility' },
        text: 'A house-rule darkness, one level lower.',
      },
    });
    const id = fighter('Elf', 'Elven Lineage: Drow');
    climbFighter(id, 5);
    expect(rowOf(id, 'Darkness')!.mechanics!.lineage_spell).toBe('Darkness');
    // The free cast is the SRD spell's: level 2 and Concentration, not the homebrew one's level 1.
    expect(() => cast(id, 'Darkness', 1)).toThrow(/has no level 1 spell slots/);
    expect(cast(id, 'Darkness', 2).concentrating_on).toMatchObject({ spell: 'Darkness', slot_level: null });
  });

  it('keeps a custom background\'s homebrew spell grant beside the lineage spells', () => {
    saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'background',
      name: 'Night Courier',
      schema: validateBackground({
        name: 'Night Courier',
        abilities: ['str', 'dex', 'con'],
        origin_feat: {
          name: 'Lamplighter',
          text: 'You always have a light about you.',
          mechanics: {},
          clauses: [{ when: 'always', do: [{ kind: 'cantrip_known', name: 'Light' }] }],
        },
        skills: ['stealth', 'insight'],
        tool: "Thieves' Tools",
        equipment: { items: [], gold: 10 },
        text: 'You carried messages after dark.',
      }) as unknown as Record<string, unknown>,
    });
    const id = fighter('Elf', 'Elven Lineage: Drow', { background: 'Night Courier' });
    expect(rowOf(id, 'Lamplighter')).toBeDefined();
    expect(spellsOf(id).granted).toEqual(['Dancing Lights']);
    // The clause's cantrip joins on the fight's sheet, where clause spells are merged in.
    expect(combatSheet(db, id).spells.cantrips).toEqual(expect.arrayContaining(['Dancing Lights', 'Light']));
  });
});

/** A fight against one sturdy goblin, 10 ft away, on the character's turn. */
async function ambush(): Promise<{ pc: number; foe: number }> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 1 }],
  });
  const encounterId = requireEncounter(db, campaignId).id;
  const map: BattleMap = { w: 20, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(20)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), encounterId);
  const all = listCombatants(db, encounterId);
  const pc = all.find((c: Combatant) => c.kind === 'pc')!.id;
  const foe = all.find((c: Combatant) => c.team === 'enemy')!.id;
  db.prepare('UPDATE combatant SET x = 3, y = 5, action_used = 0, bonus_used = 0, reaction_used = 0 WHERE id = ?').run(pc);
  db.prepare('UPDATE combatant SET x = 5, y = 5, hp_max = 200, hp_current = 200 WHERE id = ?').run(foe);
  const index = getBattleState(db, campaignId)!.combatants.findIndex((c) => c.id === pc);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounterId);
  return { pc, foe };
}

// --- B. species traits on the roll tool, with no fight running ----------------

async function connect(): Promise<{ client: Client; done: () => void }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  const unsubscribe = resolvePendingRollsImmediately(db);
  return {
    client,
    done: () => {
      unsubscribe();
      void client.close();
    },
  };
}

interface RollReply {
  total: number | null;
  advantage?: string;
  natural_d20?: number | null;
  output?: string;
  rerolled?: { trait: string; from: number; to: number };
  rules_applied?: string[];
  modifier?: { total_modifier: number };
}

/** One roll tool call, its reply data back, or the refusal thrown. */
async function roll(args: Record<string, unknown>): Promise<RollReply> {
  const { client, done } = await connect();
  try {
    const result = (await client.callTool({
      name: 'roll',
      arguments: { campaign_id: campaignId, purpose: 'A test roll', roller: 'dm', ...args },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    if (result.isError) throw new Error(result.content[0]!.text);
    return replyData<RollReply>(result);
  } finally {
    done();
  }
}

const rules = (reply: RollReply): string => (reply.rules_applied ?? []).join(' ');

describe('Gnomish Cunning outside a fight', () => {
  it('gives a Gnome Advantage on a WIS save, and not on a STR one', async () => {
    fighter('Gnome', 'Gnomish Lineage: Rock Gnome');
    const wis = await roll({ save: 'wis' });
    expect(wis.advantage).toBe('advantage');
    expect(rules(wis)).toMatch(/Gnomish Cunning/);
    const str = await roll({ save: 'str' });
    expect(str.advantage).toBe('none');
    expect(rules(str)).not.toMatch(/Gnomish Cunning/);
  });
});

describe('Halfling Luck outside a fight', () => {
  it('rerolls a natural 1 on a check from dice.ts, and the roll record shows the new die', async () => {
    fighter('Halfling');
    queueRolls([D20_1, D20_18]);
    const check = await roll({ skill: 'athletics' });
    const modifier = check.modifier!.total_modifier;
    expect(check.rerolled).toEqual({ trait: 'Halfling Luck', from: 1, to: 18 });
    expect(check.natural_d20).toBe(18);
    expect(check.total).toBe(18 + modifier);
    expect(rules(check)).toMatch(/Halfling Luck: the natural 1 is rerolled and the d20 now reads 18/);
    const row = db.prepare('SELECT total FROM roll ORDER BY id DESC LIMIT 1').get() as { total: number };
    expect(row.total).toBe(18 + modifier);
    const event = db.prepare("SELECT text FROM event WHERE kind IN ('roll', 'secret_roll') ORDER BY id DESC LIMIT 1").get() as {
      text: string;
    };
    expect(event.text).toMatch(/Halfling Luck rerolls the 1/);
  });

  it('rerolls the natural 1 on the card the player clicks too', async () => {
    fighter('Halfling');
    queueRolls([D20_1, D20_18]);
    const check = await roll({ skill: 'athletics', roller: 'player' });
    expect(check.rerolled?.to).toBe(18);
    expect(check.total).toBe(18 + check.modifier!.total_modifier);
  });

  it('leaves any other natural alone', async () => {
    fighter('Halfling');
    queueRolls([D20_18]);
    const check = await roll({ skill: 'athletics' });
    expect(check.rerolled).toBeUndefined();
    expect(rules(check)).not.toMatch(/Halfling Luck/);
  });
});

describe('Fey Ancestry, Brave and Dwarven Resilience outside a fight', () => {
  it("gives an Elf Advantage on a save against ['charmed'], and nothing against another condition", async () => {
    fighter('Elf', 'Elven Lineage: High Elf');
    const charmed = await roll({ save: 'wis', against: ['charmed'] });
    expect(charmed.advantage).toBe('advantage');
    expect(rules(charmed)).toMatch(/Fey Ancestry: Advantage on a save against being charmed/);
    expect((await roll({ save: 'wis', against: ['Frightened'] })).advantage).toBe('none');
    expect((await roll({ save: 'wis' })).advantage).toBe('none');
  });

  it('gives a Halfling Brave and a Dwarf Dwarven Resilience against their own conditions', async () => {
    fighter('Halfling');
    expect(rules(await roll({ save: 'wis', against: ['frightened'] }))).toMatch(/Brave/);
    fighter('Dwarf');
    expect(rules(await roll({ save: 'con', against: ['poisoned'] }))).toMatch(/Dwarven Resilience/);
  });

  it('refuses against without a save, or a name that is not a condition, before any die', async () => {
    fighter('Elf', 'Elven Lineage: High Elf');
    await expect(roll({ skill: 'insight', against: ['charmed'] })).rejects.toThrow(/pass it with save/);
    await expect(roll({ save: 'wis', against: ['beguiled'] })).rejects.toThrow(/beguiled is not one/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM roll').get()).toEqual({ n: 0 });
  });
});

describe('a Human outside a fight', () => {
  it('gets none of these: no Advantage on a charmed or a mental save, and the natural 1 stands', async () => {
    fighter('Human');
    const charmed = await roll({ save: 'wis', against: ['charmed'] });
    expect(charmed.advantage).toBe('none');
    expect((await roll({ save: 'int' })).advantage).toBe('none');
    queueRolls([D20_1, D20_18]);
    const check = await roll({ skill: 'athletics' });
    expect(check.rerolled).toBeUndefined();
    expect(check.natural_d20).toBe(1);
    expect(rules(check)).not.toMatch(/Luck|Cunning|Ancestry|Brave|Resilience/);
  });
});

// --- C. the follow-ups ---------------------------------------------------------

describe('an unidentified item on a rest', () => {
  it('goes by its kind in the rest journal and the reply, never by its true name', () => {
    const id = fighter('Human');
    db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run('[]', id);
    addItem(db, {
      campaign_id: campaignId,
      character_id: id,
      name: 'Ring of Embers',
      equipped: true,
      magic: {
        rarity: 'uncommon',
        attunement: false,
        mechanics: {
          clauses: clausesSchema.parse([{ when: 'rest_long', do: [{ kind: 'temp_hp', amount: 5 }], uses: { per: 'long', count: 1 } }]),
        },
      },
      unidentified: true,
    });
    const rested = rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    const said = JSON.stringify(rested);
    expect(rested.temp_hp).toBe(5);
    expect(said).toMatch(/Unidentified/);
    expect(said).not.toMatch(/Ring of Embers/);
    const journal = (db.prepare("SELECT text FROM event WHERE kind = 'rest' ORDER BY id").all() as Array<{ text: string }>)
      .map((row) => row.text)
      .join(' ');
    expect(journal).toMatch(/Unidentified.*5 Temporary Hit Points/);
    expect(journal).not.toMatch(/Ring of Embers/);
    const counter = rowsOf(id).find((f) => String(f.mechanics?.resource ?? '').startsWith('homebrew:'))!;
    expect(counter.name).toMatch(/^Unidentified/);
  });
});

describe('casting in Wild Shape outside a fight', () => {
  it('refuses to spend a slot while the Druid wears a Beast form, at no cost, and casts once they revert', () => {
    const { companion } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Bramble',
      source: { class: 'Druid', species: 'Human', background: 'Acolyte', level: 2 },
    });
    const id = companion!.id as number;
    useFeatureOutsideCombat(db, { campaign_id: campaignId, actor_id: id, action_name: 'wild_shape', option: 'Wolf' });
    const before = JSON.stringify(slotsOf(id));
    const events = (db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n;
    expect(() => cast(id, 'Cure Wounds', 1)).toThrow(/in the Wolf form and cannot cast spells.*wild_shape_revert/);
    expect(JSON.stringify(slotsOf(id))).toBe(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n).toBe(events);
    useFeatureOutsideCombat(db, { campaign_id: campaignId, actor_id: id, action_name: 'wild_shape_revert' });
    expect(cast(id, 'Cure Wounds', 1).remaining).toBe(slotsOf(id)['1']!.max - 1);
  });
});

describe('default spell picks', () => {
  it("takes Magic Initiate's spells from the companion picker, not the alphabet", () => {
    const id = createCharacter(db, {
      campaign_id: campaignId,
      name: 'Sella',
      species: 'Human',
      class: 'Cleric',
      background: 'Acolyte',
      ability_method: 'standard_array',
      abilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 },
      ability_bonuses: { wis: 2, cha: 1 },
      skill_choices: ['insight', 'religion', 'medicine'],
      cantrips: ['Guidance', 'Sacred Flame', 'Thaumaturgy'],
      spells: ['Bless', 'Cure Wounds', 'Guiding Bolt', 'Healing Word'],
    }).character!.id as number;
    // Before: Light, Mending and Bane, the first of the Cleric list not yet held.
    expect(rowOf(id, 'Magic Initiate: Shield of Faith')).toBeDefined();
    expect(spellsOf(id).granted).toEqual(['Light', 'Spare the Dying', 'Shield of Faith']);
  });

  it('takes Mystic Arcanum and Magical Discoveries from the companion picker', () => {
    const warlock = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Ash',
      source: { class: 'Warlock', species: 'Human', background: 'Sage', level: 13 },
    }).companion!.id as number;
    // Level 13's arcanum is a level 7 spell: Forcecage, where the alphabet gave Etherealness.
    const arcana = rowsOf(warlock).flatMap((f) => (f.name === 'Mystic Arcanum' ? ((f.mechanics?.options as string[]) ?? []) : []));
    expect(arcana).toEqual(['Circle of Death', 'Forcecage']);
    const bard = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Lute',
      source: { class: 'Bard', species: 'Human', background: 'Sage', level: 6 },
    }).companion!.id as number;
    // Before: Acid Splash and Aid, the alphabet's first two of the borrowed lists.
    expect(rowOf(bard, 'Magical Discoveries')!.mechanics!.options).toEqual(['Fireball', 'Spirit Guardians']);
  });

  it('masters one level 1 and one level 2 spell (Spell Mastery), and refuses two of one level', () => {
    const build = (plan?: LevelUpChoices) =>
      createCompanion(db, {
        campaign_id: campaignId,
        name: 'Orrin',
        source: {
          class: 'Wizard',
          species: 'Human',
          background: 'Sage',
          level: 18,
          ...(plan ? { level_plan: { '18': plan } } : {}),
        },
      });
    const id = build().companion!.id as number;
    const mastered = rowOf(id, 'Spell Mastery')!.mechanics!.options as string[];
    expect(mastered.map((name) => findSpell(name)!.level).sort()).toEqual([1, 2]);
    // Before: the first two of the book's level 1 and 2 spells, which could both be level 1.
    const first = mastered[0]!;
    const book = (sheetOf(id).spells as { spellbook: string[] }).spellbook;
    const sameLevel = book.find((name) => name !== first && findSpell(name)?.level === findSpell(first)!.level)!;
    expect(() => build({ feature_options: { 'Spell Mastery': [first, sameLevel] } })).toThrow(
      /Spell Mastery masters one level 1 and one level 2 spell/,
    );
  });
});
