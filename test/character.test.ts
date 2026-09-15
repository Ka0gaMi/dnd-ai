import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  addItem,
  adjustGold,
  applyDamage,
  awardXp,
  createCharacter,
  createCompanion,
  deathOptions,
  deathSave,
  equipItem,
  grantFeature,
  grantInspiration,
  heal,
  levelUp,
  levelUpOptions,
  listCharacterOptions,
  listInventory,
  listParty,
  promoteCompanion,
  removeItem,
  rest,
  retireCompanion,
  setCondition,
  setTempHp,
  spendInspiration,
  useSpellSlot,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { nowState } from '../src/core/calendar.js';
import { setOverrides } from '../src/core/overrides.js';
import { updateSettings } from '../src/core/settings.js';
import { cancelPendingRolls, openPendingRolls, resolvePendingRoll, restWithPlayerRolls } from '../src/core/rolls.js';
import { clausesSchema } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { combatSheet } from '../src/combat/sheet.js';
import { startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import { pointBuyCost, validateAbilities } from '../src/core/rules.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Ashfall', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => {
  Math.random = realRandom;
});

/** Every d20 comes up 5 and every other die rolls its low-middle value. */
function fixRolls(value: number): void {
  Math.random = () => value;
}

function fighter(overrides: Partial<CreateCharacterInput> = {}) {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
    ...overrides,
  });
}

function wizard() {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'investigation', 'perception'],
    cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
    spells: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic'],
    spellbook: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic', 'Alarm', 'Feather Fall'],
  });
}

const sheet = () => getCharacterSheet(db, campaignId)!;

describe('ability score methods', () => {
  it('accepts the standard array in any order and rejects anything else', () => {
    expect(() =>
      validateAbilities('standard_array', { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }),
    ).not.toThrow();
    expect(() =>
      validateAbilities('standard_array', { str: 8, dex: 10, con: 12, int: 13, wis: 14, cha: 15 }),
    ).not.toThrow();
    expect(() =>
      validateAbilities('standard_array', { str: 16, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }),
    ).toThrow(/standard array/i);
  });

  it('costs point buy per the SRD table and enforces the 27 point budget', () => {
    expect(pointBuyCost({ str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 })).toBe(27);
    expect(pointBuyCost({ str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 })).toBe(0);
    expect(() => validateAbilities('point_buy', { str: 15, dex: 15, con: 15, int: 10, wis: 8, cha: 8 })).toThrow(/27/);
    expect(() => validateAbilities('point_buy', { str: 16, dex: 8, con: 8, int: 8, wis: 8, cha: 8 })).toThrow(/8 and 15/);
    expect(() => validateAbilities('manual', { str: 18, dex: 3, con: 12, int: 12, wis: 12, cha: 12 })).not.toThrow();
    expect(() => validateAbilities('manual', { str: 19, dex: 3, con: 12, int: 12, wis: 12, cha: 12 })).toThrow(/3 to 18/);
  });
});

