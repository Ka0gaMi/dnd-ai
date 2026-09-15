import { describe, expect, it } from 'vitest';
import {
  applyMechanicEdits,
  budgetShare,
  buildLevelUpBody,
  canSaveToLibrary,
  clauseChip,
  clauseStatusChip,
  detailHeader,
  emptyPicks,
  engineSummary,
  exemplarQuotes,
  featureClauseChips,
  featureUses,
  levelUpTitle,
  libraryView,
  mechanicsWords,
  normaliseOption,
  numericMechanics,
  optionHelp,
  pendingLevelUp,
  powerChip,
  recommendedAbilities,
  recommendedWhy,
  spellEffectWords,
  spellHeader,
  spellTooltip,
  tagBars,
  type Homebrew,
  type LevelUpAnswer,
  type LevelUpRecommendations,
  type LevelUpSrd,
  type LevelUpWindow,
  type OptionDetail,
  type PlayProfile,
  type PowerReport,
  type Suggestion,
} from '../src/lib/progression';

const report = (verdict: PowerReport['verdict'] = 'within', used = 1): PowerReport => ({
  budget_used: used,
  budget_allowed: 1,
  items: [{ part: '+1 to hit', cost: 0.5, rule: 'Every +1 to hit costs 0.5.' }],
  verdict,
  text: 'Power budget: 1 of 1 (within budget).',
});

const srd = (extra: Partial<LevelUpSrd> = {}): LevelUpSrd => ({
  supported: true,
  from_level: 3,
  to_level: 4,
  hp: { average: 6, roll: '1d10 + 2 (CON)', choose: ['average', 'roll'] },
  features: [{ name: 'Extra Attack', text: 'You attack twice.' }],
  ...extra,
});

const window_ = (extra: Partial<LevelUpWindow> = {}): LevelUpAnswer => ({
  character_id: 4,
  available: true,
  level_up: { to_level: 4, prepared_at: '2026-09-11T10:00:00.000Z', srd: srd(), suggestions: [], ...extra },
});

const suggestion = (extra: Partial<Suggestion> = {}): Suggestion => ({
  name: 'Trapwright',
  text: 'You rig a trap in a minute flat.',
  mechanics: { to_hit: 1 },
  justification: 'They have rigged something in every room so far.',
  report: report(),
  homebrew_id: 9,
  ...extra,
});

const homebrew = (extra: Partial<Homebrew> = {}): Homebrew => ({
  id: 3,
  campaign_id: 1,
  scope: 'campaign',
  kind: 'feature',
  name: 'Trapwright',
  schema: { text: 'You rig a trap in a minute flat.' },
  power_report: report(),
  power_label: 'within',
  created_by: 'dm',
  created_at: '2026-09-11T10:00:00.000Z',
  clauses: [],
  clause_status: [],
  ...extra,
});

describe('the level-up window', () => {
  it('shows only once the DM has prepared it, and never for a level the server cannot take', () => {
    expect(pendingLevelUp(null)).toBeNull();
    expect(pendingLevelUp(window_({ prepared_at: null }))).toBeNull();
    expect(pendingLevelUp(window_({ srd: { supported: false, message: 'Levels above 5 are not supported yet.' } }))).toBeNull();
    expect(pendingLevelUp(window_())?.to_level).toBe(4);
  });

  it('stays null while a level is available but the DM has not prepared a window yet', () => {
    expect(pendingLevelUp({ character_id: 4, available: true, level_up: null })).toBeNull();
  });

  it('titles itself from whichever level the server filled in', () => {
    expect(levelUpTitle(window_().level_up!)).toBe('Level 3 → 4');
    expect(levelUpTitle({ to_level: 2, prepared_at: null, srd: {}, suggestions: [] })).toBe('Level 1 → 2');
    expect(levelUpTitle({ to_level: null, prepared_at: null, srd: {}, suggestions: [] })).toBe('Level up');
  });
});

