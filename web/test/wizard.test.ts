import { describe, expect, it } from 'vitest';
import {
  ABILITIES,
  CLASS_INFO,
  POINT_BUY_BUDGET,
  STEPS,
  abilitiesProblem,
  assignStandard,
  bonusOptions,
  bonusProblem,
  campaignBody,
  characterBody,
  characterProblems,
  chosenForYou,
  dmTodo,
  dmTodoLine,
  draftLine,
  emptyCharacter,
  emptyDraft,
  fieldForError,
  fillFlags,
  isCompleteCharacter,
  pickSlots,
  pointBuyCost,
  speciesLineages,
  standardScores,
  type CharacterOptions,
  type Scores,
} from '../src/lib/wizard';

const SRD_CLASSES = [
  'Barbarian',
  'Bard',
  'Cleric',
  'Druid',
  'Fighter',
  'Monk',
  'Paladin',
  'Ranger',
  'Rogue',
  'Sorcerer',
  'Warlock',
  'Wizard',
];

const wizardOptions = (): CharacterOptions => ({
  classes: [],
  species: [],
  backgrounds: [],
  class_detail: {
    name: 'Wizard',
    hit_die: 'd6',
    skill_choices: [{ desc: 'Choose 2', choose: 2, from: ['arcana', 'history', 'insight'] }],
    tool_choices: [{ desc: 'One instrument', choose: 1, from: ['Lute', 'Drum'] }],
    feature_choices: [
      { feature: 'Expertise', choose: 2, from: ['arcana', 'history', 'insight'], desc: 'Double the bonus.' },
    ],
    equipment_options: [
      {
        label: 'a',
        desc: '',
        items: [{ name: 'Quarterstaff', qty: 1 }],
        gold: 5,
        picks: [{ desc: 'Choose 1 from Gaming Sets', choose: 1, options: ['Dice Set', 'Chess Set'] }],
      },
      { label: 'b', desc: '', items: [], gold: 55 },
    ],
    level_1_features: [],
    spellcasting: {
      ability: 'int',
      cantrips_to_choose: 1,
      spells_to_choose: 1,
      cantrip_options: ['Light', 'Mage Hand'],
      spell_options: ['Magic Missile', 'Shield'],
    },
  },
  background_detail: {
    name: 'Sage',
    ability_scores: ['con', 'int', 'wis'],
    feat: {
      name: 'Magic Initiate',
      text: '',
      choices: { spell_list: ['cleric', 'druid', 'wizard'], cantrips: 2 },
    },
    skills: ['arcana', 'history'],
    tools: [],
    equipment_options: [
      {
        label: 'a',
        desc: '',
        items: [{ name: 'Quill', qty: 1 }],
        gold: 8,
        picks: [{ desc: 'Choose 1 from Artisan Tools', choose: 1, options: ["Calligrapher's Supplies"] }],
      },
    ],
  },
  languages: {
    rule: 'Everyone knows Common and 2 more.',
    known: ['Common'],
    options: [
      { name: 'Elvish', rarity: 'standard', speakers: 'elves', script: 'Elvish' },
      { name: 'Dwarvish', rarity: 'standard', speakers: 'dwarves', script: 'Dwarvish' },
    ],
  },
});

const ELF_LINEAGES = [
  { name: 'Elven Lineage: Drow', traits: [{ name: 'Darkvision', text: 'Your darkvision reaches 120 feet.' }] },
  { name: 'Elven Lineage: High Elf', traits: [{ name: 'Cantrip', text: 'You know Prestidigitation.' }] },
];

const elfOptions = (): CharacterOptions => ({
  ...wizardOptions(),
  species: [
    { name: 'Elf', size: 'Medium', speed: 30, lineages: ELF_LINEAGES.map((lineage) => lineage.name) },
    { name: 'Human', size: 'Medium', speed: 30, lineages: [] },
  ],
  species_detail: { name: 'Elf', size: 'Medium', speed: 30, traits: [], lineages: ELF_LINEAGES },
});

