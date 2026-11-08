import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  createCompanion,
  grantSpellRuling,
  levelUp,
  levelUpOptions,
  listCharacterOptions,
  type CreateCharacterInput,
  type InventoryItem,
  type LevelUpChoices,
} from '../src/core/character.js';
import { saveHomebrew, validateBackground } from '../src/core/progression.js';
import { XP_THRESHOLDS, itemsWeight, type Ability } from '../src/core/rules.js';
import { combatSheet } from '../src/combat/sheet.js';
import { openDb, type Db } from '../src/db/connection.js';
import {
  equipmentBundles,
  findClass,
  findBackground,
  packContents,
  resolveItemWeight,
  skillChoiceGroups,
} from '../src/srd/lookup.js';
import * as srd from '../src/srd/data.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Creation', story_shape: 'sandbox' }).campaign_id;
});

type Feature = { name: string; source: string; mechanics?: Record<string, unknown> };
const features = (pc: CharacterSummary): Feature[] => pc.features as Feature[];
const inventory = (pc: CharacterSummary): InventoryItem[] => pc.inventory as InventoryItem[];
const skills = (pc: CharacterSummary) => pc.skills as Record<string, { proficient: boolean }>;
const proficientSkills = (pc: CharacterSummary): string[] =>
  Object.entries(skills(pc))
    .filter(([, entry]) => entry.proficient)
    .map(([key]) => key)
    .sort();
const counts = () => ({
  characters: (db.prepare('SELECT COUNT(*) AS n FROM character').get() as { n: number }).n,
  events: (db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n,
});

function make(overrides: Partial<CreateCharacterInput> = {}) {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['perception', 'survival'],
    ...overrides,
  });
}

/** A Human Fighter: the Skillful trait adds a third skill choice. */
const human = (overrides: Partial<CreateCharacterInput> = {}) =>
  make({ name: 'Ada', species: 'Human', skill_choices: ['perception', 'survival', 'stealth'], ...overrides });

/** The custom background a DM wrote, with an invented origin feat, an SRD pack and an item the SRD lacks. */
function hedgeBackground(items: Array<{ name: string; qty: number }>) {
  return saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'background',
    name: 'Hedge Witch',
    schema: validateBackground({
      name: 'Hedge Witch',
      abilities: ['str', 'dex', 'con'],
      origin_feat: {
        name: 'Hedge Lore',
        text: 'The wild tells you where things hide.',
        mechanics: {},
        clauses: [{ when: 'always', do: [{ kind: 'proficiency', skill: 'nature' }] }],
      },
      skills: ['nature', 'medicine'],
      tool: 'Herbalism Kit',
      equipment: { items, gold: 5 },
      text: 'You grew up at the edge of the wood.',
    }) as unknown as Record<string, unknown>,
  });
}

// --- 1. Weapon Mastery defaults follow the kit ---------------------------------

describe('default Weapon Mastery picks', () => {
  it("takes a Fighter's kit weapons rather than the alphabetically first ones", () => {
    const made = make();
    expect(made.features_chosen_for_you).toContain('Weapon Mastery: Greatsword, Flail, Javelin');
    expect(made.character!.mastery_weapons).toEqual(['Greatsword', 'Flail', 'Javelin']);
  });

  it('follows the kit for a companion, who is never asked', () => {
    make();
    const { companion } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Grak',
      source: { class: 'Barbarian', species: 'Dwarf', background: 'Soldier' },
    });
    expect(companion!.mastery_weapons).toEqual(['Greataxe', 'Handaxe']);
  });

  it('takes a carried weapon for the mastery a level adds', () => {
    const id = make().character!.id;
    awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[3]! });
    levelUp(db, { campaign_id: campaignId, character_id: id, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, character_id: id, choices: { hp: 'average', subclass: 'Champion' } });
    const fourth = levelUp(db, {
      campaign_id: campaignId,
      character_id: id,
      choices: { hp: 'average', ability_increases: { str: 1, con: 1 } },
    });
    // The Soldier's Spear comes before anything the Fighter does not carry.
    expect(fourth.features_chosen_for_you).toContain('Weapon Mastery: Spear');
  });
});