describe('level 1 creation', () => {
  it('builds a Fighter in chain mail with hit die plus CON hit points', () => {
    const pc = fighter().character!;
    expect(pc.hp_max).toBe(13); // d10 max + CON 2 + 1 Dwarven Toughness
    expect(pc.hp_current).toBe(13);
    expect(pc.ac).toBe(16); // chain mail, no DEX
    expect(pc.speed).toBe(30);
    expect(pc.proficiency_bonus).toBe(2);
    expect(pc.hit_dice).toEqual({ die: 'd10', max: 1, used: 0 });
    const inventory = pc.inventory as Array<{ name: string; equipped?: boolean }>;
    expect(inventory.find((i) => i.name === 'Chain Mail')?.equipped).toBe(true);
    const saves = pc.saves as Record<string, { proficient: boolean; bonus: number }>;
    expect(saves.str).toEqual({ proficient: true, bonus: 5 }); // STR 17 mod 3 + proficiency 2
    expect(saves.dex).toEqual({ proficient: false, bonus: 0 });
    const features = pc.features as Array<{ name: string; source: string }>;
    expect(features.map((f) => f.source)).toContain('species');
    expect(features.map((f) => f.name)).toContain('Second Wind');
  });

  it('adds a shield on top of armour, as a Paladin gets it', () => {
    const pc = createCharacter(db, {
      campaign_id: campaignId,
      name: 'Ser Alys',
      species: 'Human',
      class: 'Paladin',
      background: 'Acolyte',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { cha: 2, wis: 1 },
      skill_choices: ['athletics', 'persuasion', 'insight'],
      spells: ['Bless', 'Cure Wounds'],
    }).character!;
    expect(pc.ac).toBe(18); // chain mail 16 + shield 2
    expect(pc.hp_max).toBe(12);
  });

  it('builds a Wizard with cantrips, prepared spells and one slot level', () => {
    const pc = wizard().character!;
    expect(pc.hp_max).toBe(8); // d6 max + CON 2
    expect(pc.ac).toBe(12); // unarmoured 10 + DEX 2
    const spells = pc.spells as {
      spellcasting_ability: string;
      cantrips: string[];
      prepared: string[];
      granted: string[];
      save_dc: number;
      attack_bonus: number;
    };
    expect(spells.spellcasting_ability).toBe('int');
    // Three class cantrips and four class spells, plus the two cantrips and the spell the Sage
    // background's Magic Initiate hands out, which do not count against the class table.
    expect(spells.cantrips).toHaveLength(5);
    expect(spells.prepared).toHaveLength(5);
    expect(spells.granted).toHaveLength(3);
    expect(spells.save_dc).toBe(13); // 8 + 2 prof + 3 INT
    expect(spells.attack_bonus).toBe(5);
    expect(pc.spell_slots).toEqual({ '1': { max: 2, used: 0 } });
  });

  it('drops a spell repeated case-insensitively among the level 1 picks', () => {
    // The Wizard table demands exactly 4 picks, so a 4th distinct spell fills the slot the duplicate frees.
    const pc = createCharacter(db, {
      campaign_id: campaignId,
      name: 'Zel',
      species: 'Human',
      class: 'Wizard',
      background: 'Sage',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'investigation', 'perception'],
      cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
      spells: ['Detect Magic', 'detect magic', 'Shield', 'Sleep'],
      spellbook: ['Detect Magic', 'Shield', 'Sleep', 'Magic Missile', 'Alarm', 'Feather Fall'],
    }).character!;
    expect((pc.spells as { known: string[] }).known).toEqual(['Detect Magic', 'Shield', 'Sleep']);
  });

  it('rejects the wrong number of prepared spells for a Cleric and accepts four', () => {
    const base: CreateCharacterInput = {
      campaign_id: campaignId,
      name: 'Pia',
      species: 'Halfling',
      class: 'Cleric',
      background: 'Acolyte',
      ability_method: 'point_buy',
      abilities: { str: 13, dex: 12, con: 14, int: 8, wis: 15, cha: 10 },
      ability_bonuses: { wis: 2, cha: 1 },
      skill_choices: ['history', 'medicine'],
      cantrips: ['Guidance', 'Sacred Flame', 'Thaumaturgy'],
      spells: ['Bless', 'Cure Wounds', 'Guiding Bolt'],
    };
    expect(() => createCharacter(db, base)).toThrow(/picks 4 level 1 spells/);
    expect(() => createCharacter(db, { ...base, cantrips: ['Guidance'] })).toThrow(/picks 3 cantrips/);
    expect(() => createCharacter(db, { ...base, spells: ['Bless', 'Cure Wounds', 'Guiding Bolt', 'Fireball'] })).toThrow(
      /not a Cleric level 1 spell/,
    );
    const pc = createCharacter(db, { ...base, spells: ['Bless', 'Cure Wounds', 'Guiding Bolt', 'Healing Word'] })
      .character!;
    // Four from the Cleric table, plus the spell the Acolyte's Magic Initiate always has prepared.
    expect((pc.spells as { prepared: string[] }).prepared).toHaveLength(5);
    expect(pc.ac).toBe(16); // chain shirt 13 + DEX 1 + shield 2
  });

  it('rejects skills that are not on the class list', () => {
    expect(() => fighter({ skill_choices: ['athletics', 'arcana'] })).toThrow(/Choose 2 from/);
    expect(() => fighter({ skill_choices: ['athletics'] })).toThrow(/chooses 2 skill proficiencies/);
    expect(() => fighter({ species: 'Vulcan' })).toThrow(/Unknown species/);
  });

  it('requires background ability increases in a legal pattern', () => {
    expect(() => fighter({ ability_bonuses: { str: 1, dex: 1 } })).toThrow(/str, dex, con/);
    expect(() => fighter({ ability_bonuses: { int: 2, wis: 1 } })).toThrow(/raises only str, dex, con/);
  });

  it('retires the previous character when a new one is created', () => {
    fighter();
    const second = fighter({ name: 'Nim' });
    expect(second.retired_previous).toBe('Borg');
    expect(sheet().name).toBe('Nim');
    const rows = db
      .prepare('SELECT name, status FROM character WHERE campaign_id = ? ORDER BY id')
      .all(campaignId) as Array<{ name: string; status: string }>;
    expect(rows).toEqual([
      { name: 'Borg', status: 'retired' },
      { name: 'Nim', status: 'active' },
    ]);
  });

  it('returns the sheet shapes the companion UI reads', () => {
    const pc = wizard().character!;
    const abilities = pc.abilities as Record<string, { score: number; mod: number }>;
    expect(Object.keys(abilities)).toEqual(['str', 'dex', 'con', 'int', 'wis', 'cha']);
    expect(abilities.int).toEqual({ score: 17, mod: 3 }); // 15 + 2 from the Sage background
    expect(Object.keys(pc.saves as object)).toEqual(['str', 'dex', 'con', 'int', 'wis', 'cha']);
    const skills = pc.skills as Record<string, { ability: string; proficient: boolean; expertise: boolean; bonus: number }>;
    expect(Object.keys(skills)).toHaveLength(18);
    expect(skills.sleight_of_hand).toEqual({ ability: 'dex', proficient: false, expertise: false, bonus: 2 });
    expect(skills.arcana.proficient).toBe(true);
    expect(Object.keys(pc.proficiencies as object).sort()).toEqual(['armor', 'languages', 'tools', 'weapons']);
    expect(pc.conditions).toEqual([]);
    expect(pc.death_saves).toEqual({ successes: 0, failures: 0 });
    expect(pc.passive_perception).toBe(13); // 10 + WIS 1 + prof 2
    expect(pc.initiative_bonus).toBe(2);
    for (const feature of pc.features as Array<{ name: string; source: string; text: string }>) {
      expect(typeof feature.text).toBe('string');
      expect(['class', 'subclass', 'species', 'background', 'feat', 'homebrew']).toContain(feature.source);
    }
  });

  it('de-duplicates a damaged spells_json without touching the stored row', () => {
    const id = wizard().character!.id;
    const damaged = {
      spellcasting_ability: 'int',
      cantrips: ['Light', 'light', 'Mage Hand'],
      known: ['Magic Missile', 'Shield', 'Detect Magic', 'Detect Magic', 'Shield'],
      prepared: ['Magic Missile', 'Shield', 'Detect Magic', 'Detect Magic'],
      save_dc: 13,
      attack_bonus: 5,
    };
    db.prepare('UPDATE character SET spells_json = ? WHERE id = ?').run(JSON.stringify(damaged), id);

    const pc = getCharacterSheet(db, campaignId)!;
    const spells = pc.spells as { cantrips: string[]; known: string[]; prepared: string[] };
    expect(spells.cantrips).toEqual(['Light', 'Mage Hand']);
    expect(spells.known).toEqual(['Magic Missile', 'Shield', 'Detect Magic']);
    expect(spells.prepared).toEqual(['Magic Missile', 'Shield', 'Detect Magic']);

    const row = db.prepare('SELECT spells_json FROM character WHERE id = ?').get(id) as { spells_json: string };
    expect(JSON.parse(row.spells_json).known).toEqual(damaged.known);
  });
});

describe('damage, healing and conditions', () => {
  it('spends temporary hit points first, then real ones, and heals back', () => {
    fighter();
    expect(setTempHp(db, { campaign_id: campaignId, amount: 5, source: 'Second Wind' }).temp_hp).toBe(5);
    // Temporary hit points do not stack: the smaller pool is ignored.
    expect(setTempHp(db, { campaign_id: campaignId, amount: 3 }).temp_hp).toBe(5);

    const first = applyDamage(db, { campaign_id: campaignId, amount: 3, type: 'slashing' });
    expect(first.temp_hp).toBe(2);
    expect(first.hp_current).toBe(13);

    const second = applyDamage(db, { campaign_id: campaignId, amount: 6 });
    expect(second.temp_hp).toBe(0);
    expect(second.hp_current).toBe(9);

    const third = applyDamage(db, { campaign_id: campaignId, amount: 9, source: 'goblin' });
    expect(third.hp_current).toBe(0);
    expect(third.conditions).toContain('unconscious');
    expect(third.status).toBe('active');

    const healed = heal(db, { campaign_id: campaignId, amount: 4 });
    expect(healed.hp_current).toBe(4);
    expect(healed.conditions).not.toContain('unconscious');
    expect(healed.death_saves).toEqual({ successes: 0, failures: 0 });
  });

  it('kills outright on massive damage', () => {
    fighter();
    const hit = applyDamage(db, { campaign_id: campaignId, amount: 26, source: 'ogre' });
    expect(hit.status).toBe('dead');
    expect(hit.hp_current).toBe(0);
    expect(hit.death_options).toEqual(['new_character', 'end_session']);
    expect(sheet().status).toBe('dead');
    expect(() => heal(db, { campaign_id: campaignId, amount: 5 })).toThrow(/dead/);
  });

  it('counts a hit on a downed character as a death save failure', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    const hit = applyDamage(db, { campaign_id: campaignId, amount: 3, critical: true });
    expect(hit.death_saves).toEqual({ successes: 0, failures: 2 });
    expect(hit.status).toBe('active');
  });

  it('only accepts SRD condition names', () => {
    fighter();
    expect(setCondition(db, { campaign_id: campaignId, condition: 'Poisoned', active: true }).conditions).toEqual([
      'poisoned',
    ]);
    expect(setCondition(db, { campaign_id: campaignId, condition: 'poisoned', active: false }).conditions).toEqual([]);
    expect(() => setCondition(db, { campaign_id: campaignId, condition: 'sleepy', active: true })).toThrow(
      /not an SRD condition/,
    );
  });
});