const nell = (): ReturnType<typeof emptyCharacter> => ({
  ...emptyCharacter(),
  name: 'Nell',
  class: 'Wizard',
  species: 'Elf',
  background: 'Sage',
  bonus_option: 'int2-con1',
  skills: ['arcana', 'history'],
  equipment: 'a',
  cantrips: ['Light'],
  spells: ['Shield'],
});

describe('the wizard steps', () => {
  it('runs from the name to the summary', () => {
    expect(STEPS.map((step) => step.id)).toEqual(['name', 'setting', 'tone', 'premise', 'region', 'character', 'done']);
  });

  it('sends an untouched draft as the shape alone: no answer is required any more', () => {
    expect(campaignBody(emptyDraft())).toEqual({ story_shape: 'structured' });
    expect(campaignBody({ ...emptyDraft(), name: '   ', premise: '  ' })).toEqual({ story_shape: 'structured' });
  });

  it('sends only the fields the player filled in', () => {
    const draft = { ...emptyDraft(), name: ' Ashfall ', lines: '  ', premise: 'A city under ash.' };
    expect(campaignBody(draft)).toEqual({
      name: 'Ashfall',
      story_shape: 'structured',
      premise: 'A city under ash.',
    });
    expect(campaignBody({ ...draft, setting_preset: 'grimdark', tone_dials: { grimness: 3 } })).toMatchObject({
      setting_preset: 'grimdark',
      tone_dials: { grimness: 3 },
    });
  });
});

describe('ability scores', () => {
  it('keeps every standard-array number in play when one is reassigned', () => {
    const scores = assignStandard(standardScores(), 'cha', 15);
    expect(scores.cha).toBe(15);
    expect(scores.str).toBe(8);
    expect(ABILITIES.map((ability) => scores[ability]).sort((a, b) => b - a)).toEqual([15, 14, 13, 12, 10, 8]);
    expect(abilitiesProblem('standard_array', scores)).toBeNull();
  });

  it('refuses an array that uses a number twice', () => {
    const scores = { ...standardScores(), cha: 15 } as Scores;
    expect(abilitiesProblem('standard_array', scores)).toMatch(/exactly once/);
  });

  it('costs point buy the SRD way and holds the budget', () => {
    const even = { str: 13, dex: 13, con: 13, int: 12, wis: 12, cha: 12 };
    expect(pointBuyCost(even)).toBe(27);
    expect(abilitiesProblem('point_buy', even)).toBeNull();
    const greedy = { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 };
    expect(pointBuyCost(greedy)).toBe(27);
    const over = { str: 15, dex: 15, con: 15, int: 10, wis: 8, cha: 8 };
    expect(abilitiesProblem('point_buy', over)).toMatch(new RegExp(`${POINT_BUY_BUDGET} points`));
    expect(abilitiesProblem('point_buy', { ...even, str: 16 })).toMatch(/between 8 and 15/);
  });
});

describe('background ability bonuses', () => {
  const allowed = ['con', 'int', 'wis'];

  it('lists every legal pattern once', () => {
    const options = bonusOptions(allowed);
    expect(options).toHaveLength(7);
    expect(options.at(-1)?.bonuses).toEqual({ con: 1, int: 1, wis: 1 });
    for (const option of options) expect(bonusProblem(option.bonuses, allowed)).toBeNull();
  });

  it('refuses the wrong total, the wrong shape and an ability the background never raises', () => {
    expect(bonusProblem({ int: 2 }, allowed)).toMatch(/\+2 and \+1/);
    expect(bonusProblem({ int: 2, wis: 2 }, allowed)).toMatch(/\+2 and \+1/);
    expect(bonusProblem({ str: 2, int: 1 }, allowed)).toMatch(/con, int, wis/);
  });
});