// --- 2. Equipment packs arrive unpacked ----------------------------------------

describe('starting equipment packs', () => {
  it("unpacks an Explorer's Pack into a Backpack without changing the total weight", () => {
    const barbarian = make({ class: 'Barbarian', skill_choices: ['perception', 'survival'] }).character!;
    const items = inventory(barbarian);
    expect(items.some((item) => item.name === "Explorer's Pack")).toBe(false);
    const backpack = items.find((item) => item.name === 'Backpack')!;
    const inside = backpack.container!.contents.map((item) => `${item.qty}x ${item.name}`);
    expect(inside).toEqual(['1x Bedroll', '2x Oil', '10x Rations', '1x Tinderbox']);
    expect(itemsWeight(backpack.container!.contents)).toBeLessThanOrEqual(backpack.container!.capacity_lb!);
    // What did not fit in its 30 lb lies loose beside it.
    for (const loose of ['Rope', 'Torch', 'Waterskin']) expect(items.some((item) => item.name === loose)).toBe(true);

    const kit = [
      ...equipmentBundles(findClass('Barbarian').starting_equipment_options?.[0])[0]!.items,
      ...equipmentBundles(findBackground('Soldier').equipment_options?.[0])[0]!.items,
    ];
    const before = kit.reduce((sum, item) => sum + (resolveItemWeight(item.name) ?? 0) * item.qty, 0);
    expect(itemsWeight(items)).toBeCloseTo(before, 5);
  });

  it('holds every SRD pack to its printed weight', () => {
    const packs = srd.equipment().filter((item) => item.contents?.length);
    expect(packs).toHaveLength(7);
    for (const pack of packs) {
      const contents = packContents(pack.name)!;
      const weight = contents.reduce((sum, item) => sum + resolveItemWeight(item.name)! * item.qty, 0);
      expect(weight, pack.name).toBeCloseTo(resolveItemWeight(pack.name)!, 5);
    }
  });

  it("unpacks a pack a custom background names and keeps the items the SRD does not know", () => {
    hedgeBackground([
      { name: "diplomat's pack", qty: 1 },
      { name: "Grandmother's Locket", qty: 1 },
    ]);
    const pc = make({ background: 'Hedge Witch', ability_bonuses: { str: 2, con: 1 }, equipment_choice: 'c' }).character!;
    const items = inventory(pc);
    expect(items.some((item) => /'s pack/i.test(item.name))).toBe(false);
    // The Chest states no capacity, so the whole Diplomat's Pack goes in it.
    const chest = items.find((item) => item.name === 'Chest')!;
    expect(chest.container!.contents.map((item) => item.name)).toContain('Clothes, Fine');
    expect(itemsWeight([chest])).toBeCloseTo(resolveItemWeight("Diplomat's Pack")!, 5);
    expect(items.find((item) => item.name === "Grandmother's Locket")).toMatchObject({ qty: 1, weight_lb: 0 });
  });
});

// --- 3. Magical Secrets on the spell swap ------------------------------------------

describe('Magical Secrets on replacement spells', () => {
  const sheet = (id: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

  function bard(): number {
    const data = findClass('Bard');
    return createCharacter(db, {
      campaign_id: campaignId,
      name: 'Lyra',
      species: 'Dwarf',
      class: 'Bard',
      background: 'Sage',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 },
      ability_bonuses: { int: 1, con: 2 },
      skill_choices: ['performance', 'persuasion', 'deception'],
      cantrips: srd.spells().filter((s) => s.fields.level === 0 && s.fields.classes.includes(`srd-2024_${data.index}`)).slice(0, 2).map((s) => s.fields.name),
      spells: ['Charm Person', 'Healing Word', 'Thunderwave', 'Dissonant Whispers'],
    }).character!.id;
  }

  /** Answers each level's questions with the first legal picks, as a player clicking through would. */
  function choicesFor(id: number): LevelUpChoices {
    const options = levelUpOptions(db, campaignId, id) as {
      subclass_choice?: unknown;
      ability_score_improvement?: unknown;
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
      spellcasting?: { cantrips_to_add: number; spells_to_add: number; cantrip_options: string[]; spell_options: Record<string, string[]> };
    };
    const pc = sheet(id);
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = 'College of Lore';
    if (options.ability_score_improvement) {
      const abilities = pc.abilities as Record<Ability, { score: number }>;
      const low = (Object.keys(abilities) as Ability[]).sort((a, b) => abilities[a].score - abilities[b].score);
      choices.ability_increases = { [low[0]!]: 1, [low[1]!]: 1 };
    }
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]));
    }
    if (options.spellcasting) {
      const known = (pc.spells as { known: string[] }).known;
      choices.cantrips = options.spellcasting.cantrip_options.slice(0, options.spellcasting.cantrips_to_add);
      choices.spells = Object.values(options.spellcasting.spell_options)
        .flat()
        .filter((name) => !known.includes(name))
        .slice(0, options.spellcasting.spells_to_add);
    }
    return choices;
  }

  function climb(id: number, level: number): void {
    awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[level - 1]! - sheet(id).xp });
    while (sheet(id).level < level) levelUp(db, { campaign_id: campaignId, character_id: id, choices: choicesFor(id) });
  }

  // Guiding Bolt and Sanctuary are on the Cleric list and not the Bard's.
  const CLERIC_ONLY = 'Guiding Bolt';

  it('lets a Bard with Magical Secrets swap in a Cleric spell', () => {
    for (const name of [CLERIC_ONLY, 'Sanctuary']) {
      const lists = srd.spells().find((s) => s.fields.name === name)!.fields.classes;
      expect(lists).toContain('srd-2024_cleric');
      expect(lists).not.toContain('srd-2024_bard');
    }

    const id = bard();
    climb(id, 10);
    const options = levelUpOptions(db, campaignId, id) as { spellcasting: { replace_spell: { options: Record<string, string[]> } } };
    expect(options.spellcasting.replace_spell.options['1']).toContain(CLERIC_ONLY);

    const old = (sheet(id).spells as { prepared: string[] }).prepared[0]!;
    awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[10]! - sheet(id).xp });
    levelUp(db, { campaign_id: campaignId, character_id: id, choices: { ...choicesFor(id), replace_spell: { old, new: CLERIC_ONLY } } });
    const spells = sheet(id).spells as { prepared: string[] };
    expect(spells.prepared).toContain(CLERIC_ONLY);
    expect(spells.prepared).not.toContain(old);

    const ruled = grantSpellRuling(db, { campaign_id: campaignId, character_id: id, spell: 'Sanctuary', reason: 'A lost pick' });
    expect(ruled.added).toBe(true);
  });

  it('keeps a Bard without Magical Secrets to the Bard list', () => {
    const id = bard();
    awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[1]! });
    expect(() =>
      levelUp(db, {
        campaign_id: campaignId,
        character_id: id,
        choices: { ...choicesFor(id), replace_spell: { old: 'Thunderwave', new: CLERIC_ONLY } },
      }),
    ).toThrow(`"${CLERIC_ONLY}" is not a Bard spell of level 1-1.`);
    expect(() => grantSpellRuling(db, { campaign_id: campaignId, character_id: id, spell: 'Sanctuary', reason: 'A gift' })).toThrow(
      /not a Bard spell/,
    );
  });
});