describe('the option hover', () => {
  const fireball: OptionDetail = {
    name: 'Fireball',
    level: 3,
    school: 'Evocation',
    casting_time: '1 action',
    range: '150 ft',
    duration: 'Instantaneous',
    short_text: 'A bead of fire blossoms into a roaring sphere.',
  };

  it('heads a spell with its level, school and the numbers beside it', () => {
    expect(detailHeader(fireball)).toBe('Level 3 · Evocation · 1 action · 150 ft · Instantaneous');
  });

  it('calls a level 0 spell a cantrip and says when it needs concentration', () => {
    expect(detailHeader({ ...fireball, name: 'Light', level: 0, concentration: true })).toBe(
      'Cantrip · Evocation · 1 action · 150 ft · Instantaneous · Concentration',
    );
  });

  it('heads a feat with its prerequisite, and a subclass with nothing at all', () => {
    expect(detailHeader({ name: 'Grappler', prerequisite: 'Strength 13 or higher', short_text: 'You grab harder.' }))
      .toBe('Prerequisite: Strength 13 or higher');
    expect(detailHeader({ name: 'Champion', short_text: 'Crits on 19.' })).toBe('');
    expect(detailHeader(undefined)).toBe('');
  });

  it('marks a ritual when it is not already concentration', () => {
    expect(detailHeader({ ...fireball, name: 'Find Familiar', concentration: false, ritual: true })).toBe(
      'Level 3 · Evocation · 1 action · 150 ft · Instantaneous · Ritual',
    );
    expect(detailHeader({ ...fireball, concentration: true, ritual: true })).toBe(
      'Level 3 · Evocation · 1 action · 150 ft · Instantaneous · Concentration',
    );
  });

  it('shows the server details, falls back to the rulebook, and keeps a reason a home', () => {
    const fallback = { title: 'Spells', text: 'What you can cast.' };
    expect(optionHelp('Fireball', fireball, fallback, null)).toEqual({
      title: 'Fireball',
      text: 'A bead of fire blossoms into a roaring sphere.',
    });
    expect(optionHelp('Fireball', undefined, fallback, null)).toBe(fallback);
    expect(optionHelp('Fireball', undefined, null, null)).toBeNull();
    expect(optionHelp('Fireball', undefined, null, 'It ends crowded fights.')).toEqual({ title: 'Fireball', text: '' });
  });

  it("lets the DM's own flavour text stand in for the rulebook's short text", () => {
    expect(optionHelp('Fireball', fireball, null, null, 'A custom bolt of starlight.')).toEqual({
      title: 'Fireball',
      text: 'A custom bolt of starlight.',
    });
    expect(optionHelp('Stormcaller', undefined, null, null, 'Calls down a storm.')).toEqual({
      title: 'Stormcaller',
      text: 'Calls down a storm.',
    });
  });

  it("tips a sheet spell with the fetched detail, else its level, else nothing at all", () => {
    expect(spellTooltip('Fireball', fireball)).toEqual({
      help: { title: 'Fireball', text: 'A bead of fire blossoms into a roaring sphere.' },
      head: 'Level 3 · Evocation · 1 action · 150 ft · Instantaneous',
    });
    expect(spellTooltip('Trapwright Bolt', null, 2)).toEqual({ help: { title: 'Trapwright Bolt', text: 'Level 2' }, head: '' });
    expect(spellTooltip('Fire Bolt', null)).toEqual({ help: null, head: '' });
  });
});

describe('the spell option normaliser', () => {
  it('reads a bare rulebook name as itself, with nothing homebrew about it', () => {
    expect(normaliseOption('Fire Bolt')).toEqual({ name: 'Fire Bolt', homebrew: false, homebrewId: null, powerLabel: null });
  });

  it('reads a homebrew object for its name and its own reported power', () => {
    expect(normaliseOption({ name: 'Starfall', homebrew: true, homebrew_id: 7, power_label: 'over_budget' })).toEqual({
      name: 'Starfall',
      homebrew: true,
      homebrewId: 7,
      powerLabel: 'over_budget',
    });
  });

  it('treats an object missing the homebrew flag as a rulebook option all the same', () => {
    expect(normaliseOption({ name: 'Shield' })).toEqual({ name: 'Shield', homebrew: false, homebrewId: null, powerLabel: null });
  });
});