describe('the class descriptions', () => {
  it('covers all twelve classes with a line, a role and a complexity', () => {
    expect(Object.keys(CLASS_INFO).sort()).toEqual([...SRD_CLASSES].sort());
    for (const info of Object.values(CLASS_INFO)) {
      expect(info.desc.length).toBeGreaterThan(20);
      expect(info.roles.length).toBeGreaterThan(0);
      expect(['simple', 'medium', 'complex']).toContain(info.complexity);
    }
  });
});

describe('the character step', () => {
  it('says nothing about a half-filled character: that is a draft for the DM, not a mistake', () => {
    const options = wizardOptions();
    expect(characterProblems(emptyCharacter(), options)).toEqual({});
    expect(characterProblems({ ...emptyCharacter(), class: 'Wizard', background: 'Sage' }, options)).toEqual({});
  });

  it('names every choice still missing once the player means to finish the sheet here', () => {
    const options = wizardOptions();
    const started = { ...emptyCharacter(), name: 'Nell', class: 'Wizard', species: 'Elf', background: 'Sage' };
    expect(Object.keys(characterProblems(started, options)).sort()).toEqual([
      'bonuses',
      'cantrips',
      'equipment',
      'skills',
      'spells',
    ]);
    expect(characterProblems(started, options)).toMatchObject({
      skills: expect.stringContaining('Choose 2 skills'),
      bonuses: expect.stringContaining('+2 and +1'),
    });
  });

  it('is happy once every choice is made, and posts them', () => {
    const options = wizardOptions();
    const draft = {
      ...emptyCharacter(),
      name: ' Nell ',
      class: 'Wizard',
      species: 'Elf',
      background: 'Sage',
      bonus_option: 'int2-con1',
      skills: ['arcana', 'history'],
      equipment: 'a',
      cantrips: ['Light'],
      spells: ['Shield'],
    };
    expect(characterProblems(draft, options)).toEqual({});
    expect(characterBody(draft, options)).toEqual({
      name: 'Nell',
      species: 'Elf',
      class: 'Wizard',
      background: 'Sage',
      ability_method: 'standard_array',
      abilities: standardScores(),
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'history'],
      equipment_choice: 'a',
      cantrips: ['Light'],
      spells: ['Shield'],
    });
  });
});

describe('the optional lists', () => {
  const started = (): ReturnType<typeof emptyCharacter> => ({
    ...emptyCharacter(),
    name: 'Nell',
    class: 'Wizard',
    species: 'Elf',
    background: 'Sage',
    bonus_option: 'int2-con1',
    skills: ['arcana', 'history'],
    equipment: 'a',
    cantrips: ['Light'],
    spells: ['Shield'],
  });

  it('leaves out anything the player did not answer, so the server picks it', () => {
    const body = characterBody(started(), wizardOptions());
    expect(body.languages).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.feature_options).toBeUndefined();
    expect(body.feat_choices).toBeUndefined();
    expect(body.equipment_picks).toBeUndefined();
  });

  it('sends them once they are complete', () => {
    const options = wizardOptions();
    expect(pickSlots(started(), options).map((pick) => pick.options[0])).toEqual([
      'Dice Set',
      "Calligrapher's Supplies",
    ]);
    const draft = {
      ...started(),
      languages: ['Elvish', 'Dwarvish'],
      tools: ['Lute'],
      feature_options: { Expertise: ['arcana', 'history'], 'Fighting Style': [] },
      feat_choices: { spell_list: 'wizard', spellcasting_ability: '' },
      background_equipment: 'a',
      equipment_picks: ['Dice Set', "Calligrapher's Supplies"],
    };
    expect(characterBody(draft, options)).toMatchObject({
      languages: ['Elvish', 'Dwarvish'],
      tools: ['Lute'],
      feature_options: { Expertise: ['arcana', 'history'] },
      feat_choices: { spell_list: 'wizard' },
      background_equipment_choice: 'a',
      equipment_picks: ['Dice Set', "Calligrapher's Supplies"],
    });
  });

  it('holds back a half-answered language pick rather than have the server refuse it', () => {
    const body = characterBody({ ...started(), languages: ['Elvish'] }, wizardOptions());
    expect(body.languages).toBeUndefined();
  });
});