// --- 4. The Human's Versatile origin feat --------------------------------------

describe("a Human's Versatile origin feat", () => {
  it('gives Skilled by default, on class skills the character lacks', () => {
    const made = human();
    const pc = made.character!;
    expect(features(pc).filter((f) => f.name === 'Skilled')).toHaveLength(1);
    // STR 17, DEX 10, CON 15, INT 8, WIS 12, CHA 13: the open Fighter skills ranked by the score behind them,
    // where the alphabetical default took Acrobatics, Animal Handling and Arcana.
    expect(made.versatile_feat_chosen_for_you).toBe('Skilled: persuasion, animal_handling, insight');
    expect(proficientSkills(pc)).toEqual(
      ['animal_handling', 'athletics', 'insight', 'intimidation', 'perception', 'persuasion', 'stealth', 'survival'].sort(),
    );
  });

  it('takes the origin feat named, with its picks', () => {
    const made = human({ versatile_feat: 'Skilled', versatile_feat_choices: { skills: ['arcana', 'history'], tools: ["Thieves' Tools"] } });
    const pc = made.character!;
    expect(skills(pc).arcana!.proficient).toBe(true);
    expect(skills(pc).history!.proficient).toBe(true);
    expect((pc.proficiencies as { tools: string[] }).tools).toContain("Thieves' Tools");
    expect(made.versatile_feat_chosen_for_you).toBeUndefined();

    const alert = human({ name: 'Bea', versatile_feat: 'Alert' }).character!;
    expect(features(alert).find((f) => f.name === 'Alert')?.mechanics).toMatchObject({ initiative_proficiency: true });
    expect(features(alert).some((f) => f.name === 'Skilled')).toBe(false);
  });

  it('draws a second Magic Initiate from another list than the background did', () => {
    const made = human({
      class: 'Wizard',
      background: 'Sage',
      abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'investigation', 'insight'],
      cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
      spells: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic'],
      versatile_feat: 'Magic Initiate',
    });
    const resources = features(made.character!)
      .map((f) => f.mechanics?.resource)
      .filter((r) => typeof r === 'string' && r.startsWith('magic_initiate_'));
    expect(resources.sort()).toEqual(['magic_initiate_cleric', 'magic_initiate_wizard']);
  });

  it('refuses a feat that is not an Origin feat, or one the background already gave, at no cost', () => {
    const before = counts();
    expect(() => human({ versatile_feat: 'Grappler' })).toThrow(/Versatile grants an Origin feat/);
    expect(() =>
      human({ background: 'Criminal', ability_bonuses: { dex: 2, con: 1 }, versatile_feat: 'Alert' }),
    ).toThrow(/Alert already comes from the Criminal background/);
    // The Sage's own Magic Initiate is logged only once the character is saved, so this costs nothing either.
    expect(() =>
      human({
        class: 'Wizard',
        background: 'Sage',
        abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
        ability_bonuses: { int: 2, con: 1 },
        skill_choices: ['arcana', 'investigation', 'insight'],
        cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
        spells: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic'],
        versatile_feat: 'Magic Initiate',
        versatile_feat_choices: { spell_list: 'wizard' },
      }),
    ).toThrow(/already took Magic Initiate on the wizard list/);
    expect(counts()).toEqual(before);
  });

  it('refuses versatile_feat for a Dwarf at no cost', () => {
    const before = counts();
    expect(() => make({ versatile_feat: 'Alert' })).toThrow(/a Dwarf does not have/);
    expect(() => make({ versatile_feat_choices: { skills: ['arcana'] } })).toThrow(/a Dwarf does not have/);
    expect(counts()).toEqual(before);
    expect(features(make().character!).some((f) => f.name === 'Skilled')).toBe(false);
  });

  it("takes an origin feat a custom background invented, its clauses running from that background's row", () => {
    const entry = hedgeBackground([]);
    const pc = human({ versatile_feat: 'hedge lore' }).character!;
    const feat = features(pc).find((f) => f.name === 'Hedge Lore')!;
    expect(feat.source).toBe('feat');
    expect(feat.mechanics?.homebrew_id).toBe(entry.id);
    expect(combatSheet(db, pc.id).features.find((f) => f.name === 'Hedge Lore')?.clauses).toEqual([
      { when: 'always', do: [{ kind: 'proficiency', skill: 'nature' }], uses: 'unlimited', decide: 'auto' },
    ]);
    expect(() => human({ name: 'Cy', versatile_feat: 'Hedge Lore', versatile_feat_choices: { skills: ['arcana'] } })).toThrow(
      /homebrew and its own clauses/,
    );
    expect(() => human({ name: 'Di', versatile_feat: 'Moon Lore' })).toThrow(/Options: Alert, Magic Initiate, Savage Attacker, Skilled, Hedge Lore/);
  });

  it('lists the choice, with the custom origin feats, in the creation options', () => {
    hedgeBackground([]);
    const options = listCharacterOptions({ species: 'Human', campaign_id: campaignId }, db) as {
      species_detail: { versatile_feat?: { default: string; options: Array<{ name: string; custom?: boolean }> } };
    };
    expect(options.species_detail.versatile_feat?.default).toBe('Skilled');
    expect(options.species_detail.versatile_feat?.options.map((o) => o.name)).toEqual([
      'Alert',
      'Magic Initiate',
      'Savage Attacker',
      'Skilled',
      'Hedge Lore',
    ]);
    const dwarf = listCharacterOptions({ species: 'Dwarf' }) as { species_detail: Record<string, unknown> };
    expect(dwarf.species_detail.versatile_feat).toBeUndefined();
  });

  it("travels through the wizard's create route", async () => {
    const portraits = mkdtempSync(join(tmpdir(), 'dnd-portraits-a2a2-'));
    process.env.DND_AI_PORTRAITS_DIR = portraits;
    const started = await startHttpServer(db, { port: 0, secret: 'testsecret0123456789abcdef012345' });
    try {
      const post = (body: Record<string, unknown>) =>
        fetch(`http://${HOST}:${started.port}/api/campaigns/${campaignId}/character`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Wren',
            species: 'Human',
            class: 'Fighter',
            background: 'Soldier',
            ability_method: 'standard_array',
            abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
            ability_bonuses: { str: 2, con: 1 },
            skill_choices: ['perception', 'survival', 'stealth'],
            ...body,
          }),
        });
      const ok = await post({ versatile_feat: 'Skilled', versatile_feat_choices: { skills: ['arcana', 'history', 'religion'] } });
      expect(ok.status).toBe(201);
      const pc = ((await ok.json()) as { character: CharacterSummary }).character;
      expect(skills(pc).religion!.proficient).toBe(true);
      const refused = await post({ species: 'Dwarf', skill_choices: ['perception', 'survival'], versatile_feat: 'Alert' });
      expect(refused.status).toBe(400);
    } finally {
      await started.close();
      delete process.env.DND_AI_PORTRAITS_DIR;
      rmSync(portraits, { recursive: true, force: true });
    }
  });
});

