import { describe, expect, it } from 'vitest';
import {
  HELP_KEYS,
  actionHelpKey,
  conditionHelpKey,
  damageHelpKey,
  featureHelpKey,
  helpFor,
  relationHelpKey,
  senseHelp,
  sizeHelpKey,
  typeHelpKey,
} from '../src/lib/rulesHelp';

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const SKILLS = [
  'acrobatics',
  'animal_handling',
  'arcana',
  'athletics',
  'deception',
  'history',
  'insight',
  'intimidation',
  'investigation',
  'medicine',
  'nature',
  'perception',
  'performance',
  'persuasion',
  'religion',
  'sleight_of_hand',
  'stealth',
  'survival',
];
const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
];
const DAMAGE = [
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
];
const CREATURE_TYPES = [
  'aberration',
  'beast',
  'celestial',
  'construct',
  'dragon',
  'elemental',
  'fey',
  'fiend',
  'giant',
  'humanoid',
  'monstrosity',
  'ooze',
  'plant',
  'undead',
];
const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
const RELATION_SIDES = [
  'parent',
  'child',
  'spouse',
  'sibling',
  'ally',
  'enemy',
  'member_of',
  'has_member',
  'owns',
  'owned_by',
  'rules',
  'ruled_by',
  'serves',
  'served_by',
  'knows',
  'rival',
  'lover',
];
const ACTION_IDS = [
  'move',
  'attack:Longbow',
  'action:Multiattack',
  'cast:Fire Bolt',
  'bonus:Second Wind',
  'reaction:Parry',
  'dash',
  'disengage',
  'dodge',
  'help',
  'hide',
  'ready',
  'utilize',
  'death_save',
];

/** Every key the components ask for, so a renamed entry cannot quietly leave a label bare. */
const USED_KEYS = [
  ...ABILITIES.map((a) => `ability.${a}`),
  ...ABILITIES.map((a) => `save.${a}`),
  ...SKILLS.map((s) => `skill.${s}`),
  ...CONDITIONS.map((c) => `condition.${c}`),
  ...DAMAGE.map((d) => `damage.${d}`),
  ...CREATURE_TYPES.map((t) => `type.${t}`),
  ...SIZES.map((s) => `size.${s.toLowerCase()}`),
  ...ACTION_IDS.map(actionHelpKey),
  ...RELATION_SIDES.map(relationHelpKey),
  'ability_score',
  'ability_modifier',
  'hp',
  'temp_hp',
  'hit_dice',
  'ac',
  'speed',
  'initiative',
  'proficiency_bonus',
  'passive_perception',
  'xp',
  'gold',
  'carrying_capacity',
  'encumbered',
  'attunement',
  'magic_charges',
  'saving_throws',
  'skills',
  'inspiration',
  'exhaustion',
  'concentration',
  'death_saves',
  'conditions',
  'spellcasting_ability',
  'spell_save_dc',
  'spell_attack_bonus',
  'spell_slots',
  'cantrips',
  'prepared',
  'known',
  'spellbook',
  'always_prepared',
  'spell_swap',
  'expertise',
  'fighting_style',
  'metamagic',
  'invocations',
  'cr',
  'creature_type',
  'senses',
  'movement_left',
  'action',
  'bonus_action',
  'reaction',
  'cover',
  'advantage',
  'natural_20',
  'damage_types',
  'resistances',
  'immunities',
  'vulnerabilities',
  'bloodied',
  'distance',
  'sense.darkvision',
  'sense.blindsight',
  'sense.tremorsense',
  'sense.truesight',
  'sense.passive_perception',
  'story.act',
  'story.chapter',
  'story.thread',
  'story.clue',
  'story.rumour_scope',
  'story.journal',
  'codex.voice_card',
  'codex.relations',
  'power_budget',
  'rules_mode',
  'xp_mode',
  'milestone',
  'library',
  'custom_subclass',
  'custom_spell',
  'session_rhythm',
];

describe('rules help', () => {
  it('has an entry for every key the components ask for', () => {
    const missing = USED_KEYS.filter((key) => helpFor(key) === null);
    expect(missing).toEqual([]);
  });

  it('keeps every entry short and plainly worded', () => {
    for (const key of HELP_KEYS) {
      const entry = helpFor(key)!;
      expect(entry.title.length).toBeGreaterThan(2);
      expect(entry.text.length).toBeGreaterThan(20);
      // One or two sentences: enough to teach, short enough to read in a tooltip.
      expect(entry.text.split(/[.!?](\s|$)/).filter((part) => part.trim().length > 1).length).toBeLessThanOrEqual(3);
    }
  });

  it('maps an action id, with or without its target, to one entry', () => {
    expect(actionHelpKey('dash')).toBe('action.dash');
    expect(actionHelpKey('attack:Longbow')).toBe('action.attack');
    expect(helpFor(actionHelpKey('cast:Fire Bolt'))?.title).toBe('Cast a spell');
  });

  it('falls back to the general condition help for anything unknown', () => {
    expect(conditionHelpKey('Prone')).toBe('condition.prone');
    expect(conditionHelpKey('Sleight of foot')).toBe('conditions');
    expect(typeHelpKey('Fey')).toBe('type.fey');
    expect(sizeHelpKey('Large')).toBe('size.large');
  });

  it('gives every side of a tie its own entry, and anything new the general one', () => {
    expect(relationHelpKey('member_of')).toBe('relation.member_of');
    expect(relationHelpKey('has_member')).toBe('relation.has_member');
    expect(relationHelpKey('sworn_to')).toBe('codex.relations');
  });

  it('gives the level-up features that are a choice their own entry', () => {
    expect(featureHelpKey('Expertise')).toBe('expertise');
    expect(featureHelpKey('Eldritch Invocations')).toBe('invocations');
    expect(featureHelpKey('Extra Attack')).toBeNull();
  });

  it('finds the damage word inside a longer phrase', () => {
    expect(damageHelpKey('piercing from nonmagical attacks')).toBe('damage.piercing');
    expect(damageHelpKey('bludgeoning')).toBe('damage.bludgeoning');
    expect(damageHelpKey('sunlight')).toBeNull();
  });

  it('reads a creature own range into the sense wording', () => {
    const dark = senseHelp('Darkvision 60 ft.');
    expect(dark?.title).toBe('Darkvision 60 ft');
    expect(dark?.text).toContain('out to 60 ft');
    expect(dark?.glossaryTerm).toBe('Vision and Light');
    expect(senseHelp('passive Perception 13')?.title).toBe('passive Perception 13');
    expect(senseHelp('keen smell')).toBeNull();
  });
});