describe('death saves', () => {
  it('kills after three failures and records a canon fact', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    fixRolls(0.05); // every d20 rolls 5

    expect(deathSave(db, { campaign_id: campaignId }).failures).toBe(1);
    expect(deathSave(db, { campaign_id: campaignId }).failures).toBe(2);
    const third = deathSave(db, { campaign_id: campaignId });
    expect(third.failures).toBe(3);
    expect(third.status).toBe('dead');
    expect(third.death_options).toEqual(['new_character', 'end_session']);

    const facts = db
      .prepare('SELECT fact FROM canon_fact WHERE campaign_id = ?')
      .all(campaignId) as Array<{ fact: string }>;
    expect(facts.map((f) => f.fact)).toContain('Borg died.');
    expect(() => deathSave(db, { campaign_id: campaignId })).toThrow(/already dead/);
  });

  it('stabilises after three successes', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    fixRolls(0.1); // every d20 rolls 10

    deathSave(db, { campaign_id: campaignId });
    deathSave(db, { campaign_id: campaignId });
    const third = deathSave(db, { campaign_id: campaignId });
    expect(third.stable).toBe(true);
    expect(third.status).toBe('active');
    expect(third.hp_current).toBe(0);
    expect(third.conditions).toContain('unconscious');
  });
});

describe('rests and spell slots', () => {
  it('restores everything on a long rest', () => {
    wizard();
    useSpellSlot(db, { campaign_id: campaignId, level: 1 });
    applyDamage(db, { campaign_id: campaignId, amount: 4 });
    db.prepare('UPDATE character SET exhaustion = 2 WHERE campaign_id = ?').run(campaignId);

    const rested = rest(db, { campaign_id: campaignId, kind: 'long' });
    expect(rested.hp_current).toBe(rested.hp_max);
    expect(rested.temp_hp).toBe(0);
    expect(rested.exhaustion).toBe(1);
    expect(rested.spell_slots).toEqual({ '1': { max: 2, used: 0 } });
  });

  it('spends hit dice on a short rest and refuses more than are left', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 9 });
    fixRolls(0.1);
    const short = rest(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 });
    expect(short.hit_dice_spent).toBe(1);
    expect(short.healed!).toBeGreaterThan(0);
    expect(short.hit_dice).toEqual({ die: 'd10', max: 1, used: 1 });
    expect(() => rest(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 })).toThrow(/hit dice/);
  });

  it('moves the campaign clock eight hours on a long rest and one on a short', () => {
    fighter();
    const before = nowState(db, campaignId);
    const long = rest(db, { campaign_id: campaignId, kind: 'long' });
    expect(long.now!.hour).toBe((before.hour + 8) % 24);

    const short = rest(db, { campaign_id: campaignId, kind: 'short' });
    expect(short.now!.hour).toBe((before.hour + 9) % 24);
    expect(short.now!.date_text).toBe(nowState(db, campaignId).date_text);
  });

  it('tracks spell slots and refuses to overspend', () => {
    wizard();
    expect(useSpellSlot(db, { campaign_id: campaignId, level: 1 }).remaining).toBe(1);
    expect(useSpellSlot(db, { campaign_id: campaignId, level: 1 }).remaining).toBe(0);
    expect(() => useSpellSlot(db, { campaign_id: campaignId, level: 1 })).toThrow(/no level 1 slots left/);
    expect(() => useSpellSlot(db, { campaign_id: campaignId, level: 3 })).toThrow(/no level 3 spell slots/);
  });
});

/** A homebrew feature granted with rest clauses, the way the DM builder puts one on a sheet. */
function grantRestClause(characterId: number, name: string, clauses: unknown[]): void {
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
}

describe('rest dice the player rolls', () => {
  it('offers the hit dice to the player under player_rolls all, and heals from their roll', async () => {
    fighter();
    updateSettings(db, campaignId, { cheat_mode: true }); // so the test can pick the die itself
    applyDamage(db, { campaign_id: campaignId, amount: 9 });

    const pending = restWithPlayerRolls(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 });
    const cards = openPendingRolls(db, campaignId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ expr: '1d10', purpose: 'Short rest hit dice' });
    resolvePendingRoll(db, cards[0]!.id, { dice: [7] });

    const rested = await pending;
    expect(rested.healed).toBe(9); // the player's 7 plus CON +2
    expect(rested.hit_dice).toEqual({ die: 'd10', max: 1, used: 1 });
    expect(openPendingRolls(db, campaignId)).toEqual([]);
  });

  it('offers a rest_short heal clause to the player and heals from their roll', async () => {
    const pc = fighter().character!;
    updateSettings(db, campaignId, { cheat_mode: true });
    grantRestClause(pc.id, 'Slow Mender', [{ when: 'rest_short', do: [{ kind: 'extra_heal', dice: '1d8' }] }]);
    applyDamage(db, { campaign_id: campaignId, amount: 8 });

    const pending = restWithPlayerRolls(db, { campaign_id: campaignId, kind: 'short' });
    const cards = openPendingRolls(db, campaignId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ expr: '1d8', purpose: 'Slow Mender on a short rest' });
    resolvePendingRoll(db, cards[0]!.id, { dice: [6] });

    const rested = await pending;
    expect(rested.hp_current).toBe(11); // 5 HP plus the 6 the player rolled
    expect(rested.rest_effects?.join(' ')).toMatch(/Slow Mender: heals 6/);
  });

  it('rolls the rest on the server with no card when roll_mode is auto', async () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 9 });
    updateSettings(db, campaignId, { roll_mode: 'auto' });
    fixRolls(0.1); // the server's d10 comes up 10

    const rested = await restWithPlayerRolls(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 });
    expect(openPendingRolls(db, campaignId)).toEqual([]);
    expect(rested.healed).toBe(12);
  });

  it('leaves the rest dice to the server under player_rolls d20_only', async () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 9 });
    updateSettings(db, campaignId, { player_rolls: 'd20_only' });
    fixRolls(0.1);

    const rested = await restWithPlayerRolls(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 });
    expect(openPendingRolls(db, campaignId)).toEqual([]);
    expect(rested.healed).toBe(12);
  });

  it('never asks for a companion, whose rest dice the server rolls', async () => {
    fighter();
    const { companion } = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } });
    applyDamage(db, { campaign_id: campaignId, character_id: companion!.id, amount: 6 });
    fixRolls(0.5);

    const rested = await restWithPlayerRolls(db, {
      campaign_id: campaignId,
      character_id: companion!.id,
      kind: 'short',
      hit_dice_to_spend: 1,
    });
    expect(openPendingRolls(db, campaignId)).toEqual([]);
    expect(rested.hp_current).toBeGreaterThan(5);
  });

  it('rolls the die itself when the player never answers the card', async () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 9 });
    updateSettings(db, campaignId, { roll_timeout_s: 1 });
    fixRolls(0.1);

    const rested = await restWithPlayerRolls(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 });
    expect(rested.healed).toBe(12);
    expect(db.prepare('SELECT source FROM pending_roll WHERE campaign_id = ?').get(campaignId)).toEqual({ source: 'auto' });
  });

  it('rolls the rest itself when a rewind cancels the card, against the current sheet', async () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 9 });
    fixRolls(0.1);

    const pending = restWithPlayerRolls(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 });
    expect(openPendingRolls(db, campaignId)).toHaveLength(1);
    cancelPendingRolls(db, campaignId);

    const rested = await pending;
    expect(rested.hp_current).toBe(13);
    expect(openPendingRolls(db, campaignId)).toEqual([]);
  });
});