describe('the lineage inside a species', () => {
  it('reads the lineages off whichever half of the options carries them', () => {
    const options = elfOptions();
    expect(speciesLineages(options, 'Elf')).toEqual(ELF_LINEAGES);
    expect(speciesLineages({ ...options, species_detail: undefined }, 'Elf')).toEqual([
      { name: 'Elven Lineage: Drow', traits: [] },
      { name: 'Elven Lineage: High Elf', traits: [] },
    ]);
    expect(speciesLineages(options, 'Human')).toEqual([]);
    expect(speciesLineages(options, '')).toEqual([]);
  });

  it('is not a finished character until a species with lineages has one', () => {
    const options = elfOptions();
    expect(isCompleteCharacter(nell(), options)).toBe(false);
    expect(isCompleteCharacter({ ...nell(), lineage: 'Elven Lineage: High Elf' }, options)).toBe(true);
    expect(isCompleteCharacter({ ...nell(), species: 'Human' }, options)).toBe(true);
    // A server that never sent any lineages asks for none.
    expect(isCompleteCharacter(nell(), wizardOptions())).toBe(true);
  });

  it('sends the lineage when it was chosen and keeps a blank one as a draft', () => {
    const options = elfOptions();
    const chosen = characterBody({ ...nell(), lineage: 'Elven Lineage: High Elf' }, options);
    expect(chosen.lineage).toBe('Elven Lineage: High Elf');
    expect(chosen.abilities).toBeDefined();

    const blank = characterBody(nell(), options);
    expect(blank.lineage).toBeUndefined();
    // Left blank it goes as the draft the DM finishes, so the rule-checked half stays home.
    expect(blank.abilities).toBeUndefined();
    expect(characterBody({ ...nell(), species: 'Human' }, options).lineage).toBeUndefined();
  });
});

describe("a Wizard's spellbook", () => {
  const bookOptions = (): CharacterOptions => {
    const options = wizardOptions();
    options.class_detail!.spellcasting = {
      ability: 'int',
      cantrips_to_choose: 1,
      spells_to_choose: 4,
      cantrip_options: ['Light'],
      spell_options: ['Magic Missile', 'Shield', 'Sleep', 'Thunderwave', 'Grease', 'Detect Magic'],
    };
    return options;
  };
  const prepared = ['Magic Missile', 'Shield', 'Sleep', 'Thunderwave'];
  const studious = (): ReturnType<typeof emptyCharacter> => ({ ...nell(), spells: prepared });

  it('sends six pages with the prepared spells among them', () => {
    const draft = { ...studious(), spellbook: ['Grease', 'Detect Magic'] };
    expect(characterBody(draft, bookOptions()).spellbook).toEqual([...prepared, 'Grease', 'Detect Magic']);
  });

  it('leaves the book to the server until all six are named', () => {
    expect(characterBody({ ...studious(), spellbook: ['Grease'] }, bookOptions()).spellbook).toBeUndefined();
    expect(characterBody(studious(), bookOptions()).spellbook).toBeUndefined();
  });

  it('is a Wizard thing: no other class carries a book', () => {
    const draft = { ...studious(), class: 'Bard', spellbook: ['Grease', 'Detect Magic'] };
    expect(characterBody(draft, bookOptions()).spellbook).toBeUndefined();
  });
});

