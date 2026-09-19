import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTime } from '../src/core/calendar.js';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  addItem,
  addLanguage,
  setCondition,
  applyDamage,
  awardXp,
  createCharacter,
  deathSave,
  equipItem,
  grantLanguage,
  heal,
  learnSpell,
  levelUp,
  levelUpOptions,
  listCharacterOptions,
  prepareSpells,
  rest,
  setExhaustion,
  stabilize,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { createGameServer } from '../src/mcp/server.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'The Long Road', story_shape: 'sandbox' }).campaign_id;
});

async function connect(): Promise<{ client: Client; done: () => void }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  const unsubscribe = resolvePendingRollsImmediately(db);
  return { client, done: () => { unsubscribe(); void client.close(); } };
}

/** The structured body of a tool reply, or the error message when the tool refused. */
async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent: T;
  };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

const sheet = (characterId?: number): CharacterSummary => getCharacterSheet(db, campaignId, characterId)!;

function make(overrides: Partial<CreateCharacterInput> & { class: string; species: string; background: string }) {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Test',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    ability_bonuses: { str: 2, con: 1 },
    ...overrides,
  } as CreateCharacterInput);
}

const fighter = (overrides: Partial<CreateCharacterInput> = {}) =>
  make({
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    name: 'Borg',
    skill_choices: ['athletics', 'perception'],
    ...overrides,
  });

const wizard = (overrides: Partial<CreateCharacterInput> = {}) =>
  make({
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    name: 'Zel',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'history', 'investigation'],
    cantrips: ['Fire Bolt', 'Light', 'Prestidigitation'],
    spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep'],
    ...overrides,
  });

const cleric = (overrides: Partial<CreateCharacterInput> = {}) =>
  make({
    species: 'Human',
    class: 'Cleric',
    background: 'Acolyte',
    name: 'Sella',
    abilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 },
    ability_bonuses: { wis: 2, cha: 1 },
    skill_choices: ['insight', 'religion', 'medicine'],
    cantrips: ['Guidance', 'Sacred Flame', 'Thaumaturgy'],
    spells: ['Bless', 'Cure Wounds', 'Guiding Bolt', 'Healing Word'],
    ...overrides,
  });

type Spells = { cantrips: string[]; known: string[]; prepared: string[]; spellbook?: string[] };
type Feature = { name: string; source: string; text: string; mechanics?: Record<string, unknown> };
const featuresOf = (id?: number): Feature[] => sheet(id).features as Feature[];
const spellsOf = (id?: number): Spells => sheet(id).spells as Spells;

