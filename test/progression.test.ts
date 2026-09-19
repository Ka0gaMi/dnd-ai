import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, rollAndRecord, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  grantLevel,
  levelUp,
  levelUpOptions,
  listCharacterOptions,
  type LevelUpChoices,
} from '../src/core/character.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { clausesSchema, describeClauses } from '../src/core/mechanics.js';
import {
  addPlayNote,
  convertLegacyMechanics,
  findHomebrewBackground,
  listLibrary,
  playProfile,
  powerReport,
  progressionBriefing,
  saveHomebrew,
  saveToLibrary,
  validateBackground,
  validateRecommendations,
  withOptionDetails,
  type OptionDetail,
} from '../src/core/progression.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

const TRAPWRIGHT = {
  name: 'Trapwright',
  abilities: ['dex', 'int', 'wis'],
  origin_feat: 'Alert',
  skills: ['stealth', 'investigation'],
  tool: "Thieves' Tools",
  equipment: { items: [{ name: 'Dagger', qty: 1 }], gold: 15 },
  text: 'You grew up rigging snares in the tunnels under the city.',
};

function rogue(background = 'Criminal'): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Vex',
    species: 'Human',
    class: 'Rogue',
    background,
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
    ability_bonuses: { dex: 2, int: 1 },
    skill_choices: ['acrobatics', 'perception', 'persuasion', 'athletics', 'survival'],
  }).character!.id;
}

function wizard(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'history', 'investigation'],
    cantrips: ['Fire Bolt', 'Light', 'Prestidigitation'],
    spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep'],
  }).character!.id;
}

function sorcerer(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Nyx',
    species: 'Human',
    class: 'Sorcerer',
    background: 'Acolyte',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
    ability_bonuses: { cha: 2, wis: 1 },
    skill_choices: ['deception', 'persuasion', 'sleight_of_hand'],
    cantrips: ['Fire Bolt', 'Light', 'Prestidigitation', 'Message'],
    spells: ['Magic Missile', 'Shield'],
  }).character!.id;
}

const sheetOf = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

/** The first legal pick of every skill group this class and species ask for, without repeats. */
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

/** A Human Soldier of the class named, with the level 1 spells its casting asks for. */
function human(cls: string): number {
  const data = findClass(cls);
  const casting = classLevelRow(data.index, 1).spellcasting;
  return createCharacter(db, {
    campaign_id: campaignId,
    name: `Borin the ${cls}`,
    species: 'Human',
    class: cls,
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(cls),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
  }).character!.id;
}

/** Levels a character to the level named, answering whatever each level asks for. */
function climbTo(characterId: number, level: number, subclass: string): void {
  const owed = XP_THRESHOLDS[level - 1]! - sheetOf(characterId).xp;
  if (owed > 0) awardXp(db, { campaign_id: campaignId, character_id: characterId, amount: owed });
  while (sheetOf(characterId).level < level) {
    const options = levelUpOptions(db, campaignId, characterId) as {
      subclass_choice?: unknown;
      ability_score_improvement?: unknown;
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
      spellcasting?: {
        cantrips_to_add: number;
        spells_to_add: number;
        cantrip_options: string[];
        spell_options: Record<string, string[]>;
      };
    };
    const character = sheetOf(characterId);
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = subclass;
    if (options.ability_score_improvement) {
      const abilities = character.abilities as Record<string, { score: number }>;
      const order = (Object.keys(abilities) as Ability[])
        .filter((a) => abilities[a]!.score < 20)
        .sort((a, b) => abilities[a]!.score - abilities[b]!.score);
      choices.ability_increases = { [order[0]!]: 1, [order[1]!]: 1 } as Partial<Record<Ability, number>>;
    }
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]),
      );
    }
    if (options.spellcasting) {
      const spells = character.spells as { cantrips: string[]; known: string[] };
      const pool = Object.values(options.spellcasting.spell_options).flat();
      choices.cantrips = options.spellcasting.cantrip_options
        .filter((name) => !spells.cantrips.includes(name))
        .slice(0, options.spellcasting.cantrips_to_add);
      choices.spells = pool.filter((name) => !spells.known.includes(name)).slice(0, options.spellcasting.spells_to_add);
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices });
  }
}