describe('experience and level up', () => {
  it('offers level 2 at 300 XP and applies the hit points and features', () => {
    fighter();
    const award = awardXp(db, { campaign_id: campaignId, amount: 300 });
    expect(award.level_up_available).toBe(true);
    const options = award.level_up_options as { to_level: number; hp: { average: number }; features: Array<{ name: string }> };
    expect(options.to_level).toBe(2);
    expect(options.hp.average).toBe(9); // d10 average 6 + CON 2 + 1 Dwarven Toughness
    expect(options.features.length).toBeGreaterThan(0);

    const levelled = levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    expect(levelled.level).toBe(2);
    expect(levelled.hp_gained).toBe(9);
    expect(levelled.character!.hp_max).toBe(22);
    expect(levelled.features_gained.length).toBeGreaterThan(0);
    expect((levelled.character!.hit_dice as { max: number }).max).toBe(2);
    expect(() => levelUp(db, { campaign_id: campaignId })).toThrow(/needs more XP/);
  });

  it('says what the next level costs, in the award and on the player view', () => {
    fighter();
    awardXp(db, { campaign_id: campaignId, amount: 900 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Champion' } });

    const award = awardXp(db, { campaign_id: campaignId, amount: 100 });
    expect(award).toMatchObject({ level: 3, next_level_at: 2700 }); // level 4 sits at 2700 XP
    expect(campaignSnapshot(db, campaignId).pc!.xp_next).toBe(2700);
  });

  it('requires a subclass at 3 and an ability increase or feat at 4', () => {
    fighter();
    awardXp(db, { campaign_id: campaignId, amount: 2700 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });

    expect(() => levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } })).toThrow(/must choose a subclass/);
    const third = levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Champion' } });
    expect(third.subclass).toBe('Champion');
    expect(third.features_gained.length).toBeGreaterThan(0);

    expect(() => levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } })).toThrow(
      /Ability Score Improvement/,
    );
    const fourth = levelUp(db, {
      campaign_id: campaignId,
      choices: { hp: 'average', ability_increases: { str: 2 } },
    });
    expect(fourth.level).toBe(4);
    const abilities = fourth.character!.abilities as Record<string, { score: number; mod: number }>;
    expect(abilities.str).toEqual({ score: 19, mod: 4 });
    const skills = fourth.character!.skills as Record<string, { bonus: number }>;
    expect(skills.athletics.bonus).toBe(6); // STR 4 + proficiency 2
    expect(fourth.character!.hp_max).toBe(40); // 13 + 9 + 9 + 9, Dwarven Toughness included
  });

  it('takes a feat instead of the ability increase', () => {
    fighter();
    awardXp(db, { campaign_id: campaignId, amount: 2700 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Champion' } });
    expect(() => levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', feat: 'Grappler' } })).toThrow(
      /feat_choices.ability as one of str, dex/,
    );
    const fourth = levelUp(db, {
      campaign_id: campaignId,
      choices: { hp: 'average', feat: 'Grappler', feat_choices: { ability: 'str' } },
    });
    const features = fourth.character!.features as Array<{ name: string; source: string }>;
    expect(features.some((f) => f.name === 'Grappler' && f.source === 'feat')).toBe(true);
    // The feat's own Ability Score Increase is applied, not left as text.
    expect((fourth.character!.abilities as Record<string, { score: number }>).str.score).toBe(18);
  });

  it('adds the new prepared spell a Wizard gets at level 2', () => {
    wizard();
    const award = awardXp(db, { campaign_id: campaignId, amount: 300 });
    const options = award.level_up_options as { spellcasting: { spells_to_add: number; cantrips_to_add: number } };
    expect(options.spellcasting.spells_to_add).toBe(1);
    expect(options.spellcasting.cantrips_to_add).toBe(0);
    expect(() => levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } })).toThrow(/1 prepared spell/);
    const levelled = levelUp(db, {
      campaign_id: campaignId,
      choices: { hp: 'average', spells: ['Burning Hands'], spellbook: ['Burning Hands', 'Thunderwave'] },
    });
    const spells = levelled.character!.spells as { prepared: string[] };
    expect(spells.prepared).toHaveLength(6); // 5 from the table + Magic Initiate's
    expect(levelled.character!.spell_slots).toEqual({ '1': { max: 3, used: 0 } });

    // At level 3 the new spell may be of any level the character can cast, not only the highest.
    const third = awardXp(db, { campaign_id: campaignId, amount: 600 });
    const level3 = third.level_up_options as {
      spellcasting: { max_spell_level: number; spell_options: Record<string, string[]> };
    };
    expect(level3.spellcasting.max_spell_level).toBe(2);
    // Spells already known (from creation and the level 2 pick) are not offered again.
    expect(level3.spellcasting.spell_options['1']).not.toContain('Magic Missile');
    expect(level3.spellcasting.spell_options['1']).not.toContain('Burning Hands');
    expect(level3.spellcasting.spell_options['1']).toContain('Comprehend Languages');
    expect(level3.spellcasting.spell_options['2']?.length).toBeGreaterThan(0);
  });

  it('refuses to add a spell the Wizard already knows at level up', () => {
    wizard();
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    expect(() =>
      levelUp(db, {
        campaign_id: campaignId,
        choices: { hp: 'average', spells: ['Detect Magic'], spellbook: ['Burning Hands', 'Thunderwave'] },
      }),
    ).toThrow(/"Detect Magic" is already known/);
  });

  it('does not duplicate a spell already known when levelling up an older, uncleaned sheet', () => {
    const pc = wizard().character!;
    const spells = pc.spells as { known: string[]; prepared: string[]; cantrips: string[]; granted?: string[] };
    // Simulates a sheet written before duplicate validation existed.
    db.prepare('UPDATE character SET spells_json = ? WHERE id = ?').run(
      JSON.stringify({ ...spells, known: [...spells.known, spells.known[0]] }),
      pc.id,
    );
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    const levelled = levelUp(db, {
      campaign_id: campaignId,
      choices: { hp: 'average', spells: ['Burning Hands'], spellbook: ['Burning Hands', 'Thunderwave'] },
    });
    const after = (levelled.character!.spells as { known: string[] }).known;
    expect(after.filter((name) => name.toLowerCase() === spells.known[0]!.toLowerCase())).toHaveLength(1);
  });

  it('does not offer a feat the character already took as another ASI pick', () => {
    fighter();
    awardXp(db, { campaign_id: campaignId, amount: 6500 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Champion' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', feat: 'Grappler', feat_choices: { ability: 'dex' } } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    const options = levelUpOptions(db, campaignId) as {
      ability_score_improvement: { feat_options: Array<{ name: string }> };
    };
    expect(options.ability_score_improvement.feat_options.some((f) => f.name === 'Grappler')).toBe(false);
  });

  it('carries on past level 5', () => {
    fighter();
    awardXp(db, { campaign_id: campaignId, amount: 14000 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Champion' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', ability_increases: { str: 2 } } });
    const fifth = levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    expect(fifth.level).toBe(5);
    // Extra Attack arrives at 5 with the number of swings on it, for the combat engine to read.
    const features = fifth.character!.features as Array<{ name: string; mechanics?: { extra_attacks?: number } }>;
    expect(features.find((f) => f.name === 'Extra Attack')?.mechanics).toEqual({ extra_attacks: 1 });

    // Level 6 is a Fighter's second Ability Score Improvement, not a refusal.
    expect(() => levelUp(db, { campaign_id: campaignId })).toThrow(/Ability Score Improvement/);
    const sixth = levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', ability_increases: { dex: 1, con: 1 } } });
    expect(sixth.level).toBe(6);
    expect(sheet().level).toBe(6);
  });
});