describe('the homebrew spell effect and header', () => {
  it('reads damage, save, half-on-save and shape in the order a player would say them', () => {
    expect(
      spellEffectWords({ kind: 'damage', damage: '2d6 fire', save_ability: 'dex', half_on_save: true, shape: '20-ft sphere' }),
    ).toBe('2d6 fire, DEX save DC from your sheet, half on save, 20-ft sphere');
  });

  it('names healing and targets, and falls back to the bare kind when nothing else is set', () => {
    expect(spellEffectWords({ kind: 'healing', healing: '2d8', targets: 1 })).toBe('2d8 healing, 1 target');
    expect(spellEffectWords({ kind: 'utility', targets: 3 })).toBe('3 targets');
    expect(spellEffectWords({ kind: 'utility' })).toBe('utility');
  });

  it('heads a homebrew spell card the same way as the rulebook options, adding ritual', () => {
    expect(
      spellHeader({ level: 2, school: 'Conjuration', casting_time: '1 action', range: '30 ft', duration: '1 minute', ritual: true }),
    ).toBe('Level 2 · Conjuration · 1 action · 30 ft · 1 minute · Ritual');
    expect(spellHeader({ level: 0, school: 'Evocation' })).toBe('Cantrip · Evocation');
  });
});

describe("the DM's recommendations", () => {
  const recommendations: LevelUpRecommendations = {
    spells: [{ name: 'Shield', why: 'It saves you from the hit that drops you.' }],
    cantrips: [{ name: 'Fire Bolt', why: 'Damage when the slots run out.' }],
    subclass: { name: 'Champion', why: 'Fewest rules to hold in mind.' },
    feat: { name: 'Alert', why: 'You act first, which is half of surviving.' },
    asi: { abilities: ['DEX', 'con'], why: 'Both keep you standing.' },
    hp: 'average',
  };

  it('gives the reason for a recommended option, whatever its kind', () => {
    expect(recommendedWhy(recommendations, 'spell', 'Shield')).toBe('It saves you from the hit that drops you.');
    expect(recommendedWhy(recommendations, 'cantrip', 'Fire Bolt')).toBe('Damage when the slots run out.');
    expect(recommendedWhy(recommendations, 'subclass', 'Champion')).toBe('Fewest rules to hold in mind.');
    expect(recommendedWhy(recommendations, 'feat', 'Alert')).toBe('You act first, which is half of surviving.');
  });

  it('matches the name the way the player sees it, ignoring case and stray spaces', () => {
    expect(recommendedWhy(recommendations, 'spell', '  shield ')).toBe('It saves you from the hit that drops you.');
  });

  it('says nothing about an option the DM did not name, or a server that sent no recommendations', () => {
    expect(recommendedWhy(recommendations, 'spell', 'Fire Bolt')).toBeNull();
    expect(recommendedWhy(recommendations, 'subclass', 'Battle Master')).toBeNull();
    expect(recommendedWhy(undefined, 'feat', 'Alert')).toBeNull();
    expect(recommendedWhy({}, 'spell', 'Shield')).toBeNull();
  });

  it('lower-cases the recommended abilities to match the panel keys', () => {
    expect(recommendedAbilities(recommendations)).toEqual(['dex', 'con']);
    expect(recommendedAbilities({})).toEqual([]);
    expect(recommendedAbilities(undefined)).toEqual([]);
  });
});