/** The options the character faces at their next level, with the tooltip details beside them. */
const optionsWithDetails = (): Record<string, unknown> =>
  withOptionDetails(levelUpOptions(db, campaignId) as Record<string, unknown>);

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Progression', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => db.close());

describe('power budget', () => {
  it('prices each part of a feature against one feat', () => {
    const report = powerReport({
      asi: [{ ability: 'dex', amount: 1 }],
      skill_proficiencies: ['stealth'],
      features_text: 'You always know which way is out.',
    });
    // The prose is a note now, and a note costs 0.25: prose is never free once it carries a rule.
    expect(report.budget_used).toBe(1);
    expect(report.budget_allowed).toBe(1);
    expect(report.verdict).toBe('within');
    expect(report.items.map((i) => i.cost)).toEqual([0.5, 0.25, 0.25]);
    expect(report.items.map((i) => i.part)).toEqual([
      'DEX +1',
      'Proficiency in stealth',
      'You always know which way is out.',
    ]);
    expect(report.text).toContain('Power budget: 1 of 1');
  });

  it('prices the numbers a feature writes into features_text', () => {
    const goblins = powerReport({ features_text: '+1 damage against goblins.' });
    expect(goblins.budget_used).toBe(0.5);
    expect(goblins.verdict).toBe('within');

    const saves = powerReport({ features_text: '+3 to all saving throws' });
    expect(saves.budget_used).toBe(1.5);
    expect(saves.verdict).toBe('over_budget');

    expect(powerReport({ features_text: 'Extra 1d6 fire damage' }).budget_used).toBe(0.5);
    // A range, a count of days or a DC is not a bonus, so the note costs what any note costs.
    expect(powerReport({ features_text: 'Once per 3 days you may reroll' }).budget_used).toBe(0.25);
    // A hyphenated range is not a flat bonus either, even though it ends in "-15".
    expect(powerReport({ features_text: 'Darkvision out to 10-15 feet.' }).budget_used).toBe(0.25);
    expect(powerReport({ features_text: '+1 damage against goblins.' }).budget_used).toBe(0.5);
  });

  it('charges twice as much for extra damage on every hit as once a turn', () => {
    expect(powerReport({ extra_damage: { dice: '1d6', per: 'turn' } }).budget_used).toBe(0.25);
    expect(powerReport({ extra_damage: { dice: '1d6', per: 'hit' } }).budget_used).toBe(0.5);
  });

  it('calls a stack of bonuses over budget', () => {
    const report = powerReport({
      asi: [{ ability: 'str', amount: 2 }],
      to_hit: 1,
      ac: 1,
      speed: 10,
      resistances: ['fire'],
      spells: ['Shield'],
      once_per: 'short',
      effect: 'Vanish from sight',
      effect_cost: 1,
    });
    // 1 + 0.5 + 0.5 + 0.5 + 0.5 + 0.5, and the once-per-rest ability at the 1 the DM priced it at.
    expect(report.budget_used).toBe(4.5);
    expect(report.verdict).toBe('over_budget');
    expect(report.text).toContain('over budget');
  });

  it('keeps the cost the DM put on a once-per-rest ability', () => {
    // effect_cost is the note's own price, and a note is the estimate of the whole thing: no
    // frequency multiplier on top of it.
    expect(powerReport({ once_per: 'long', effect: 'You call the storm down', effect_cost: 1 }).budget_used).toBe(1);
    expect(powerReport({ once_per: 'long', effect: 'You call the storm down' }).budget_used).toBe(0.5);
  });

  it('reads the legacy mechanics fields as clauses and prices them per clause', () => {
    const clauses = convertLegacyMechanics({
      to_hit: 1,
      extra_damage: { dice: '1d6', per: 'turn' },
      once_per: 'long',
      effect: 'Vanish from sight',
      skill_proficiencies: ['stealth'],
    });
    expect(clauses.map((clause) => clause.when)).toEqual(['roll', 'damage_dealt', 'action', 'always']);
    expect(describeClauses(clauses)).toEqual([
      '+1 to attack when you roll an attack roll',
      'Extra 1d6 damage when you deal damage, once per turn',
      'Vanish from sight, 1 per long rest',
      'Proficiency in stealth',
    ]);
  });

  it('prices a clause by what it does, how narrow it is and how often it fires', () => {
    const report = powerReport({
      clauses: clausesSchema.parse([
        {
          when: 'spell_damage',
          if: { damage_type: ['force'] },
          do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
          uses: 'once_per_turn',
        },
      ]),
    });
    expect(report.budget_used).toBe(0.25);
    expect(report.items[0]!.rule).toBe(
      'Extra 1d6 force damage (0.5) × one damage type (0.75) × once per turn (0.5) = 0.19 → floor 0.25',
    );
  });
});

