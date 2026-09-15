import { describe, expect, it } from 'vitest';
import {
  buildFeatChoices,
  buildLevelUpBody,
  emptyPicks,
  featChoiceFields,
  featOptionLabel,
  featureChoiceProblem,
  featureOptionLabel,
  spellOptionNames,
  spellbookProblem,
  swapProblem,
  type FeatureChoiceSpec,
  type LevelUpPicks,
  type LevelUpSrd,
  type SpellbookSpec,
} from '../src/lib/progression';

const srd = (extra: Partial<LevelUpSrd> = {}): LevelUpSrd => ({
  supported: true,
  from_level: 3,
  to_level: 4,
  hp: { average: 7, roll: '1d10 + 2 (CON) + 1', choose: ['average', 'roll'] },
  ...extra,
});

const picksWith = (extra: Partial<LevelUpPicks> = {}): LevelUpPicks => ({ ...emptyPicks(), ...extra });

const expertise: FeatureChoiceSpec = {
  feature: 'Expertise',
  choose: 2,
  from: ['stealth', 'perception', 'sleight_of_hand'],
  desc: 'Two skills you are proficient in double their bonus.',
};

const casting = (extra: Partial<NonNullable<LevelUpSrd['spellcasting']>> = {}) => ({
  cantrips_to_add: 0,
  spells_to_add: 0,
  cantrip_options: [],
  spell_options: {},
  max_spell_level: 2,
  spell_slots: { '1': { max: 4, used: 0 } },
  ...extra,
});

const book: SpellbookSpec = {
  rule: 'A Wizard copies 2 new spells into their spellbook each level.',
  to_add: 2,
  held: ['Magic Missile'],
  options: { '1': ['Shield', 'Sleep'], '2': ['Misty Step'] },
};

describe('the hit points the server worked out', () => {
  it('sends only which of the two the player took, the numbers being the server own', () => {
    const options = srd();
    expect(options.hp?.roll).toBe('1d10 + 2 (CON) + 1');
    expect(buildLevelUpBody(options, picksWith({ hp: 'roll' }))).toEqual({ body: { choices: { hp: 'roll' } } });
  });
});

describe('a feature that is itself a choice', () => {
  it('takes exactly as many picks as the feature gives', () => {
    expect(featureChoiceProblem(expertise, ['stealth', 'perception'])).toBeNull();
  });

  it('names the count that is still missing', () => {
    expect(featureChoiceProblem(expertise, ['stealth'])).toBe('Pick 2 for Expertise (you have picked 1).');
    expect(featureChoiceProblem(expertise, [])).toBe('Pick 2 for Expertise (you have picked 0).');
  });

  it('refuses the same pick twice', () => {
    expect(featureChoiceProblem(expertise, ['stealth', 'stealth'])).toBe('Each Expertise pick must be different.');
  });

  it('refuses what the server no longer offers, such as a skill already doubled', () => {
    expect(featureChoiceProblem(expertise, ['stealth', 'arcana'])).toBe('"arcana" is no longer an option for Expertise.');
  });

  it('sends the picks keyed by the feature name', () => {
    const options = srd({ feature_choices: [expertise], feature_choices_rule: 'Pass choices.feature_options.' });
    expect(buildLevelUpBody(options, picksWith())).toEqual({ error: 'Pick 2 for Expertise (you have picked 0).' });
    expect(
      buildLevelUpBody(options, picksWith({ feature_options: { Expertise: ['stealth', 'perception'] } })),
    ).toEqual({
      body: { choices: { hp: 'average', feature_options: { Expertise: ['stealth', 'perception'] } } },
    });
  });

  it('reads a skill key the way the player reads it', () => {
    expect(featureOptionLabel('sleight_of_hand')).toBe('sleight of hand');
    expect(featureOptionLabel('Archery')).toBe('Archery');
  });
});