describe('the level-up choice builder', () => {
  it('sends the hit point choice on its own when that is all the level asks for', () => {
    const built = buildLevelUpBody(srd(), { ...emptyPicks(), hp: 'roll' });
    expect(built).toEqual({ body: { choices: { hp: 'roll' } } });
  });

  it('asks for a subclass before it will send anything', () => {
    const options = srd({ subclass_choice: [{ name: 'Champion', summary: null, text: 'Crits on 19.' }] });
    expect(buildLevelUpBody(options, emptyPicks())).toEqual({ error: 'Pick a subclass.' });
    const built = buildLevelUpBody(options, { ...emptyPicks(), subclass: 'Champion' });
    expect(built).toEqual({ body: { choices: { hp: 'average', subclass: 'Champion' } } });
  });

  it('holds the ability score improvement to two points, or a feat instead', () => {
    const options = srd({ ability_score_improvement: { rule: 'Raise one by 2 or two by 1.', feat_options: [{ name: 'Alert', text: '+5 initiative.' }] } });
    expect(buildLevelUpBody(options, emptyPicks())).toEqual({ error: 'Raise one ability score by 2, or two scores by 1.' });
    expect(buildLevelUpBody(options, { ...emptyPicks(), increases: { str: 1 } })).toEqual({
      error: 'Raise one ability score by 2, or two scores by 1.',
    });
    expect(buildLevelUpBody(options, { ...emptyPicks(), increases: { str: 1, con: 1, dex: 0 } })).toEqual({
      body: { choices: { hp: 'average', ability_increases: { str: 1, con: 1 } } },
    });
    expect(buildLevelUpBody(options, { ...emptyPicks(), asi_mode: 'feat' })).toEqual({
      error: 'Pick a feat, or raise your ability scores instead.',
    });
    expect(buildLevelUpBody(options, { ...emptyPicks(), asi_mode: 'feat', feat: 'Alert' })).toEqual({
      body: { choices: { hp: 'average', feat: 'Alert' } },
    });
  });

  it('counts the new spells the level adds, exactly', () => {
    const options = srd({
      spellcasting: {
        cantrips_to_add: 1,
        spells_to_add: 2,
        cantrip_options: ['Fire Bolt', 'Light'],
        spell_options: { '1': ['Shield'], '2': ['Misty Step'] },
        max_spell_level: 2,
        spell_slots: { '1': { max: 4, used: 0 } },
      },
    });
    expect(buildLevelUpBody(options, emptyPicks())).toEqual({ error: 'Pick 1 new cantrip.' });
    expect(buildLevelUpBody(options, { ...emptyPicks(), cantrips: ['Light'] })).toEqual({ error: 'Pick 2 new spells.' });
    expect(
      buildLevelUpBody(options, { ...emptyPicks(), cantrips: ['Light'], spells: ['Shield', 'Misty Step'] }),
    ).toEqual({ body: { choices: { hp: 'average', cantrips: ['Light'], spells: ['Shield', 'Misty Step'] } } });
  });

  it('sends a picked suggestion as its library id, every suggestion carrying one already', () => {
    const suggestions = [suggestion({ homebrew_id: 12 }), suggestion({ name: 'Ratcatcher', homebrew_id: 15 })];
    expect(buildLevelUpBody(srd(), { ...emptyPicks(), suggestion: 0 }, suggestions)).toEqual({
      body: { choices: { hp: 'average' }, homebrew_ids: [12] },
    });
    expect(buildLevelUpBody(srd(), { ...emptyPicks(), suggestion: 1 }, suggestions)).toEqual({
      body: { choices: { hp: 'average' }, homebrew_ids: [15] },
    });
    expect(buildLevelUpBody(srd(), { ...emptyPicks(), suggestion: 4 }, suggestions)).toEqual({
      error: 'That suggestion is no longer on offer.',
    });
  });

  it('refuses a level the server said it cannot take, in its own words', () => {
    expect(buildLevelUpBody({ supported: false, message: 'Levels above 5 are not supported yet.' }, emptyPicks())).toEqual(
      { error: 'Levels above 5 are not supported yet.' },
    );
  });
});

describe('the power report', () => {
  it('chips within and over budget, and caps the bar at full', () => {
    expect(powerChip('within')).toEqual({ label: 'Within budget', tone: 'good' });
    expect(powerChip('over_budget')).toEqual({ label: 'Over budget', tone: 'warn' });
    expect(budgetShare(report('within', 0.5))).toBe(50);
    expect(budgetShare(report('over_budget', 2.5))).toBe(100);
  });

  it('says what a feature does in words', () => {
    expect(
      mechanicsWords({
        asi: [{ ability: 'dex', amount: 2 }],
        to_hit: 1,
        extra_damage: { dice: '1d6', per: 'hit' },
        once_per: 'short',
        effect: 'Vanish in smoke',
        skill_proficiencies: ['sleight_of_hand'],
        speed: 10,
        resistances: ['fire'],
        spells: ['Grease'],
        features_text: 'Rats follow you.',
      }),
    ).toEqual([
      'DEX +2',
      '+1 to hit',
      'Extra 1d6 damage on every hit',
      'Vanish in smoke, once per short rest',
      'Proficiency in sleight of hand',
      '+10 ft speed',
      'Resistance to fire damage',
      'Grease known',
      'Rats follow you.',
    ]);
  });

  it('offers only the numbers the server would take back, within its own bounds', () => {
    const mechanics = { asi: [{ ability: 'str', amount: 1 }], to_hit: 2, ac: 1, speed: 10, effect: 'nothing' };
    expect(numericMechanics(mechanics).map((field) => field.key)).toEqual(['asi.0', 'to_hit', 'ac', 'speed']);
    expect(applyMechanicEdits(mechanics, { 'asi.0': '2', to_hit: '1', ac: '1', speed: '20' })).toEqual({
      mechanics: { asi: [{ ability: 'str', amount: 2 }], to_hit: 1, ac: 1, speed: 20, effect: 'nothing' },
    });
    expect(applyMechanicEdits(mechanics, { 'asi.0': '3', to_hit: '1', ac: '1', speed: '20' })).toEqual({
      error: 'STR bonus: a whole number from 1 to 2.',
    });
    expect(applyMechanicEdits(mechanics, { 'asi.0': '1', to_hit: '', ac: '1', speed: '20' })).toEqual({
      error: 'To hit: a whole number from 0 to 5.',
    });
  });
});