describe('homebrew features', () => {
  it('appends a granted boon to the sheet', () => {
    fighter();
    const granted = grantFeature(db, {
      campaign_id: campaignId,
      name: 'Ashfall Blessing',
      text: 'Once per long rest, reroll a failed save.',
      source: 'homebrew',
    });
    expect(granted.features.at(-1)).toEqual({
      name: 'Ashfall Blessing',
      source: 'homebrew',
      text: 'Once per long rest, reroll a failed save.',
    });
  });

  it('keeps the over-budget marker a homebrew feature was granted with', () => {
    fighter();
    const granted = grantFeature(db, {
      campaign_id: campaignId,
      name: 'Ashfall Blessing',
      text: 'Once per long rest, reroll a failed save.',
      source: 'homebrew',
      mechanics: { homebrew_id: 7, over_budget: true },
    });
    expect(granted.features.at(-1)?.mechanics).toEqual({ homebrew_id: 7, over_budget: true });
  });
});

describe('character options', () => {
  it('lists what a Rogue has to choose', () => {
    const options = listCharacterOptions({ class: 'Rogue' }) as {
      classes: Array<{ name: string }>;
      species: Array<{ name: string }>;
      backgrounds: Array<{ name: string }>;
      class_detail: {
        hit_die: string;
        skill_choices: Array<{ choose: number; from: string[] }>;
        equipment_options: Array<{ label: string }>;
        subclass: { name: string[]; chosen_at_level: number };
        spellcasting: unknown;
        level_1_features: Array<{ name: string; text: string }>;
      };
    };
    expect(options.classes).toHaveLength(12);
    expect(options.species).toHaveLength(9);
    expect(options.backgrounds.length).toBeGreaterThan(0);
    expect(options.class_detail.hit_die).toBe('d8');
    expect(options.class_detail.skill_choices[0]!.choose).toBe(4);
    expect(options.class_detail.skill_choices[0]!.from).toContain('stealth');
    expect(options.class_detail.equipment_options.length).toBeGreaterThan(1);
    expect(options.class_detail.subclass).toEqual({ name: ['Thief'], chosen_at_level: 3 });
    expect(options.class_detail.spellcasting).toBeNull();
    expect(options.class_detail.level_1_features.length).toBeGreaterThan(0);
  });

  it('describes a species and background in detail', () => {
    const options = listCharacterOptions({ species: 'Human', background: 'Sage' }) as {
      species_detail: { speed: number; traits: Array<{ name: string; choose: number | null }> };
      background_detail: { feat: { name: string }; skills: string[] };
    };
    expect(options.species_detail.speed).toBe(30);
    expect(options.species_detail.traits.find((t) => t.name === 'Skillful')?.choose).toBe(1);
    expect(options.background_detail.feat.name).toBe('Magic Initiate');
    expect(options.background_detail.skills).toEqual(['arcana', 'history']);
  });
});

describe('species lineages', () => {
  /** A character of a species that has lineages, built with whichever one the test wants. */
  const lineageFighter = (species: string, lineage?: string) =>
    fighter({ name: 'Kesh', species, ...(lineage === undefined ? {} : { lineage }) });

  it('applies the chosen ancestry of a Dragonborn and lists only its traits', () => {
    const pc = lineageFighter('Dragonborn', 'Draconic Ancestor: Red').character!;
    expect(pc.lineage).toBe('Draconic Ancestor: Red');
    expect(pc.resistances).toContain('fire');
    const traits = (pc.features as Array<{ name: string; source: string }>)
      .filter((f) => f.source === 'species')
      .map((f) => f.name);
    expect(traits).toContain('Damage Resistance: Fire');
    expect(traits).toContain('Breath Weapon: Fire');
    expect(traits).not.toContain('Damage Resistance: Cold');
    expect(traits).not.toContain('Breath Weapon: Acid');
  });

  it('gives an Infernal Tiefling its own resistance and no other legacy', () => {
    const pc = lineageFighter('Tiefling', 'Fiendish Legacy: Infernal').character!;
    expect(pc.resistances).toContain('fire');
    const traits = (pc.features as Array<{ name: string; source: string }>)
      .filter((f) => f.source === 'species')
      .map((f) => f.name);
    expect(traits).toContain('Hellish Rebuke');
    expect(traits).not.toContain('Damage Resistance: Necrotic');
    expect(traits).not.toContain('Poison Spray');
  });

  it('keeps a High Elf clear of the Drow and Wood Elf traits', () => {
    // Keen Senses adds a skill choice of its own, so an Elf picks three.
    const pc = fighter({
      name: 'Kesh',
      species: 'Elf',
      lineage: 'Elven Lineage: High Elf',
      skill_choices: ['athletics', 'perception', 'insight'],
    }).character!;
    const traits = (pc.features as Array<{ name: string; source: string }>)
      .filter((f) => f.source === 'species')
      .map((f) => f.name);
    expect(traits).toContain('Misty Step');
    expect(traits).toContain('Fey Ancestry');
    expect(traits).not.toContain('Faerie Fire');
    expect(traits).not.toContain('Pass without Trace');
    expect(pc.speed).toBe(30); // the Wood Elf's 35 belongs to another lineage
  });

  it('names the choices when the lineage is missing or not one of them', () => {
    expect(() => lineageFighter('Elf')).toThrow(
      'lineage required for Elf: Elven Lineage: Drow, Elven Lineage: High Elf, Elven Lineage: Wood Elf',
    );
    expect(() => lineageFighter('Elf', 'Sea Elf')).toThrow('unknown lineage "Sea Elf" for Elf: Elven Lineage: Drow');
  });

  it('ignores the field for a species without lineages', () => {
    const pc = fighter({
      species: 'Human',
      lineage: 'Elven Lineage: Drow',
      skill_choices: ['athletics', 'perception', 'stealth'],
    }).character!;
    expect(pc.lineage).toBeNull();
  });

  it('reads a sheet from before lineages back with a null one, its traits untouched', () => {
    const pc = lineageFighter('Dragonborn', 'Draconic Ancestor: Red').character!;
    db.prepare('UPDATE character SET lineage = NULL WHERE id = ?').run(pc.id);
    const older = getCharacterSheet(db, campaignId)!;
    expect(older.lineage).toBeNull();
    expect(older.features).toEqual(pc.features);
  });

  it('offers the lineages with their traits in the creation options', () => {
    const options = listCharacterOptions({ species: 'Dragonborn' }) as {
      species: Array<{ name: string; lineages: string[] }>;
      species_detail: {
        traits: Array<{ name: string }>;
        lineages: Array<{ name: string; traits: Array<{ name: string; text: string }> }>;
      };
    };
    expect(options.species.find((s) => s.name === 'Human')!.lineages).toEqual([]);
    expect(options.species.find((s) => s.name === 'Elf')!.lineages).toEqual([
      'Elven Lineage: Drow',
      'Elven Lineage: High Elf',
      'Elven Lineage: Wood Elf',
    ]);
    expect(options.species_detail.lineages).toHaveLength(10);
    const red = options.species_detail.lineages.find((l) => l.name === 'Draconic Ancestor: Red')!;
    expect(red.traits.map((t) => t.name)).toContain('Damage Resistance: Fire');
    expect(options.species_detail.traits.map((t) => t.name)).not.toContain('Damage Resistance: Fire');
  });
});