describe('the homebrew store and the personal library', () => {
  it('saves to the library, lists it and keeps it usable from any campaign', () => {
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Trap Sense',
      schema: { text: 'You smell a trap.' },
      report: powerReport({ skill_proficiencies: ['perception'] }),
    });
    expect(entry.scope).toBe('campaign');
    expect(listLibrary(db)).toHaveLength(0);

    const saved = saveToLibrary(db, entry.id);
    expect(saved.scope).toBe('library');
    expect(saved.campaign_id).toBeNull();
    expect(listLibrary(db).map((e) => e.name)).toEqual(['Trap Sense']);

    const other = createCampaign(db, { name: 'Another', story_shape: 'sandbox' }).campaign_id;
    expect(listLibrary(db, 'feature')).toHaveLength(1);
    expect(findHomebrewBackground(db, other, 'Trap Sense')).toBeUndefined();
  });

  it('reads an entry stored before the clause language as clauses', () => {
    const legacy = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Goblin-Bane',
      schema: { text: 'Goblins fear you.', mechanics: { to_hit: 1 } },
      report: powerReport({ to_hit: 1 }),
    });
    expect(describeClauses(legacy.clauses)).toEqual(['+1 to attack when you roll an attack roll']);

    const written = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Forceful Focus',
      schema: {
        text: 'Your force magic bites deeper.',
        clauses: clausesSchema.parse([
          { when: 'always', do: [{ kind: 'resistance', types: ['force'] }] },
        ]),
      },
    });
    expect(describeClauses(written.clauses)).toEqual(['Resistance to force damage']);
  });

  it('stamps a library entry with the level the character stood at', () => {
    const characterId = rogue();
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    expect(
      (db.prepare('SELECT level FROM character WHERE id = ?').get(characterId) as { level: number }).level,
    ).toBe(2);

    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Trap Sense',
      schema: { text: 'You smell a trap.' },
      report: powerReport({ skill_proficiencies: ['perception'] }),
    });
    expect(entry.balanced_at_level).toBeNull();
    expect(saveToLibrary(db, entry.id).balanced_at_level).toBe(2);
    expect(listLibrary(db, 'feature')[0]!.balanced_at_level).toBe(2);
  });
});

describe('custom backgrounds', () => {
  it('refuses a background that breaks the 2024 shape', () => {
    expect(() => validateBackground({ ...TRAPWRIGHT, abilities: ['dex', 'dex', 'int'] })).toThrow(
      /three different abilities/,
    );
    expect(() => validateBackground({ ...TRAPWRIGHT, skills: ['stealth', 'juggling'] })).toThrow(/is not a skill/);
    expect(() => validateBackground({ ...TRAPWRIGHT, skills: ['stealth'] })).toThrow();
  });

  it('builds a character from a background the DM wrote', () => {
    saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'background',
      name: 'Trapwright',
      schema: validateBackground(TRAPWRIGHT) as unknown as Record<string, unknown>,
    });
    const id = rogue('Trapwright');
    const sheet = db.prepare('SELECT * FROM character WHERE id = ?').get(id) as Record<string, string>;
    expect(sheet.background).toBe('Trapwright');
    const skills = JSON.parse(sheet.skills_json) as Record<string, { proficient: boolean }>;
    expect(skills.stealth!.proficient).toBe(true);
    expect(skills.investigation!.proficient).toBe(true);
    const features = JSON.parse(sheet.features_json) as Array<{ name: string }>;
    expect(features.some((f) => f.name === 'Alert')).toBe(true);
    const proficiencies = JSON.parse(sheet.proficiencies_json) as { tools: string[] };
    expect(proficiencies.tools).toContain("Thieves' Tools");
    const inventory = JSON.parse(sheet.inventory_json) as Array<{ name: string }>;
    expect(inventory.some((i) => i.name === 'Dagger')).toBe(true);

    const options = listCharacterOptions({ campaign_id: campaignId, background: 'Trapwright' }, db) as {
      backgrounds: Array<{ name: string; custom: boolean }>;
      background_detail: { name: string; custom: boolean };
    };
    expect(options.backgrounds.find((b) => b.name === 'Trapwright')?.custom).toBe(true);
    expect(options.background_detail.custom).toBe(true);
  });
});