describe('what a feat still asks for', () => {
  it('turns the server choices into one picker each', () => {
    expect(featChoiceFields({ ability: ['str', 'dex'] })).toEqual([
      { key: 'ability', label: 'the ability score it raises', help: 'ability_score', kind: 'one', choose: 1, options: ['str', 'dex'], desc: '' },
    ]);
    expect(featChoiceFields({ skills_or_tools: 'Any 3 skills or tools, as skills and tools.' })[0]).toMatchObject({
      key: 'skills',
      kind: 'many',
      choose: 3,
      options: [],
    });
    expect(featChoiceFields({ cantrips: 2 })[0]).toMatchObject({ key: 'cantrips', kind: 'many', choose: 2 });
    expect(featChoiceFields({ ability_increases: '+2 to one ability or +1 to two.' })[0]).toMatchObject({
      kind: 'increases',
      choose: 2,
    });
    // The note beside an Epic Boon is prose, not a picker.
    expect(featChoiceFields({ note: 'An Epic Boon may raise a score to 30.' })).toEqual([]);
    expect(featChoiceFields(null)).toEqual([]);
  });

  it('reads an ability key as a player reads it', () => {
    expect(featOptionLabel('str')).toBe('STR');
    expect(featOptionLabel('wizard')).toBe('Wizard');
  });

  it('holds the feat until every one of its own picks is made', () => {
    const fields = featChoiceFields({ ability: ['str', 'dex'] });
    expect(buildFeatChoices('Grappler', fields, {}, {})).toEqual({
      error: 'Grappler needs the ability score it raises.',
    });
    expect(buildFeatChoices('Grappler', fields, { ability: ['con'] }, {})).toEqual({
      error: '"con" is not one of STR, DEX.',
    });
    expect(buildFeatChoices('Grappler', fields, { ability: ['str'] }, {})).toEqual({ choices: { ability: 'str' } });
  });

  it('counts the names a feat asks to be typed, and refuses the same one twice', () => {
    const fields = featChoiceFields({ skills_or_tools: 'Any 3 skills or tools, as skills and tools.' });
    expect(buildFeatChoices('Skilled', fields, { skills: ['stealth', 'arcana'] }, {})).toEqual({
      error: 'Skilled needs 3 skills or tools; you have named 2.',
    });
    expect(buildFeatChoices('Skilled', fields, { skills: ['stealth', 'stealth', 'arcana'] }, {})).toEqual({
      error: 'Each of the skills or tools Skilled takes must be different.',
    });
    expect(buildFeatChoices('Skilled', fields, { skills: ['stealth', ' arcana', 'medicine'] }, {})).toEqual({
      choices: { skills: ['stealth', 'arcana', 'medicine'] },
    });
  });

  it('spends the two points of an Ability Score Improvement feat exactly', () => {
    const fields = featChoiceFields({ ability_increases: '+2 to one ability or +1 to two.' });
    expect(buildFeatChoices('Ability Score Improvement', fields, {}, { str: 1 })).toEqual({
      error: 'Ability Score Improvement raises one ability score by 2, or two scores by 1.',
    });
    expect(buildFeatChoices('Ability Score Improvement', fields, {}, { str: 1, con: 1, dex: 0 })).toEqual({
      choices: { ability_increases: { str: 1, con: 1 } },
    });
  });

  it('sends a feat picks beside the feat itself', () => {
    const options = srd({
      ability_score_improvement: {
        rule: 'Raise one by 2 or two by 1, or take a feat.',
        feat_options: [
          { name: 'Alert', text: '+5 initiative.', choices: null },
          { name: 'Grappler', text: 'You grapple better.', choices: { ability: ['str', 'dex'] } },
        ],
      },
    });
    expect(buildLevelUpBody(options, picksWith({ asi_mode: 'feat', feat: 'Alert' }))).toEqual({
      body: { choices: { hp: 'average', feat: 'Alert' } },
    });
    expect(buildLevelUpBody(options, picksWith({ asi_mode: 'feat', feat: 'Grappler' }))).toEqual({
      error: 'Grappler needs the ability score it raises.',
    });
    expect(
      buildLevelUpBody(options, picksWith({ asi_mode: 'feat', feat: 'Grappler', feat_choices: { ability: ['dex'] } })),
    ).toEqual({ body: { choices: { hp: 'average', feat: 'Grappler', feat_choices: { ability: 'dex' } } } });
  });

  it('asks for an Epic Boon the same way, and its own ability with it', () => {
    const options = srd({
      epic_boon: {
        epic: true,
        rule: 'Level 19 gives an Epic Boon.',
        feat_options: [{ name: 'Boon of Irresistible Offense', text: 'Your blows tell.', choices: { ability: ['str', 'dex'], note: 'up to 30' } }],
      },
    });
    expect(buildLevelUpBody(options, picksWith())).toEqual({ error: 'Pick an Epic Boon.' });
    expect(buildLevelUpBody(options, picksWith({ feat: 'Boon of Irresistible Offense' }))).toEqual({
      error: 'Boon of Irresistible Offense needs the ability score it raises.',
    });
    expect(
      buildLevelUpBody(
        options,
        picksWith({ feat: 'Boon of Irresistible Offense', feat_choices: { ability: ['str'] } }),
      ),
    ).toEqual({
      body: { choices: { hp: 'average', feat: 'Boon of Irresistible Offense', feat_choices: { ability: 'str' } } },
    });
  });
});