describe('spell preparation', () => {
  it('rewrites a Cleric list from the class list, and refuses a wrong count or a foreign spell', () => {
    const id = cleric().character!.id;
    expect(() => prepareSpells(db, { campaign_id: campaignId, spells: ['Bless'] })).toThrow(
      /prepares 4 spells of level 1-1; got 1/,
    );
    expect(() =>
      prepareSpells(db, { campaign_id: campaignId, spells: ['Bless', 'Cure Wounds', 'Shield', 'Command'] }),
    ).toThrow(/"Shield" is not a Cleric spell/);
    expect(() =>
      prepareSpells(db, { campaign_id: campaignId, spells: ['Bless', 'Bless', 'Command', 'Bane'] }),
    ).toThrow(/already on the list/);

    const done = prepareSpells(db, {
      campaign_id: campaignId,
      spells: ['Bless', 'Command', 'Bane', 'Cure Wounds'],
    });
    expect(done.prepared).toEqual(['Bless', 'Command', 'Bane', 'Cure Wounds']);
    expect(spellsOf(id).prepared).toEqual(['Bless', 'Command', 'Bane', 'Cure Wounds']);
  });

  it('refuses a class that does not re-prepare, naming the ones that do', () => {
    make({
      species: 'Human',
      class: 'Sorcerer',
      background: 'Acolyte',
      name: 'Ryn',
      abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
      ability_bonuses: { cha: 2, int: 1 },
      skill_choices: ['arcana', 'persuasion', 'insight'],
      cantrips: ['Fire Bolt', 'Light', 'Prestidigitation', 'Shocking Grasp'],
      spells: ['Burning Hands', 'Shield'],
    });
    expect(() => prepareSpells(db, { campaign_id: campaignId, spells: ['Shield', 'Thunderwave'] })).toThrow(
      /does not re-prepare/,
    );
  });

  it('lets a Wizard prepare only from the spellbook', () => {
    const id = wizard().character!.id;
    // Six pages at level 1, the four prepared among them.
    expect(spellsOf(id).spellbook).toHaveLength(6);
    expect(spellsOf(id).spellbook).toEqual(
      expect.arrayContaining(['Magic Missile', 'Shield', 'Mage Armor', 'Sleep']),
    );
    expect(() =>
      prepareSpells(db, { campaign_id: campaignId, spells: ['Magic Missile', 'Shield', 'Sleep', 'Grease'] }),
    ).toThrow(/not in Zel's spellbook/);
    learnSpell(db, { campaign_id: campaignId, spell: 'Grease' });
    expect(spellsOf(id).spellbook).toContain('Grease');
    const done = prepareSpells(db, {
      campaign_id: campaignId,
      spells: ['Magic Missile', 'Shield', 'Sleep', 'Grease'],
    });
    expect(done.prepared).toContain('Grease');
    // The book keeps what was dropped from the prepared list.
    expect(spellsOf(id).spellbook).toContain('Mage Armor');
    expect(spellsOf(id).prepared).not.toContain('Mage Armor');
  });

  it('copies two spells into the spellbook at every Wizard level and prepares out of it', () => {
    const id = wizard().character!.id;
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    const options = levelUpOptions(db, campaignId) as {
      spellcasting: { spellbook: { to_add: number; options: Record<string, string[]> } };
    };
    expect(options.spellcasting.spellbook.to_add).toBe(2);
    expect(options.spellcasting.spellbook.options['1']).not.toContain('Magic Missile');

    expect(() =>
      levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', spells: ['Grease'] } }),
    ).toThrow(/copies 2 new spells/);
    levelUp(db, {
      campaign_id: campaignId,
      choices: { hp: 'average', spells: ['Grease'], spellbook: ['Grease', 'Thunderwave'] },
    });
    expect(spellsOf(id).spellbook).toHaveLength(8);
    expect(spellsOf(id).spellbook!.slice(0, 4)).toEqual(['Magic Missile', 'Shield', 'Mage Armor', 'Sleep']);
    expect(spellsOf(id).spellbook!.slice(-2)).toEqual(['Grease', 'Thunderwave']);
    expect(spellsOf(id).prepared).toContain('Grease');
  });

  it('swaps one cantrip for every caster and one spell for a Sorcerer', () => {
    const id = make({
      species: 'Human',
      class: 'Sorcerer',
      background: 'Acolyte',
      name: 'Ryn',
      abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
      ability_bonuses: { cha: 2, int: 1 },
      skill_choices: ['arcana', 'persuasion', 'insight'],
      cantrips: ['Fire Bolt', 'Light', 'Prestidigitation', 'Shocking Grasp'],
      spells: ['Burning Hands', 'Shield'],
    }).character!.id;
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    const options = levelUpOptions(db, campaignId) as {
      spellcasting: { replace_cantrip: { options: string[] }; replace_spell: { held: string[] } };
    };
    expect(options.spellcasting.replace_cantrip.options).not.toContain('Light');
    expect(options.spellcasting.replace_spell.held).toContain('Burning Hands');

    expect(() =>
      levelUp(db, {
        campaign_id: campaignId,
        choices: { hp: 'average', spells: ['Thunderwave', 'Sleep'], replace_spell: { old: 'Fog Cloud', new: 'Grease' } },
      }),
    ).toThrow(/does not have "Fog Cloud" prepared/);

    levelUp(db, {
      campaign_id: campaignId,
      choices: {
        hp: 'average',
        spells: ['Thunderwave', 'Sleep'],
        replace_cantrip: { old: 'Light', new: 'Ray of Frost' },
        replace_spell: { old: 'Burning Hands', new: 'Grease' },
      },
    });
    const after = spellsOf(id);
    expect(after.cantrips).toContain('Ray of Frost');
    expect(after.cantrips).not.toContain('Light');
    expect(after.prepared).toContain('Grease');
    expect(after.prepared).not.toContain('Burning Hands');
  });

  it('refuses a spell swap from a Wizard, who re-prepares instead', () => {
    wizard();
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    expect(() =>
      levelUp(db, {
        campaign_id: campaignId,
        choices: {
          hp: 'average',
          spells: ['Grease'],
          spellbook: ['Grease', 'Thunderwave'],
          replace_spell: { old: 'Sleep', new: 'Grease' },
        },
      }),
    ).toThrow(/spells {op: prepare}, not on levelling/);
  });
});

describe('rests', () => {
  it('gives a Fighter one Second Wind back on a short rest and all of them on a long one', () => {
    const id = fighter().character!.id;
    const secondWind = () => featuresOf(id).find((f) => f.mechanics?.resource === 'second_wind')!;
    expect(secondWind().mechanics).toMatchObject({ max: 2, per: 'long', regain_on_short: 'one', used: 0 });

    // Two uses spent, as the engine would leave them.
    const features = featuresOf(id);
    features.find((f) => f.mechanics?.resource === 'second_wind')!.mechanics!.used = 2;
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), id);

    const short = rest(db, { campaign_id: campaignId, kind: 'short' }) as { features_restored: string[] };
    expect(short.features_restored).toContain('Second Wind (one use)');
    expect(secondWind().mechanics!.used).toBe(1);

    const long = rest(db, { campaign_id: campaignId, kind: 'long' }) as { features_restored: string[] };
    expect(long.features_restored).toContain('Second Wind');
    expect(secondWind().mechanics!.used).toBe(0);
  });

  it('gives a Monk every Focus Point back on a short rest', () => {
    const id = make({
      species: 'Human',
      class: 'Monk',
      background: 'Acolyte',
      name: 'Kai',
      abilities: { str: 13, dex: 15, con: 14, int: 8, wis: 12, cha: 10 },
      ability_bonuses: { wis: 2, int: 1 },
      skill_choices: ['acrobatics', 'stealth', 'religion'],
    }).character!.id;
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });

    const features = featuresOf(id);
    const focus = features.find((f) => f.mechanics?.resource === 'focus_points')!;
    expect(focus.mechanics).toMatchObject({ max: 2, per: 'short' });
    focus.mechanics!.used = 2;
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), id);

    const short = rest(db, { campaign_id: campaignId, kind: 'short' }) as { features_restored: string[] };
    expect(short.features_restored).toContain('Focus Points');
    expect(featuresOf(id).find((f) => f.mechanics?.resource === 'focus_points')!.mechanics!.used).toBe(0);
  });

  it('turns Bardic Inspiration into a short-rest resource at level 5', () => {
    const id = make({
      species: 'Human',
      class: 'Bard',
      background: 'Acolyte',
      name: 'Lyr',
      abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
      ability_bonuses: { cha: 2, int: 1 },
      skill_choices: ['performance', 'persuasion', 'deception', 'insight'],
      cantrips: ['Vicious Mockery', 'Prestidigitation'],
      spells: ['Charm Person', 'Healing Word', 'Sleep', 'Thunderwave'],
    }).character!.id;
    const inspiration = () => featuresOf(id).find((f) => f.mechanics?.resource === 'bardic_inspiration')!;
    expect(inspiration().mechanics).toMatchObject({ max: 3, per: 'long' }); // CHA modifier
    expect(inspiration().mechanics!.regain_on_short).toBeUndefined();

    awardXp(db, { campaign_id: campaignId, amount: 6500 });
    const climb = (spells: string[], extra: Record<string, unknown> = {}) =>
      levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', spells, ...extra } });
    climb(['Faerie Fire']);
    climb(['Detect Magic'], { subclass: 'College of Lore' });
    climb(['Invisibility'], { ability_increases: { cha: 2 }, cantrips: ['Message'] });
    climb(['Hypnotic Pattern', 'Fear']);
    // Font of Inspiration, at level 5, is what makes it come back on a short rest.
    expect(inspiration().mechanics).toMatchObject({ max: 4, per: 'short' });
  });

  it('spends Arcane Recovery for spell slots once per long rest', () => {
    const id = wizard().character!.id;
    db.prepare("UPDATE character SET spell_slots_json = ? WHERE id = ?").run(
      JSON.stringify({ '1': { max: 2, used: 2 } }),
      id,
    );
    const short = rest(db, { campaign_id: campaignId, kind: 'short', arcane_recovery: true }) as {
      arcane_recovery: string[];
      spell_slots: Record<string, { used: number }>;
    };
    expect(short.arcane_recovery).toEqual(['level 1']);
    expect(short.spell_slots['1']!.used).toBe(1);
    expect(() => rest(db, { campaign_id: campaignId, kind: 'short', arcane_recovery: true })).toThrow(
      /already used Arcane Recovery/,
    );
  });

  it('lifts one exhaustion level on every long rest, food and drink or not', () => {
    fighter();
    setExhaustion(db, { campaign_id: campaignId, delta: 2 });
    const hungry = rest(db, { campaign_id: campaignId, kind: 'long', food_and_drink: false }) as {
      exhaustion: number;
      exhaustion_note?: string;
    };
    expect(hungry.exhaustion).toBe(1);
    expect(hungry.exhaustion_note).toBeUndefined();
    // One long rest per 24 hours: the day has to turn before the next one counts.
    advanceTime(db, campaignId, { hours: 24 });
    expect((rest(db, { campaign_id: campaignId, kind: 'long' }) as { exhaustion: number }).exhaustion).toBe(0);
  });

  it('wakes a stable character at 1 HP after 1d4 hours on the clock', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    const realRandom = Math.random;
    Math.random = () => 0.5; // the 1d4 hours come up 1
    try {
      stabilize(db, { campaign_id: campaignId, source: "a healer's kit" });
    } finally {
      Math.random = realRandom;
    }
    expect(sheet().stable).toBe(true);
    advanceTime(db, campaignId, { hours: 1 });
    expect(sheet().hp_current).toBe(1);
    expect(sheet().stable).toBe(false);
  });
});