describe('what the DM still owes', () => {
  it('reads the old boolean flag and the new one side by side', () => {
    expect(fillFlags(true)).toEqual({ name: false, premise: true });
    expect(fillFlags(false)).toEqual({ name: false, premise: false });
    expect(fillFlags(undefined)).toEqual({ name: false, premise: false });
    expect(fillFlags({ name: true, premise: true })).toEqual({ name: true, premise: true });
    expect(fillFlags({ premise: true })).toEqual({ name: false, premise: true });
  });

  it('lists the story and the character the player left open', () => {
    expect(dmTodo({ needs_ai_fill: { name: true, premise: true } })).toEqual([
      'name the story',
      'write the premise',
    ]);
    expect(dmTodoLine({ needs_ai_fill: { name: true, premise: true } })).toBe(
      'DM will: name the story, write the premise',
    );
    expect(dmTodo({ needs_ai_fill: false, character_draft: { name: 'Nell' } })).toEqual([
      "finish Nell's sheet",
    ]);
    expect(dmTodo({ character_draft: {} })).toEqual(['build your character']);
    expect(dmTodo({ character_draft: { name: 'Nell', species: 'Elf' } })).toEqual([
      "finish Nell's sheet",
      'pick your Elf lineage',
    ]);
    expect(dmTodo({ character_draft: { name: 'Nell', species: 'Elf', lineage: 'Elven Lineage: Drow' } })).toEqual([
      "finish Nell's sheet",
    ]);
    expect(dmTodo({ character_draft: { name: 'Nell', species: 'Human' } })).toEqual(["finish Nell's sheet"]);
    // A finished sheet cancels the character line, whatever draft came before it.
    expect(dmTodo({ character_draft: { name: 'Nell' }, pc: { name: 'Nell' } })).toEqual([]);
    expect(dmTodoLine({ needs_ai_fill: false })).toBeNull();
  });

  it('says the half-made character back in plain words', () => {
    expect(draftLine({ gender: 'dwarf', class: 'fighter', idea: 'gruff' })).toBe('dwarf fighter, "gruff"');
    expect(draftLine({ name: 'Nell', species: 'Elf', class: 'Wizard', background: 'Sage' })).toBe(
      'Nell, Elf Wizard, Sage background',
    );
    expect(draftLine({})).toBe('nothing chosen yet');
  });

  it('repeats what the server chose where the player left a list empty', () => {
    expect(
      chosenForYou({
        character: null,
        languages_chosen_for_you: ['Elvish', 'Dwarvish'],
        features_chosen_for_you: ['Expertise: arcana, history'],
        feat_chosen_for_you: 'Magic Initiate: wizard',
      }),
    ).toEqual([
      'languages: Elvish, Dwarvish',
      'features: Expertise: arcana, history',
      'feat: Magic Initiate: wizard',
    ]);
    expect(chosenForYou({ character: { name: 'Nell' } })).toEqual([]);
  });
});

describe('server errors', () => {
  it('lands next to the field that caused them', () => {
    expect(fieldForError('Unknown class "Warlok". Valid options: Barbarian, Bard.')).toBe('class');
    expect(fieldForError('Unknown species "Elv". Valid options: Elf.')).toBe('species');
    expect(fieldForError('The standard array must use each of 15, 14, 13, 12, 10, 8 exactly once.')).toBe('abilities');
    expect(fieldForError('Point buy allows 27 points; this assignment costs 30.')).toBe('abilities');
    expect(fieldForError('The Sage background must raise its abilities (con, int, wis) by +2 and +1.')).toBe('bonuses');
    expect(fieldForError('This character chooses 2 skill proficiencies: 2 of [arcana]. Got 1.')).toBe('skills');
    expect(fieldForError('Unknown equipment choice "c" for Wizard. Options: a) …')).toBe('equipment');
    expect(fieldForError('A level-appropriate Wizard picks 3 cantrips; got 2.')).toBe('cantrips');
    expect(fieldForError('lineage required for Elf: Elven Lineage: Drow, Elven Lineage: High Elf.')).toBe(
      'lineage',
    );
    expect(fieldForError('unknown lineage "Wood Elf" for Elf: Elven Lineage: Drow.')).toBe('lineage');
    expect(fieldForError('"Fireball" is not a Wizard level 1 spell.')).toBe('spells');
    expect(fieldForError('No campaign with id 9.')).toBeNull();
  });
});