describe('the play profile', () => {
  it('counts tags, picks exemplars and adds what the engine saw', () => {
    const characterId = rogue();
    addPlayNote(db, { campaign_id: campaignId, character_id: characterId, tags: ['trap', 'engineering'], text: 'Short one.' });
    addPlayNote(db, {
      campaign_id: campaignId,
      character_id: characterId,
      tags: ['trap'],
      text: 'Rigged the chandelier to drop on the cultists instead of fighting them head on.',
    });
    expect(() => addPlayNote(db, { campaign_id: campaignId, tags: ['juggling'], text: 'x' })).toThrow(/not a play tag/);

    rollAndRecord(db, { expr: '1d20+5', purpose: 'Stealth check', dc: 14, campaign_id: campaignId });
    rollAndRecord(db, { expr: '1d20+5', purpose: 'Stealth check', dc: 12, campaign_id: campaignId });
    const encounterId = Number(
      db
        .prepare(
          "INSERT INTO encounter (campaign_id, status, seed, map_json, started_at) VALUES (?, 'ended', 1, '{}', '2026-01-01')",
        )
        .run(campaignId).lastInsertRowid,
    );
    const combatantId = Number(
      db
        .prepare("INSERT INTO combatant (encounter_id, kind, character_id, name) VALUES (?, 'pc', ?, 'Vex')")
        .run(encounterId, characterId).lastInsertRowid,
    );
    const log = db.prepare(
      "INSERT INTO combat_log (encounter_id, actor_id, kind, payload_json, text, ts) VALUES (?, ?, ?, ?, 'x', '2026-01-01')",
    );
    log.run(encounterId, combatantId, 'attack', JSON.stringify({ action: 'Shortbow' }));
    log.run(encounterId, combatantId, 'attack', JSON.stringify({ action: 'Shortbow' }));
    log.run(encounterId, combatantId, 'effect_start', JSON.stringify({ name: 'Caltrops' }));

    const profile = playProfile(db, campaignId, characterId);
    expect(profile.tags).toEqual({ trap: 2, engineering: 1 });
    expect(profile.exemplars[0]!.text).toContain('chandelier');
    expect(profile.engine.skills.stealth).toBe(2);
    expect(profile.engine.actions.Shortbow).toBe(2);
    expect(profile.engine.effects.Caltrops).toBe(1);
    expect(profile.excluded_rolls).toBe(0);
  });

  it('leaves the rolls the player edited or the luck dial pulled out of the evidence', () => {
    const characterId = rogue();
    rollAndRecord(db, { expr: '1d20+5', purpose: 'Stealth check', dc: 14, campaign_id: campaignId });
    // An edited roll and a roll the luck dial pulled: both exist, neither says anything about play.
    db.prepare(
      "INSERT INTO roll (campaign_id, expr, results_json, total, purpose, overridden, luck_bias_applied, ts) VALUES (?, '1d20+5', '[]', 25, 'Stealth check', 1, 0, '2026-01-01')",
    ).run(campaignId);
    db.prepare(
      "INSERT INTO roll (campaign_id, expr, results_json, total, purpose, overridden, luck_bias_applied, ts) VALUES (?, '1d20+5', '[]', 24, 'Athletics check', 0, 2, '2026-01-01')",
    ).run(campaignId);

    const profile = playProfile(db, campaignId, characterId);
    expect(profile.engine.skills.stealth).toBe(1);
    expect(profile.engine.skills.athletics).toBeUndefined();
    expect(profile.excluded_rolls).toBe(2);
  });
});