describe('dying and stabilising', () => {
  it('stabilises on three successes and starts again when damage lands', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    const realRandom = Math.random;
    Math.random = () => 0.6; // every d20 rolls 13
    try {
      deathSave(db, { campaign_id: campaignId });
      deathSave(db, { campaign_id: campaignId });
      expect(deathSave(db, { campaign_id: campaignId }).stable).toBe(true);
    } finally {
      Math.random = realRandom;
    }
    expect(sheet().stable).toBe(true);

    applyDamage(db, { campaign_id: campaignId, amount: 2 });
    expect(sheet().stable).toBe(false);
  });

  it('refuses to stabilise someone who is not dying, and clears the flag on healing', () => {
    fighter();
    expect(() => stabilize(db, { campaign_id: campaignId })).toThrow(/is not dying/);
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    stabilize(db, { campaign_id: campaignId });
    heal(db, { campaign_id: campaignId, amount: 4 });
    expect(sheet().stable).toBe(false);
  });
});

describe('exhaustion', () => {
  it('moves the level, kills at 6 and takes 2 per level off a player d20 test', async () => {
    fighter();
    expect(setExhaustion(db, { campaign_id: campaignId, delta: 1 }).d20_penalty).toBe(2);
    expect(setExhaustion(db, { campaign_id: campaignId, level: 3 }).exhaustion).toBe(3);
    expect(() => setExhaustion(db, { campaign_id: campaignId, level: 7 })).toThrow(/runs from 0 to 6/);

    const { client, done } = await connect();
    const rolled = await call<{ expr: string; rules_applied?: string[] }>(client, 'roll', {
      campaign_id: campaignId,
      expr: '1d20+5',
      purpose: 'Athletics check',
      roll_type: 'check',
      roller: 'player',
    });
    expect(rolled.expr).toContain('-6');
    expect(rolled.rules_applied).toEqual(['Exhaustion takes 6 off this d20 test.']);
    done();

    const dead = setExhaustion(db, { campaign_id: campaignId, level: 6 });
    expect(dead.status).toBe('dead');
  });

  it('routes the exhaustion condition to the level rather than the condition list', () => {
    fighter();
    const result = setCondition(db, { campaign_id: campaignId, condition: 'exhaustion', active: true }) as {
      conditions: string[];
    };
    expect(result.conditions).not.toContain('exhaustion');
    expect(sheet().exhaustion).toBe(1);
    setCondition(db, { campaign_id: campaignId, condition: 'exhaustion', active: false });
    expect(sheet().exhaustion).toBe(0);
  });
});