describe('companions', () => {
  it('builds a class companion from defaults', () => {
    fighter();
    const { companion, party } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
      personality: 'Gentle, and certain the gods are watching.',
    });

    expect(companion).toMatchObject({ name: 'Sella', class: 'Cleric', role: 'companion', level: 1, status: 'active' });
    const abilities = companion!.abilities as Record<string, { score: number }>;
    expect(abilities.wis.score).toBe(17); // 15 standard array + 2 from Acolyte
    expect(abilities.con.score).toBe(14);
    const spells = companion!.spells as { cantrips: string[]; prepared: string[] };
    expect(spells.cantrips.length).toBeGreaterThan(0);
    expect(spells.prepared.length).toBeGreaterThan(0);
    expect((companion!.inventory as unknown[]).length).toBeGreaterThan(0);
    expect(companion!.hp_max).toBeGreaterThan(0);

    // The PC is untouched and the companion joins the party beside them.
    expect(sheet().name).toBe('Borg');
    expect(party.pc?.name).toBe('Borg');
    expect(party.companions.map((c) => c.name)).toEqual(['Sella']);

    const facts = db.prepare('SELECT subject, fact FROM canon_fact WHERE campaign_id = ?').all(campaignId) as Array<{
      subject: string;
      fact: string;
    }>;
    expect(facts.some((f) => f.subject === 'Sella' && f.fact.includes('Gentle'))).toBe(true);
  });

  it('refuses a companion above level 1', () => {
    fighter();
    expect(() =>
      createCompanion(db, {
        campaign_id: campaignId,
        name: 'Sella',
        source: { class: 'Cleric', species: 'Human', background: 'Acolyte', level: 3 },
      }),
    ).toThrow(/not supported yet/);
  });

  it('builds a stat block companion with usable actions', () => {
    fighter();
    const { companion } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Rook',
      source: { creature: 'Wolf' },
    });

    expect(companion).toMatchObject({
      name: 'Rook',
      role: 'companion',
      class: null,
      species: 'Wolf',
      hp_max: 11,
      hp_current: 11,
      ac: 12,
      speed: 40,
      status: 'active',
    });
    const features = companion!.features as Array<{
      name: string;
      source: string;
      mechanics?: Record<string, unknown>;
    }>;
    expect(features.every((f) => f.source === 'stat_block')).toBe(true);
    expect(features[0]!.mechanics).toMatchObject({ creature: 'Wolf', size: 'medium', speed: { walk: 40 } });
    const bite = features.find((f) => f.name === 'Bite');
    expect(bite!.mechanics).toMatchObject({
      kind: 'melee_weapon_attack',
      attack_bonus: 4,
      reach_ft: 5,
      damage: [{ dice: '1d6+2', type: 'piercing' }],
    });
    expect((companion!.skills as Record<string, { bonus: number }>).perception.bonus).toBe(5);
    expect(companion!.hit_dice).toEqual({ die: 'd8', max: 2, used: 0 });

    expect(() => createCompanion(db, { campaign_id: campaignId, name: 'Fang', source: { creature: 'Direwolf' } })).toThrow(
      /No SRD creature/,
    );
  });

  it('applies damage to the companion named by character_id, not the PC', () => {
    fighter();
    const { companion } = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } });
    const hit = applyDamage(db, { campaign_id: campaignId, character_id: companion!.id, amount: 4, type: 'slashing' });

    expect(hit).toMatchObject({ name: 'Rook', hp_current: 7, status: 'active' });
    expect(hit.death_options).toBeUndefined();
    expect(sheet().hp_current).toBe(sheet().hp_max);
    expect(heal(db, { campaign_id: campaignId, character_id: companion!.id, amount: 2 }).hp_current).toBe(9);
    expect(setCondition(db, { campaign_id: campaignId, character_id: companion!.id, condition: 'prone', active: true }).conditions).toEqual(['prone']);
    expect(sheet().conditions).toEqual([]);
  });

  it('lists the party and drops a retired companion from it', () => {
    fighter();
    const { companion } = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } });
    const party = listParty(db, { campaign_id: campaignId });

    expect(party.pc).toMatchObject({ name: 'Borg', role: 'pc', class: 'Fighter', creature: null });
    expect(party.companions).toHaveLength(1);
    expect(party.companions[0]).toMatchObject({
      name: 'Rook',
      role: 'companion',
      class: null,
      creature: 'Wolf',
      hp_current: 11,
      hp_max: 11,
      ac: 12,
      conditions: [],
      inspiration: 0,
    });

    const retired = retireCompanion(db, { campaign_id: campaignId, character_id: companion!.id });
    expect(retired.party.companions).toEqual([]);
  });

  it('offers promote_companion in the death options only while a companion is in the party', () => {
    fighter();
    expect(deathOptions(db, campaignId)).toEqual(['new_character', 'end_session']);

    const { companion } = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } });
    expect(deathOptions(db, campaignId)).toEqual(['new_character', 'promote_companion', 'end_session']);

    retireCompanion(db, { campaign_id: campaignId, character_id: companion!.id });
    expect(deathOptions(db, campaignId)).toEqual(['new_character', 'end_session']);
  });

  it('promotes a companion after the player character dies', () => {
    fighter();
    const { companion } = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } });
    expect(() => promoteCompanion(db, { campaign_id: campaignId, character_id: companion!.id })).toThrow(
      /still the player character/,
    );

    const killed = applyDamage(db, { campaign_id: campaignId, amount: 40, source: 'ogre' });
    expect(killed.death_options).toEqual(['new_character', 'promote_companion', 'end_session']);

    const promoted = promoteCompanion(db, { campaign_id: campaignId, character_id: companion!.id });
    expect(promoted.previous_pc).toBe('Borg');
    expect(promoted.character).toMatchObject({ name: 'Rook', role: 'pc', status: 'active' });
    expect(sheet().name).toBe('Rook');
    expect(listParty(db, { campaign_id: campaignId }).companions).toEqual([]);

    const facts = db.prepare('SELECT fact FROM canon_fact WHERE campaign_id = ?').all(campaignId) as Array<{
      fact: string;
    }>;
    expect(facts.map((f) => f.fact)).toContain("Rook took up the mantle after Borg's death.");
    expect(
      (db.prepare('SELECT status FROM character WHERE name = ?').get('Borg') as { status: string }).status,
    ).toBe('dead');
  });
  it('rests a stat block companion on its own hit dice', () => {
    fighter();
    const { companion } = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } });
    applyDamage(db, { campaign_id: campaignId, character_id: companion!.id, amount: 6 });
    fixRolls(0.5);

    const short = rest(db, { campaign_id: campaignId, character_id: companion!.id, kind: 'short', hit_dice_to_spend: 1 });
    expect(short.hp_current).toBeGreaterThan(5);
    expect(rest(db, { campaign_id: campaignId, character_id: companion!.id, kind: 'long' }).hp_current).toBe(11);
  });
});