describe('the swap every caster gets on levelling', () => {
  const swap = { rule: 'Optional.', held: ['Light', 'Fire Bolt'], options: ['Ray of Frost', 'Mage Hand'] };

  it('is genuinely optional: nothing picked is nothing sent', () => {
    expect(swapProblem('cantrip', swap, { old: '', new: '' })).toBeNull();
    const options = srd({ spellcasting: casting({ replace_cantrip: swap }) });
    expect(buildLevelUpBody(options, picksWith())).toEqual({ body: { choices: { hp: 'average' } } });
  });

  it('needs both halves once one is picked', () => {
    expect(swapProblem('cantrip', swap, { old: 'Light', new: '' })).toBe(
      'Swapping a cantrip needs both the one you give up and the one you learn, or neither.',
    );
  });

  it('refuses a cantrip that is not one of yours, or one not on offer', () => {
    expect(swapProblem('cantrip', swap, { old: 'Shocking Grasp', new: 'Mage Hand' })).toBe(
      'You do not know the cantrip "Shocking Grasp".',
    );
    // Already known: the server leaves what is held out of the options it sends.
    expect(swapProblem('cantrip', swap, { old: 'Light', new: 'Fire Bolt' })).toBe(
      '"Fire Bolt" is not a cantrip you can learn this level.',
    );
  });

  it('sends a finished swap as old and new', () => {
    const spellSwap = { rule: 'Optional.', held: ['Cure Wounds'], options: { '1': ['Healing Word'], '2': ['Aid'] } };
    const options = srd({ spellcasting: casting({ replace_cantrip: swap, replace_spell: spellSwap }) });
    expect(
      buildLevelUpBody(
        options,
        picksWith({ swap_cantrip: { old: 'Light', new: 'Mage Hand' }, swap_spell: { old: 'Cure Wounds', new: 'Aid' } }),
      ),
    ).toEqual({
      body: {
        choices: {
          hp: 'average',
          replace_cantrip: { old: 'Light', new: 'Mage Hand' },
          replace_spell: { old: 'Cure Wounds', new: 'Aid' },
        },
      },
    });
  });

  it('reads the options whether they came flat or grouped by level', () => {
    expect(spellOptionNames(['Light', { name: 'Witchlight', homebrew: true }])).toEqual(['Light', 'Witchlight']);
    expect(spellOptionNames({ '1': ['Shield'], '2': ['Misty Step'] })).toEqual(['Shield', 'Misty Step']);
    expect(spellOptionNames(undefined)).toEqual([]);
  });
});

describe('a Wizard new spellbook pages', () => {
  it('takes exactly as many as the level copies in', () => {
    expect(spellbookProblem(book, ['Shield', 'Misty Step'])).toBeNull();
    expect(spellbookProblem(book, ['Shield'])).toBe('Pick 2 spells to copy into your spellbook (you have picked 1).');
  });

  it('refuses the same spell twice, or one already in the book', () => {
    expect(spellbookProblem(book, ['Shield', 'Shield'])).toBe('Each spell can only be copied into the spellbook once.');
    expect(spellbookProblem(book, ['Shield', 'Magic Missile'])).toBe('"Magic Missile" is already in your spellbook.');
  });

  it('refuses a spell that is not on offer at this level', () => {
    expect(spellbookProblem(book, ['Shield', 'Fireball'])).toBe('"Fireball" is not a spell you can copy this level.');
  });

  it('holds the level until the book is right, then sends the pages', () => {
    const options = srd({ spellcasting: casting({ spellbook: book }) });
    expect(buildLevelUpBody(options, picksWith())).toEqual({
      error: 'Pick 2 spells to copy into your spellbook (you have picked 0).',
    });
    expect(buildLevelUpBody(options, picksWith({ spellbook: ['Shield', 'Sleep'] }))).toEqual({
      body: { choices: { hp: 'average', spellbook: ['Shield', 'Sleep'] } },
    });
  });
});