// --- 5. Two species data fixes -------------------------------------------------------

describe('Dragonborn resistances and Drow darkvision', () => {
  const speciesTraits = (pc: CharacterSummary): string[] => features(pc).filter((f) => f.source === 'species').map((f) => f.name);

  it('gives a Black Dragonborn acid resistance and nothing else', () => {
    const pc = make({ species: 'Dragonborn', lineage: 'Draconic Ancestor: Black' }).character!;
    expect(pc.resistances).toEqual(['acid']);
    expect(speciesTraits(pc)).not.toContain('Damage Resistance: Lightning');
    expect(speciesTraits(pc)).not.toContain('Damage Resistance: Poison');
  });

  it('files lightning under Blue and Bronze, poison under Green', () => {
    expect(make({ name: 'B', species: 'Dragonborn', lineage: 'Draconic Ancestor: Blue' }).character!.resistances).toEqual(['lightning']);
    expect(make({ name: 'Z', species: 'Dragonborn', lineage: 'Draconic Ancestor: Bronze' }).character!.resistances).toEqual([
      'lightning',
    ]);
    expect(make({ name: 'G', species: 'Dragonborn', lineage: 'Draconic Ancestor: Green' }).character!.resistances).toEqual(['poison']);
  });

  it('gives a Drow 120 ft darkvision in place of the 60 ft every Elf has', () => {
    const elf = (lineage: string) =>
      make({ name: lineage, species: 'Elf', lineage, skill_choices: ['perception', 'survival', 'insight'] }).character!;
    const drow = speciesTraits(elf('Elven Lineage: Drow'));
    expect(drow).toContain('Darkvision (120 ft.)');
    expect(drow).not.toContain('Darkvision (60 ft.)');
    const high = speciesTraits(elf('Elven Lineage: High Elf'));
    expect(high).toContain('Darkvision (60 ft.)');
    expect(high).not.toContain('Darkvision (120 ft.)');
    // A Dwarf has no lineage, and the Drow tag on the shared entry does not take it away.
    expect(speciesTraits(make({ name: 'Dw' }).character!)).toContain('Darkvision (120 ft.)');

    const options = listCharacterOptions({ species: 'Elf' }) as {
      species_detail: { lineages: Array<{ name: string; traits: Array<{ name: string }> }> };
    };
    const drowTraits = options.species_detail.lineages.find((l) => l.name === 'Elven Lineage: Drow')!.traits;
    expect(drowTraits.map((t) => t.name)).toContain('Darkvision (120 ft.)');
  });
});