describe('heroic inspiration', () => {
  it('grants and spends it, and refuses to spend what is not there', () => {
    fighter();
    expect(sheet().inspiration).toBe(0);
    expect(() => spendInspiration(db, { campaign_id: campaignId })).toThrow(/no Heroic Inspiration/);

    expect(grantInspiration(db, { campaign_id: campaignId }).inspiration).toBe(1);
    expect(grantInspiration(db, { campaign_id: campaignId }).inspiration).toBe(1); // it does not stack
    expect(sheet().inspiration).toBe(1);

    expect(spendInspiration(db, { campaign_id: campaignId }).inspiration).toBe(0);
    expect(sheet().inspiration).toBe(0);
  });

  it('tracks a companion inspiration separately', () => {
    fighter();
    const { companion } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    });
    grantInspiration(db, { campaign_id: campaignId, character_id: companion!.id });

    expect(getCharacterSheet(db, campaignId, companion!.id)?.inspiration).toBe(1);
    expect(sheet().inspiration).toBe(0);
  });
});

describe('gold and inventory', () => {
  const items = () => sheet().inventory as Array<{ name: string; qty: number; equipped?: boolean; notes?: string }>;
  const item = (name: string) => items().find((i) => i.name === name);

  it('buys an item, taking the price out of the purse and copying the SRD detail', () => {
    fighter();
    expect(sheet().gold).toBe(18);

    const bought = addItem(db, { campaign_id: campaignId, name: 'potion of healing', cost_gp: 15 });
    expect(bought.gold).toBe(3);
    expect(sheet().gold).toBe(3);
    expect(bought.item).toMatchObject({ name: 'Potion of Healing', qty: 1, weight_lb: 0.5 });
    // A Potion of Healing is a common magic item as well as a shop item; the note says both.
    expect(bought.item.notes).toBe('Adventuring Gear; 0.5 lb; Potions, common');
    expect(item('Potion of Healing')?.qty).toBe(1);

    const sword = addItem(db, { campaign_id: campaignId, name: 'Longsword' });
    expect(sword.item.notes).toBe('Martial Melee Weapons; 1d8 slashing; Versatile; 3 lb');
  });

  it('refuses to spend gold that is not there, unless debt is allowed', () => {
    fighter();
    expect(() => adjustGold(db, { campaign_id: campaignId, delta: -20, reason: 'a bribe' })).toThrow(
      /has 18 gp and cannot pay 20 gp/,
    );
    expect(() => addItem(db, { campaign_id: campaignId, name: 'Chain Mail', cost_gp: 75 })).toThrow(/cannot pay 75 gp/);
    expect(sheet().gold).toBe(18);
    expect(item('Chain Mail')?.qty).toBe(1); // the refused purchase added nothing

    const debt = adjustGold(db, { campaign_id: campaignId, delta: -20, reason: 'a bribe', allow_debt: true });
    expect(debt).toMatchObject({ gold: -2, in_debt: true });
    expect(sheet().gold).toBe(-2);

    expect(adjustGold(db, { campaign_id: campaignId, delta: 12, reason: 'a bounty' }).gold).toBe(10);
  });

  it('merges a purchase into the stack already carried', () => {
    fighter();
    expect(item('Javelin')?.qty).toBe(8);

    const more = addItem(db, { campaign_id: campaignId, name: 'javelin', qty: 3, cost_gp: 1 });
    expect(more.item.qty).toBe(11);
    expect(items().filter((i) => i.name === 'Javelin')).toHaveLength(1);
    expect(sheet().gold).toBe(17);
  });

  it('removes part of a stack, all of it, and refuses what is not carried', () => {
    fighter();
    expect(removeItem(db, { campaign_id: campaignId, name: 'Javelin', qty: 3 })).toMatchObject({
      removed: 3,
      remaining: 5,
    });
    expect(item('Javelin')?.qty).toBe(5);

    expect(removeItem(db, { campaign_id: campaignId, name: 'javelin' })).toMatchObject({ removed: 5, remaining: 0 });
    expect(item('Javelin')).toBeUndefined();

    expect(() => removeItem(db, { campaign_id: campaignId, name: 'Javelin' })).toThrow(/not carrying "Javelin"/);
    expect(() => removeItem(db, { campaign_id: campaignId, name: 'Spear', qty: 4 })).toThrow(/has 1x Spear, not 4/);
  });

  it('recomputes AC as armour and a shield go on and come off', () => {
    fighter(); // chain mail, DEX 10
    expect(equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: false }).ac).toBe(10);
    expect(equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: true }).ac).toBe(16);

    expect(addItem(db, { campaign_id: campaignId, name: 'Shield', equipped: true }).ac).toBe(18);
    expect(sheet().ac).toBe(18);

    expect(equipItem(db, { campaign_id: campaignId, name: 'Shield', equipped: false }).ac).toBe(16);
    expect(equipItem(db, { campaign_id: campaignId, name: 'chain mail', equipped: false }).ac).toBe(10);
    expect(() => equipItem(db, { campaign_id: campaignId, name: 'Plate Armor', equipped: true })).toThrow(
      /not carrying "Plate Armor"/,
    );
  });

  it('wears one suit of body armour at a time', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Leather Armor', equipped: true });
    expect(item('Chain Mail')?.equipped).toBe(false);
    expect(item('Leather Armor')?.equipped).toBe(true);
    expect(sheet().ac).toBe(11); // leather 11 + DEX 0
  });

  it('keeps a hand-set AC winning over the computed one', () => {
    fighter();
    setOverrides(db, sheet().id, { ac: 21 });
    expect(equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: false }).ac).toBe(10);
    expect(sheet().ac).toBe(21);
  });

  it('tracks a companion purse and pack of their own', () => {
    fighter();
    const { companion } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    });
    adjustGold(db, { campaign_id: campaignId, character_id: companion!.id, delta: 25, reason: 'a temple stipend' });
    addItem(db, { campaign_id: campaignId, character_id: companion!.id, name: 'Torch', qty: 2 });

    const theirs = listInventory(db, { campaign_id: campaignId, character_id: companion!.id });
    expect(theirs.name).toBe('Sella');
    expect(theirs.items.find((i) => i.name === 'Torch')?.qty).toBe(2);
    expect(listInventory(db, { campaign_id: campaignId }).items.find((i) => i.name === 'Torch')).toBeUndefined();
    expect(listInventory(db, { campaign_id: campaignId }).gold).toBe(18);
  });

  it('logs what was paid and what changed hands', () => {
    fighter();
    adjustGold(db, { campaign_id: campaignId, delta: -15, reason: 'a healing potion' });
    addItem(db, { campaign_id: campaignId, name: 'Shield' });
    equipItem(db, { campaign_id: campaignId, name: 'Shield', equipped: true });
    removeItem(db, { campaign_id: campaignId, name: 'Spear' });

    const events = db
      .prepare("SELECT kind, text FROM event WHERE kind IN ('gold', 'inventory') ORDER BY id")
      .all() as Array<{ kind: string; text: string }>;
    expect(events.map((e) => e.text)).toEqual([
      'Borg pays 15 gp for a healing potion (3 gp left).',
      'Borg gains 1x Shield.',
      'Borg equips Shield (AC 18).',
      'Borg loses 1x Spear.',
    ]);
  });
});