describe('the library card', () => {
  it('reads both lists, and an older server as two empty ones', () => {
    expect(libraryView(null)).toEqual({ campaign: [], library: [] });
    expect(libraryView({ campaign: [homebrew()] }).campaign).toHaveLength(1);
    expect(libraryView({ campaign: [homebrew()] }).library).toEqual([]);
  });

  it('offers to keep only what this story owns', () => {
    expect(canSaveToLibrary(homebrew())).toBe(true);
    expect(canSaveToLibrary(homebrew({ scope: 'library', campaign_id: null }))).toBe(false);
  });
});

describe('clause presentation', () => {
  it('labels every server execution state in readable text', () => {
    expect(clauseStatusChip('runs')).toEqual({ label: 'Runs', tone: 'good' });
    expect(clauseStatusChip('planned')).toEqual({ label: 'Planned', tone: 'warn' });
    expect(clauseStatusChip('reminds')).toEqual({ label: 'Reminder', tone: 'bad' });
  });

  it('keeps raw sheet clauses compact without recreating the server description', () => {
    const clause = { when: 'hit', do: [{ kind: 'extra_damage' }], uses: { per: 'short' as const, count: 1 } };
    expect(clauseChip(clause)).toBe('extra damage · on hit · 1 / short rest');
    expect(featureClauseChips({ clauses: [clause] })).toEqual(['extra damage · on hit · 1 / short rest']);
  });

  it('shows available feature uses from the counter the sheet already carries', () => {
    expect(featureUses({ mechanics: { resource: 'rage', max: 3, used: 1, per: 'long' } })).toEqual({
      available: 2,
      max: 3,
      text: '2 / 3 uses · long rest',
    });
    expect(featureUses({ mechanics: { max: 3 } })).toBeNull();
  });
});

describe('the play profile card', () => {
  const profile: PlayProfile = {
    tags: { trap: 4, social: 2, stealth: 2 },
    exemplars: [
      { text: 'Rigged the door with a bucket of lamp oil.', tags: ['trap'], created_at: '2026-09-10T10:00:00.000Z' },
      { text: 'Talked the toll guard into a discount.', tags: ['social'], created_at: '2026-09-10T11:00:00.000Z' },
      { text: 'Crossed the yard unseen.', tags: ['stealth'], created_at: '2026-09-10T12:00:00.000Z' },
      { text: 'Set the barn alight.', tags: ['improvise'], created_at: '2026-09-10T13:00:00.000Z' },
    ],
    engine: {
      skills: { stealth: 8, arcana: 3, perception: 3 },
      rolls: { attack: 12, check: 20 },
      actions: {},
      effects: {},
    },
  };

  it('sizes each tag bar against the busiest one, biggest first', () => {
    expect(tagBars(profile)).toEqual([
      { tag: 'trap', label: 'trap', count: 4, share: 100 },
      { tag: 'social', label: 'social', count: 2, share: 50 },
      { tag: 'stealth', label: 'stealth', count: 2, share: 50 },
    ]);
    expect(tagBars({ ...profile, tags: {} })).toEqual([]);
  });

  it('shows three quotes and no more', () => {
    expect(exemplarQuotes(profile)).toHaveLength(3);
    expect(exemplarQuotes(profile)[0]!.text).toBe('Rigged the door with a bucket of lamp oil.');
  });

  it('summarises the engine tallies, biggest first and only the top few', () => {
    expect(engineSummary(profile)).toEqual([
      { label: 'Skills', text: 'stealth 8, arcana 3, perception 3' },
      { label: 'Dice', text: 'check 20, attack 12' },
    ]);
    expect(engineSummary(profile, 1)[0]).toEqual({ label: 'Skills', text: 'stealth 8' });
  });
});