// --- 6. A custom background's SRD origin feat ----------------------------------------

describe('a custom background whose origin feat is an SRD one by name', () => {
  /** A DM-written background that names Skilled instead of inventing a feat. */
  function trailBackground(): void {
    saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'background',
      name: 'Trail Guide',
      schema: validateBackground({
        name: 'Trail Guide',
        abilities: ['str', 'dex', 'con'],
        origin_feat: 'Skilled',
        skills: ['nature', 'medicine'],
        tool: "Cartographer's Tools",
        equipment: { items: [], gold: 10 },
        text: 'You led caravans over the passes.',
      }) as unknown as Record<string, unknown>,
    });
  }

  it('grants the skill proficiencies Skilled gives, chosen or filled in', () => {
    trailBackground();
    const chosen = make({ background: 'Trail Guide', feat_choices: { skills: ['arcana', 'history', 'religion'] } }).character!;
    for (const skill of ['arcana', 'history', 'religion']) expect(skills(chosen)[skill]!.proficient, skill).toBe(true);
    expect(features(chosen).find((f) => f.name === 'Skilled')?.source).toBe('feat');

    const filled = make({ name: 'Rudd', background: 'Trail Guide' });
    expect(filled.feat_chosen_for_you).toMatch(/^Skilled: /);
    const picks = filled.feat_chosen_for_you!.replace('Skilled: ', '').split(', ');
    expect(picks).toHaveLength(3);
    for (const skill of picks) expect(skills(filled.character!)[skill]!.proficient, skill).toBe(true);

    const options = listCharacterOptions({ background: 'Trail Guide', campaign_id: campaignId }, db) as {
      background_detail: { origin_feat_choices?: unknown };
    };
    expect(options.background_detail.origin_feat_choices).toEqual({ skills_or_tools: 'Any 3 skills or tools, as skills and tools.' });
  });
});