describe('carrying capacity', () => {
  it('weighs the pack against STR x 15', () => {
    fighter(); // STR 17
    const carried = listInventory(db, { campaign_id: campaignId });
    expect(carried.capacity_lb).toBe(255);
    expect(carried.carried_lb).toBe(166); // chain mail 55 + pack 55 + the rest
    expect(carried.encumbered).toBe(false);
    expect(sheet()).toMatchObject({ carried_lb: 166, capacity_lb: 255, encumbered: false, speed: 30 });

    removeItem(db, { campaign_id: campaignId, name: 'Chain Mail' });
    expect(listInventory(db, { campaign_id: campaignId }).carried_lb).toBe(111);
  });

  it('takes a weight for an item the SRD does not list and marks an unknown one', () => {
    fighter();
    expect(addItem(db, { campaign_id: campaignId, name: 'Iron Idol', weight_lb: 40 }).item).toMatchObject({
      name: 'Iron Idol',
      weight_lb: 40,
    });
    expect(listInventory(db, { campaign_id: campaignId }).carried_lb).toBe(206);

    const charm = addItem(db, { campaign_id: campaignId, name: 'Lucky Charm', notes: 'a chipped bone die' });
    expect(charm.item).toMatchObject({ weight_lb: 0, notes: 'a chipped bone die; weight unknown' });
    expect(listInventory(db, { campaign_id: campaignId }).carried_lb).toBe(206);
  });

  it('drops the effective speed to 5 ft over capacity, and leaves it alone when the rule is off', () => {
    fighter();
    const overloaded = addItem(db, { campaign_id: campaignId, name: 'Anvil', qty: 2, weight_lb: 100 });
    expect(overloaded.warning).toBe(
      'over carrying capacity (366/255 lb): speed drops to 5 ft until they drop something',
    );
    expect(overloaded.encumbered).toBe(true);
    expect(sheet()).toMatchObject({ speed: 5, carried_lb: 366, encumbered: true });
    expect(combatSheet(db, sheet().id).speed).toBe(5);

    updateSettings(db, campaignId, { encumbrance: 'off' });
    expect(sheet()).toMatchObject({ speed: 30, carried_lb: 366, encumbered: false });
    expect(combatSheet(db, sheet().id).speed).toBe(30);
    expect(addItem(db, { campaign_id: campaignId, name: 'Anvil', qty: 1 }).warning).toBeUndefined();

    updateSettings(db, campaignId, { encumbrance: 'rules' });
    expect(removeItem(db, { campaign_id: campaignId, name: 'Anvil' }).encumbered).toBe(false);
    expect(sheet().speed).toBe(30);
  });

  it('keeps an encumbered character at 5 ft even in armour too heavy for them', () => {
    wizard(); // STR 8: 120 lb of capacity, and Chain Mail needs STR 13
    addItem(db, { campaign_id: campaignId, name: 'Chain Mail' });
    equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: true });
    expect(addItem(db, { campaign_id: campaignId, name: 'Anvil', weight_lb: 100 }).encumbered).toBe(true);

    // The armour's -10 ft cannot take the encumbered crawl below 5 ft.
    expect(sheet()).toMatchObject({ encumbered: true, speed: 5 });
    expect(combatSheet(db, sheet().id).speed).toBe(5);
  });

  it('keeps the fight copy of speed at 5 ft after a later mirror, not 0', async () => {
    wizard(); // STR 8: 120 lb of capacity, and Chain Mail needs STR 13
    addItem(db, { campaign_id: campaignId, name: 'Chain Mail' });
    equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: true });
    addItem(db, { campaign_id: campaignId, name: 'Anvil', weight_lb: 100 });

    const unsub = resolvePendingRollsImmediately(db);
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior', count: 1 }],
    });
    unsub();

    // A later mirror - here, setting a condition - must not re-derive speed from the walk/armour
    // formula and land on 0; it has to stay at the encumbered 5 ft.
    setCondition(db, { campaign_id: campaignId, condition: 'prone', active: true });

    const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
    expect(combatants.find((c) => c.kind === 'pc')!.speed).toBe(5);
  });

  it('backfills legacy inventory items missing weight_lb through list_inventory, and persists it', () => {
    fighter();
    // Simulate a row from before the inventory package tracked weight: every item loses weight_lb.
    const legacy = listInventory(db, { campaign_id: campaignId }).items.map(({ weight_lb, ...rest }) => rest);
    db.prepare('UPDATE character SET inventory_json = ? WHERE campaign_id = ?').run(JSON.stringify(legacy), campaignId);

    const result = listInventory(db, { campaign_id: campaignId });
    expect(result.items.every((i) => i.weight_lb !== undefined)).toBe(true);
    expect(result.carried_lb).toBe(166); // chain mail 55 + pack 55 + the rest, same total once resolved

    const row = db.prepare('SELECT inventory_json FROM character WHERE campaign_id = ?').get(campaignId) as {
      inventory_json: string;
    };
    expect(JSON.parse(row.inventory_json)).toEqual(result.items);
  });

  it('weighs a companion on their party line too', () => {
    fighter();
    const { companion } = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } });
    const line = () => listParty(db, { campaign_id: campaignId }).companions[0]!;
    const roomy = line();
    expect(roomy).toMatchObject({ carried_lb: 0, encumbered: false });
    const speed = roomy.speed;

    addItem(db, { campaign_id: campaignId, character_id: companion!.id, name: 'Anvil', qty: 3, weight_lb: 100 });
    expect(line()).toMatchObject({ carried_lb: 300, capacity_lb: roomy.capacity_lb, encumbered: true, speed: 5 });

    updateSettings(db, campaignId, { encumbrance: 'off' });
    expect(line()).toMatchObject({ encumbered: false, speed });
  });
});