describe('xp_mode and the level-up window', () => {
  it('counts nothing in milestone mode and grants the level on the DM word', () => {
    rogue();
    updateSettings(db, campaignId, { xp_mode: 'milestone' });
    const awarded = awardXp(db, { campaign_id: campaignId, amount: 500 });
    expect(awarded.xp).toBe(0);
    expect(awarded.level_up_available).toBe(false);
    expect(awarded.message).toMatch(/xp {op: milestone}/);

    const granted = grantLevel(db, { campaign_id: campaignId });
    expect(granted.xp).toBe(300);
    expect(granted.level_up_available).toBe(true);
    expect((granted.level_up_options as { to_level: number }).to_level).toBe(2);
    expect(levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } }).level).toBe(2);
  });

  it('refuses xp {op: milestone} while the campaign counts experience points', () => {
    rogue();
    expect(() => grantLevel(db, { campaign_id: campaignId })).toThrow(/counts experience points/);
    const awarded = awardXp(db, { campaign_id: campaignId, amount: 300 });
    expect(awarded.level_up_available).toBe(true);
    expect(awarded.hint).toMatch(/propose_level_up_options/);
  });

  it('puts a homebrew choice on the sheet when the level is applied', () => {
    rogue();
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Snare Master',
      schema: { text: 'Your snares are harder to spot.' },
      report: powerReport({ to_hit: 1, ac: 1, speed: 10 }),
      power_label: 'over_budget',
    });
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    expect(() => levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', homebrew_ids: [999] } })).toThrow(
      /No homebrew with id 999/,
    );
    const levelled = levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', homebrew_ids: [entry.id] } });
    expect(levelled.features_gained).toContain('Snare Master');
    const features = levelled.character!.features as Array<{ name: string; mechanics?: { over_budget?: boolean } }>;
    expect(features.find((f) => f.name === 'Snare Master')?.mechanics?.over_budget).toBe(true);
  });
});

describe('the progression briefing', () => {
  it('is empty for a fresh story with default modes and nothing waiting', () => {
    expect(progressionBriefing(db, campaignId)).toBe('');
  });

  it('names the modes, the waiting level-up and the top play tags', () => {
    const characterId = rogue();
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    addPlayNote(db, { campaign_id: campaignId, character_id: characterId, tags: ['trap'], text: 'Rigged a snare.' });
    db.prepare('UPDATE character SET pending_level_up_json = ? WHERE id = ?').run(
      JSON.stringify({ to_level: 2, suggestions: [] }),
      characterId,
    );
    const briefing = progressionBriefing(db, campaignId);
    expect(briefing).toContain('Rules mode: freeform');
    expect(briefing).toContain('XP mode: xp');
    expect(briefing).toContain('options for level 2 are prepared');
    expect(briefing).toContain('trap x1');
    expect(briefing).toContain('Rigged a snare.');
  });
});