describe('feats', () => {
  it('applies an ability increase feat against the cap of 20 and refuses to break it', () => {
    fighter();
    awardXp(db, { campaign_id: campaignId, amount: 2700 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Champion' } });
    // STR is 17 at creation; +2 twice would pass 20.
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', ability_increases: { str: 2 } } });
    awardXp(db, { campaign_id: campaignId, amount: 20000 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    expect(() =>
      levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', ability_increases: { str: 2 } } }),
    ).toThrow(/above 20/);
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', ability_increases: { str: 1, dex: 1 } } });
    expect((sheet().abilities as Record<string, { score: number }>).str.score).toBe(20);
  });

  it('applies the origin feat the background grants, with its spells and its choices', () => {
    // The Acolyte hands out Magic Initiate (Cleric): two cantrips, a spell always prepared, one free cast.
    const id = cleric({
      feat_choices: {
        spell_list: 'cleric',
        spellcasting_ability: 'wis',
        cantrips: ['Light', 'Mending'],
        spell: 'Bane',
      },
    }).character!.id;
    const spells = spellsOf(id) as Spells & { granted: string[] };
    expect(spells.cantrips).toEqual(expect.arrayContaining(['Light', 'Mending']));
    expect(spells.prepared).toContain('Bane');
    expect(spells.granted).toEqual(['Light', 'Mending', 'Bane']);
    const free = featuresOf(id).find((f) => f.name === 'Magic Initiate: Bane')!;
    expect(free.mechanics).toMatchObject({ resource: 'magic_initiate_cleric', max: 1, per: 'long', used: 0 });

    // Its spells are free of the class table: level 2 still adds what the Cleric table says.
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    expect((levelUpOptions(db, campaignId) as { spellcasting: { spells_to_add: number } }).spellcasting.spells_to_add).toBe(1);
  });

  it('refuses a Magic Initiate list that is not one of the three', () => {
    expect(() => cleric({ feat_choices: { spell_list: 'bard' } })).toThrow(/Magic Initiate draws on one list/);
    expect(() =>
      cleric({ feat_choices: { spell_list: 'cleric', spellcasting_ability: 'wis', cantrips: ['Fire Bolt', 'Light'] } }),
    ).toThrow(/is not a Cleric cantrip/);
  });

  it('applies Alert from the Criminal background to the initiative bonus', () => {
    const id = make({
      species: 'Human',
      class: 'Rogue',
      background: 'Criminal',
      name: 'Sly',
      abilities: { str: 8, dex: 15, con: 13, int: 14, wis: 12, cha: 10 },
      ability_bonuses: { dex: 2, int: 1 },
      skill_choices: ['stealth', 'acrobatics', 'perception', 'sleight_of_hand', 'investigation'],
      feature_options: { Expertise: ['stealth', 'perception'] },
    }).character!.id;
    expect(featuresOf(id).find((f) => f.name === 'Alert')!.mechanics).toEqual({ initiative_proficiency: true });
    expect(sheet(id).initiative_bonus).toBe(5); // DEX 3 + proficiency 2
  });

  it('raises a score past 20 only for an Epic Boon, up to 30', () => {
    fighter();
    const options = { campaign_id: campaignId } as const;
    db.prepare("UPDATE character SET level = 18, xp = ? WHERE campaign_id = ?").run(305000, campaignId);
    db.prepare("UPDATE character SET abilities_json = ? WHERE campaign_id = ?").run(
      JSON.stringify({
        str: { score: 20, mod: 5 },
        dex: { score: 10, mod: 0 },
        con: { score: 15, mod: 2 },
        int: { score: 8, mod: -1 },
        wis: { score: 12, mod: 1 },
        cha: { score: 13, mod: 1 },
      }),
      campaignId,
    );
    const epic = levelUpOptions(db, campaignId) as { epic_boon: { feat_options: Array<{ name: string }> } };
    expect(epic.epic_boon.feat_options.length).toBeGreaterThan(0);
    levelUp(db, {
      ...options,
      choices: { hp: 'average', feat: 'Boon of Combat Prowess', feat_choices: { ability: 'str' } },
    });
    expect((sheet().abilities as Record<string, { score: number }>).str.score).toBe(21);
  });
});

describe('species numbers', () => {
  it('gives a Dwarf a hit point per level and puts the size and resistance on the sheet', () => {
    const id = fighter().character!.id;
    expect(sheet(id).hp_max).toBe(13); // d10 + CON 2 + 1 Dwarven Toughness
    expect(sheet(id).size).toBe('Medium');
    expect(sheet(id).resistances).toContain('poison');

    awardXp(db, { campaign_id: campaignId, amount: 300 });
    const levelled = levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    expect(levelled.hp_gained).toBe(9); // 6 average + CON 2 + 1
    expect(sheet(id).hp_max).toBe(22);
  });

  it('marks a Halfling as Small', () => {
    const id = make({
      species: 'Halfling',
      class: 'Rogue',
      background: 'Criminal',
      name: 'Pip',
      abilities: { str: 8, dex: 15, con: 13, int: 14, wis: 12, cha: 10 },
      ability_bonuses: { dex: 2, int: 1 },
      skill_choices: ['stealth', 'acrobatics', 'perception', 'investigation'],
      feature_options: { Expertise: ['stealth', 'perception'] },
    }).character!.id;
    expect(sheet(id).size).toBe('Small');
  });
});

describe('languages', () => {
  it('takes Common plus two, refuses a bad list and fills one in when nobody chose', () => {
    const options = listCharacterOptions({ campaign_id: campaignId }, db) as {
      languages: { options: Array<{ name: string }> };
    };
    expect(options.languages.options.map((l) => l.name)).toContain('Dwarvish');

    expect(() => fighter({ languages: ['Dwarvish'] })).toThrow(/Common and 2 more languages/);
    expect(() => fighter({ languages: ['Dwarvish', 'Dwarvish'] })).toThrow(/only be chosen once/);
    expect(() => fighter({ languages: ['Dwarvish', 'Wookiee'] })).toThrow(/not a language in this campaign/);

    const chosen = fighter({ languages: ['Dwarvish', 'Goblin'] });
    expect((chosen.character!.proficiencies as { languages: string[] }).languages).toEqual([
      'Common',
      'Dwarvish',
      'Goblin',
    ]);

    const filled = fighter({ name: 'Brakka' });
    expect(filled.languages_chosen_for_you).toEqual(['Dwarvish', 'Common Sign Language']);
  });

  it('adds a campaign language, teaches it and shows it on the sheet', () => {
    const id = fighter().character!.id;
    const added = addLanguage(db, {
      campaign_id: campaignId,
      name: 'Old Ashfallen',
      speakers: 'the drowned court',
      script: 'Dwarvish',
    });
    expect(added.languages).toContain('Old Ashfallen');
    expect(
      (db.prepare('SELECT definition FROM glossary_entry WHERE campaign_id = ? AND term = ?').get(
        campaignId,
        'Old Ashfallen',
      ) as { definition: string }).definition,
    ).toMatch(/^Language\. Spoken by the drowned court\./);

    grantLanguage(db, { campaign_id: campaignId, name: 'Old Ashfallen' });
    expect((sheet(id).proficiencies as { languages: string[] }).languages).toContain('Old Ashfallen');
    expect(grantLanguage(db, { campaign_id: campaignId, name: 'Old Ashfallen' }).added).toBe(false);
  });

  it('refuses a roll to understand a language the character does not know', async () => {
    fighter({ languages: ['Dwarvish', 'Goblin'] });
    const { client, done } = await connect();
    await expect(
      call(client, 'roll', {
        campaign_id: campaignId,
        expr: '1d20+2',
        purpose: 'Understand the inscription',
        roll_type: 'check',
        roller: 'player',
        language: 'Elvish',
      }),
    ).rejects.toThrow(/does not know Elvish.*Common, Dwarvish, Goblin/s);

    const known = await call<{ total: number }>(client, 'roll', {
      campaign_id: campaignId,
      expr: '1d20+2',
      purpose: 'Read the runes',
      roll_type: 'check',
      roller: 'player',
      language: 'Dwarvish',
    });
    expect(known.total).toBeGreaterThan(0);
    done();
  });
});

describe('tools', () => {
  it('applies the class tool choices at creation and refuses a wrong pick', () => {
    const options = listCharacterOptions({ class: 'Bard' }) as {
      class_detail: { tool_choices: Array<{ choose: number; from: string[] }> };
    };
    expect(options.class_detail.tool_choices[0]).toMatchObject({ choose: 3 });

    const bard = (tools?: string[]) =>
      make({
        species: 'Human',
        class: 'Bard',
        background: 'Acolyte',
        name: 'Lyr',
        abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
        ability_bonuses: { cha: 2, int: 1 },
        skill_choices: ['performance', 'persuasion', 'deception', 'insight'],
        cantrips: ['Vicious Mockery', 'Prestidigitation'],
        spells: ['Charm Person', 'Healing Word', 'Sleep', 'Thunderwave'],
        feature_options: {},
        ...(tools ? { tools } : {}),
      });
    expect(() => bard(['Lute'])).toThrow(/chooses 3 tool proficiencies/);
    expect(() => bard(['Lute', 'Drum', 'Thieves\' Tools'])).toThrow(/Choose 3 from/);
    const built = bard(['Lute', 'Drum', 'Horn']);
    expect((built.character!.proficiencies as { tools: string[] }).tools).toEqual(
      expect.arrayContaining(['Lute', 'Drum', 'Horn']),
    );
  });

  it('adds the proficiency bonus for a tool, and gives Advantage when a proficient skill applies too', async () => {
    make({
      species: 'Human',
      class: 'Rogue',
      background: 'Criminal',
      name: 'Sly',
      abilities: { str: 8, dex: 15, con: 13, int: 14, wis: 12, cha: 10 },
      ability_bonuses: { dex: 2, int: 1 },
      skill_choices: ['stealth', 'acrobatics', 'perception', 'sleight_of_hand', 'investigation'],
      feature_options: { Expertise: ['stealth', 'perception'] },
    });
    const { client, done } = await connect();
    // Arcana is not one of this Rogue's skills, so the tool adds its bonus and nothing else.
    const added = await call<{ expr: string; rules_applied: string[] }>(client, 'roll', {
      campaign_id: campaignId,
      expr: '1d20+2',
      purpose: 'Arcana check on the lock',
      roll_type: 'check',
      roller: 'player',
      tool: "Thieves' Tools",
    });
    expect(added.expr).toContain('+2+2');
    expect(added.rules_applied[0]).toMatch(/Proficient with Thieves' Tools: \+2 added/);

    const both = await call<{ advantage: string; rules_applied: string[] }>(client, 'roll', {
      campaign_id: campaignId,
      expr: '1d20+7',
      purpose: 'Stealth check past the guard',
      roll_type: 'check',
      roller: 'player',
      tool: "Thieves' Tools",
    });
    expect(both.advantage).toBe('advantage');
    expect(both.rules_applied[0]).toMatch(/that is Advantage, not a second bonus/);

    const untrained = await call<{ expr: string; rules_applied: string[] }>(client, 'roll', {
      campaign_id: campaignId,
      expr: '1d20+1',
      purpose: 'History check on the carving',
      roll_type: 'check',
      roller: 'player',
      tool: "Mason's Tools",
    });
    expect(untrained.expr).toBe('1d20+1');
    expect(untrained.rules_applied[0]).toMatch(/not proficient with Mason's Tools/);
    done();
  });
});

describe('armour and weapon proficiency', () => {
  it('warns on equipping armour the character is not trained in and flags it on the sheet', () => {
    const id = wizard().character!.id;
    expect(sheet(id).armor_penalty).toBe(false);
    addItem(db, { campaign_id: campaignId, name: 'Chain Mail' });
    const equipped = equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: true }) as {
      warning?: string;
      armor_penalty?: boolean;
    };
    expect(equipped.warning).toMatch(/not proficient with Chain Mail.*Disadvantage/s);
    expect(equipped.armor_penalty).toBe(true);
    expect(sheet(id).armor_penalty).toBe(true);

    equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: false });
    expect(sheet(id).armor_penalty).toBe(false);
  });

  it('lists equipped weapons the character has no training with', () => {
    const id = wizard().character!.id;
    addItem(db, { campaign_id: campaignId, name: 'Longsword', equipped: true });
    expect(sheet(id).weapons_not_proficient).toEqual(['Longsword']);
    // A Quarterstaff is a simple weapon, which every Wizard is trained in.
    expect(sheet(fighter({ name: 'Brakka' }).character!.id).weapons_not_proficient).toEqual([]);
  });
});

describe('feature choices', () => {
  it('asks a Rogue for Expertise at creation and applies it', () => {
    const options = listCharacterOptions({ class: 'Rogue' }) as {
      class_detail: { feature_choices: Array<{ feature: string; choose: number }> };
    };
    expect(options.class_detail.feature_choices).toEqual([
      expect.objectContaining({ feature: 'Expertise', choose: 2 }),
      // 2024: a Rogue also names the two weapons whose mastery property it may use.
      expect.objectContaining({ feature: 'Weapon Mastery', choose: 2 }),
    ]);

    const made = make({
      species: 'Human',
      class: 'Rogue',
      background: 'Criminal',
      name: 'Sly',
      abilities: { str: 8, dex: 15, con: 13, int: 14, wis: 12, cha: 10 },
      ability_bonuses: { dex: 2, int: 1 },
      skill_choices: ['stealth', 'acrobatics', 'perception', 'sleight_of_hand', 'investigation'],
      feature_options: { Expertise: ['stealth', 'perception'] },
    });
    const rogue = made.character!;
    // Weapon Mastery was not asked for, so it was picked and named back.
    expect(made.features_chosen_for_you!.join(' ')).toMatch(/Weapon Mastery: \w+, \w+/);
    const skills = rogue.skills as Record<string, { expertise: boolean; bonus: number }>;
    expect(skills.stealth.expertise).toBe(true);
    expect(skills.stealth.bonus).toBe(7); // DEX 3 + double proficiency
    expect(skills.acrobatics.expertise).toBe(false);
  });

  it('refuses an Expertise pick the character is not proficient in', () => {
    expect(() =>
      make({
        species: 'Human',
        class: 'Rogue',
        background: 'Criminal',
        name: 'Sly',
        abilities: { str: 8, dex: 15, con: 13, int: 14, wis: 12, cha: 10 },
        ability_bonuses: { dex: 2, int: 1 },
        skill_choices: ['stealth', 'acrobatics', 'perception', 'sleight_of_hand', 'investigation'],
        feature_options: { Expertise: ['stealth', 'arcana'] },
      }),
    ).toThrow(/"arcana" is not an option for Expertise/);
  });

  it('stores a Fighter Fighting Style with its numbers and fills one in when nobody chose', () => {
    const chosen = fighter({ feature_options: { 'Fighting Style': ['Defense'] } }).character!;
    const style = (chosen.features as Feature[]).find((f) => f.name === 'Fighting Style')!;
    expect(style.mechanics).toMatchObject({ fighting_style: 'Defense', ac_bonus: 1 });
    expect(chosen.ac).toBe(17); // chain mail 16 + Defense

    const filled = fighter({ name: 'Brakka' });
    expect(filled.features_chosen_for_you?.[0]).toMatch(/^Fighting Style: /);
  });

  it('asks a Sorcerer for two Metamagic options at level 2 and a Warlock for invocations', () => {
    const sorcererId = make({
      species: 'Human',
      class: 'Sorcerer',
      background: 'Acolyte',
      name: 'Ryn',
      abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
      ability_bonuses: { cha: 2, int: 1 },
      skill_choices: ['arcana', 'persuasion', 'insight'],
      cantrips: ['Fire Bolt', 'Light', 'Prestidigitation', 'Shocking Grasp'],
      spells: ['Burning Hands', 'Shield'],
    }).character!.id;
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    const options = levelUpOptions(db, campaignId) as {
      feature_choices: Array<{ feature: string; choose: number; from: string[] }>;
    };
    const metamagic = options.feature_choices.find((c) => c.feature === 'Metamagic')!;
    expect(metamagic.choose).toBe(2);
    expect(metamagic.from).toContain('Quickened Spell');

    expect(() =>
      levelUp(db, {
        campaign_id: campaignId,
        choices: { hp: 'average', spells: ['Thunderwave', 'Sleep'], feature_options: { Metamagic: ['Quickened Spell'] } },
      }),
    ).toThrow(/Metamagic takes 2 different pick/);
    levelUp(db, {
      campaign_id: campaignId,
      choices: {
        hp: 'average',
        spells: ['Thunderwave', 'Sleep'],
        feature_options: { Metamagic: ['Quickened Spell', 'Subtle Spell'] },
      },
    });
    expect(featuresOf(sorcererId).find((f) => f.name === 'Metamagic')!.mechanics!.options).toEqual([
      'Quickened Spell',
      'Subtle Spell',
    ]);

    const warlockId = make({
      species: 'Human',
      class: 'Warlock',
      background: 'Acolyte',
      name: 'Hex',
      abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
      ability_bonuses: { cha: 2, int: 1 },
      skill_choices: ['arcana', 'deception', 'history'],
      cantrips: ['Eldritch Blast', 'Prestidigitation'],
      spells: ['Hex', 'Charm Person'],
      // Agonizing Blast and its like are Level 2+ in the SRD text; level 1 offers the pacts and two others.
      feature_options: { 'Eldritch Invocations': ['Pact of the Blade'] },
    }).character!.id;
    expect(featuresOf(warlockId).find((f) => f.name === 'Eldritch Invocations')!.mechanics!.options).toEqual([
      'Pact of the Blade',
    ]);

    awardXp(db, { campaign_id: campaignId, character_id: warlockId, amount: 300 });
    const warlockOptions = levelUpOptions(db, campaignId, warlockId) as {
      feature_choices: Array<{ feature: string; choose: number; from: string[] }>;
    };
    const invocations = warlockOptions.feature_choices.find((c) => c.feature === 'Eldritch Invocations')!;
    expect(invocations.choose).toBe(2); // one at level 1, three at level 2
    expect(invocations.from).not.toContain('Pact of the Blade'); // already held
    expect(invocations.from).toContain('Agonizing Blast'); // Level 2+, and this is level 2
    expect(invocations.from).not.toContain('Thirsting Blade'); // a level 5 invocation
  });
});

describe('backgrounds and starting equipment', () => {
  it('accepts both 2024 background ability patterns', () => {
    expect(fighter({ ability_bonuses: { str: 2, con: 1 } }).character!.abilities).toBeDefined();
    const spread = fighter({ name: 'Brakka', ability_bonuses: { str: 1, dex: 1, con: 1 } }).character!;
    const abilities = spread.abilities as Record<string, { score: number }>;
    expect([abilities.str.score, abilities.dex.score, abilities.con.score]).toEqual([16, 15, 14]);
    expect(() => fighter({ name: 'Nope', ability_bonuses: { str: 3 } })).toThrow(/\+2 and \+1, or by \+1 each/);
  });

  it('takes the background gold bundle and the picks its kit asks for', () => {
    const kit = fighter({ equipment_picks: ['Dragonchess'] }).character!;
    const items = (kit.inventory as Array<{ name: string }>).map((i) => i.name);
    expect(items).toContain('Dragonchess');
    expect(items).not.toContain('Gaming Sets');

    const gold = fighter({ name: 'Brakka', background_equipment_choice: 'b' }).character!;
    expect(gold.gold).toBeGreaterThan(kit.gold);
    expect(() => fighter({ name: 'Nope', equipment_picks: ['Lute'] })).toThrow(/is not one of/);
  });
});