// --- 7. Class skill lists as SRD 5.2.1 prints them --------------------------------

describe('class skill lists', () => {
  const list = (cls: string): string[] => skillChoiceGroups(findClass(cls))[0]!.from;

  it("puts Persuasion on the Fighter's list and Nature on the Wizard's, and takes Performance off the Rogue's", () => {
    expect(list('Fighter')).toContain('persuasion');
    expect(list('Wizard')).toContain('nature');
    expect(list('Rogue')).not.toContain('performance');
    expect(list('Rogue')).toHaveLength(10);
    // The other nine classes already match the SRD; the Cleric stands in for them.
    expect(list('Cleric')).toEqual(['history', 'insight', 'medicine', 'persuasion', 'religion']);
  });

  it('lets a Fighter take Persuasion and refuses a Rogue Performance', () => {
    expect(skills(make({ skill_choices: ['persuasion', 'perception'] }).character!).persuasion!.proficient).toBe(true);
    expect(() =>
      make({
        name: 'Nib',
        class: 'Rogue',
        background: 'Criminal',
        ability_bonuses: { dex: 2, con: 1 },
        skill_choices: ['performance', 'acrobatics', 'deception', 'insight'],
      }),
    ).toThrow(/Choose 4 from \[acrobatics, athletics, deception, insight, intimidation, investigation, perception, persuasion/);
  });
});

afterEach(() => {
  db.close();
});