describe('the level-up option details', () => {
  it('describes every spell a wizard can add at level 2', () => {
    wizard();
    awardXp(db, { campaign_id: campaignId, amount: 400 });
    const options = optionsWithDetails();
    const details = options.details as Record<string, OptionDetail>;
    const spells = (options.spellcasting as { spell_options: Record<string, string[]> }).spell_options['1']!;

    // Magic Missile is already known from creation, so it is not offered again.
    expect(spells).not.toContain('Magic Missile');
    expect(spells).toContain('Comprehend Languages');
    expect(spells.every((name) => details[name] !== undefined)).toBe(true);
    expect(details['Comprehend Languages']).toMatchObject({
      name: 'Comprehend Languages',
      level: 1,
      school: 'divination',
      casting_time: 'action',
      range: 'Self',
      duration: '1 hour',
      concentration: false,
    });
    expect(details['Comprehend Languages']!.short_text).toContain('understand');
    expect(details['Comprehend Languages']!.short_text.length).toBeLessThanOrEqual(300);
  });

  it('describes a sorcerer subclass by what it gives at level 3', () => {
    sorcerer();
    awardXp(db, { campaign_id: campaignId, amount: 900 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', spells: ['Burning Hands', 'Sleep'] } });
    const options = optionsWithDetails();
    const details = options.details as Record<string, OptionDetail>;

    expect(options.to_level).toBe(3);
    expect((options.subclass_choice as Array<{ name: string }>).map((s) => s.name)).toContain('Draconic Sorcery');
    expect(details['Draconic Sorcery']!.short_text).toContain('Draconic Resilience');
    expect(details['Draconic Sorcery']!.short_text.length).toBeLessThanOrEqual(300);
  });

  it('describes the feats and the ability scores at an ability score improvement', () => {
    rogue();
    awardXp(db, { campaign_id: campaignId, amount: 2700 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Thief' } });
    const details = optionsWithDetails().details as Record<string, OptionDetail>;

    expect(details['Grappler']).toMatchObject({ name: 'Grappler', prerequisite: 'Level 4; Strength or Dexterity 13+' });
    expect(details['dex']).toEqual({ name: 'Dexterity', short_text: 'Agility, reflexes, and balance' });
  });
});

describe('the DM recommendations among the SRD options', () => {
  it('accepts what is on offer and answers in the SRD spelling', () => {
    sorcerer();
    awardXp(db, { campaign_id: campaignId, amount: 900 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', spells: ['Burning Hands', 'Sleep'] } });
    const checked = validateRecommendations(optionsWithDetails(), {
      spells: [{ name: 'charm person', why: 'They talk their way past every guard.' }],
      subclass: { name: 'draconic sorcery', why: 'Their magic has been dragon-touched since the egg.' },
      hp: 'average',
    });

    expect(checked.spells).toEqual([{ name: 'Charm Person', why: 'They talk their way past every guard.' }]);
    expect(checked.subclass!.name).toBe('Draconic Sorcery');
    expect(checked.hp).toBe('average');
  });

  it('refuses a spell that is not on offer and lists the ones that are', () => {
    wizard();
    awardXp(db, { campaign_id: campaignId, amount: 400 });
    const options = optionsWithDetails();

    expect(() => validateRecommendations(options, { spells: [{ name: 'Fireball', why: 'Boom.' }] })).toThrow(
      /"Fireball" is not among the spells offered at this level\. Valid options: .*Comprehend Languages/,
    );
    expect(() => validateRecommendations(options, { feat: { name: 'Alert', why: 'Fast.' } })).toThrow(
      /No feats are offered at this level/,
    );
  });
});

describe('a class resource lands on the feature of its own name', () => {
  interface SheetFeature {
    name: string;
    text: string;
    source?: string;
    mechanics?: { resource?: string; max?: number; used?: number };
  }
  const featuresOf = (id: number): SheetFeature[] => sheetOf(id).features as SheetFeature[];

  it('leaves a Fighter one Second Wind and one Weapon Mastery', () => {
    const features = featuresOf(human('Fighter'));
    const names = features.map((f) => f.name);
    expect(names).toHaveLength(new Set(names).size);

    const secondWind = features.filter((f) => f.mechanics?.resource === 'second_wind');
    const mastery = features.filter((f) => f.mechanics?.resource === 'weapon_mastery');
    expect(secondWind).toHaveLength(1);
    expect(mastery).toHaveLength(1);
    expect(secondWind[0]!.mechanics!.max).toBe(2);
    // The fuller SRD prose is what stays once the counter merges onto it.
    expect(secondWind[0]!.text).not.toContain('per long rest');
  });

  it('keeps one Channel Divinity on a Paladin who reaches level 3', () => {
    const id = human('Paladin');
    climbTo(id, 3, 'Oath of Devotion');
    const features = featuresOf(id);
    expect(features.filter((f) => f.name === 'Channel Divinity')).toHaveLength(1);

    const channel = features.find((f) => f.name === 'Channel Divinity')!;
    expect(channel.text.startsWith('You can channel divine energy')).toBe(true);
    expect(channel.mechanics).toMatchObject({ resource: 'channel_divinity', max: 2 });
  });

  it('keeps what a Barbarian spent when the Rage counter grows', () => {
    const id = human('Barbarian');
    climbTo(id, 2, 'Path of the Berserker');
    const spent = featuresOf(id);
    spent.find((f) => f.mechanics?.resource === 'rage')!.mechanics!.used = 1;
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(spent), id);

    climbTo(id, 3, 'Path of the Berserker');
    const features = featuresOf(id);
    const rage = features.filter((f) => f.mechanics?.resource === 'rage');
    expect(features.filter((f) => f.name === 'Rage')).toHaveLength(1);
    expect(rage).toHaveLength(1);
    expect(rage[0]!.mechanics).toMatchObject({ max: 3, used: 1 });
    // The second bump of the number must not overwrite the SRD prose the counter rode onto.
    expect(rage[0]!.text.startsWith('You can imbue yourself with a primal power')).toBe(true);
  });
});
