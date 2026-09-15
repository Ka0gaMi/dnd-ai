import { describe, expect, it } from 'vitest';
import {
  DIE_SURGERY_REASON,
  classifyClause,
  clauseSchema,
  clausesSchema,
  defaultDecide,
  describeClause,
  type ClauseInput,
} from '../src/core/mechanics.js';
import { powerReport } from '../src/core/progression.js';
import * as srd from '../src/srd/data.js';

/**
 * The calibration test: every origin feat must be expressible as clauses and price within a quarter
 * of one feat, which is what the whole budget is anchored to. The numbers in the pricing table are
 * tuned here and nowhere else - never per feat.
 *
 * The feats are test data. Alert, Magic Initiate, Savage Attacker and Skilled are the origin feats
 * of SRD 5.2.1 ("Feats", Origin) and are bundled in srd/5e-bits/Feats.json; the other six 2024
 * origin feats are not in the SRD, so only their mechanics are written out here, as anchors.
 */
const ORIGIN_FEATS: Record<string, ClauseInput[]> = {
  Alert: [
    { when: 'initiative', do: [{ kind: 'bonus', to: 'initiative', amount: 'prof' }] },
    {
      when: 'initiative',
      do: [{ kind: 'note', text: 'You can swap your Initiative with a willing ally who is not Incapacitated.' }],
      decide: 'ask_after',
    },
  ],
  Crafter: [
    {
      when: 'always',
      do: [
        { kind: 'proficiency', tool: "carpenter's tools" },
        { kind: 'proficiency', tool: "mason's tools" },
        { kind: 'proficiency', tool: "smith's tools" },
      ],
    },
    { when: 'always', do: [{ kind: 'note', text: 'A discount on the gear you buy, and faster crafting.' }] },
  ],
  Healer: [
    {
      when: 'action',
      do: [{ kind: 'effect', effect: { kind: 'heal', healing: { dice: '1d6' }, targets: 1 }, economy: 'action' }],
      uses: { per: 'short', count: 'prof' },
    },
    { when: 'roll', if: { kind: 'heal' }, do: [{ kind: 'reroll', keep: 'new' }], decide: 'ask_after' },
    {
      when: 'action',
      do: [{ kind: 'note', text: 'A Healer’s Kit stabilises a creature, and it regains a Hit Point.' }],
    },
  ],
  Lucky: [
    { when: 'roll', do: [{ kind: 'advantage' }], uses: { per: 'long', count: 'prof' }, decide: 'ask_before' },
    {
      when: 'roll',
      if: { kind: 'attack' },
      do: [{ kind: 'disadvantage' }],
      uses: { per: 'long', count: 'prof' },
      decide: 'ask_after',
    },
  ],
  'Magic Initiate': [
    {
      when: 'always',
      do: [
        { kind: 'cantrip_known', name: 'Guidance' },
        { kind: 'cantrip_known', name: 'Sacred Flame' },
        { kind: 'always_prepared', name: 'Cure Wounds' },
      ],
    },
    {
      when: 'action',
      do: [{ kind: 'effect', effect: { kind: 'utility' }, economy: 'action' }],
      uses: { per: 'long', count: 1 },
    },
  ],
  Musician: [
    {
      when: 'always',
      do: [
        { kind: 'proficiency', tool: 'drum' },
        { kind: 'proficiency', tool: 'flute' },
        { kind: 'proficiency', tool: 'lute' },
      ],
    },
    { when: 'rest_short', do: [{ kind: 'grant_inspiration' }] },
  ],
  'Savage Attacker': [
    {
      when: 'roll',
      if: { kind: 'damage', source: 'weapon' },
      do: [{ kind: 'reroll', keep: 'higher' }],
      uses: 'once_per_turn',
      decide: 'ask_after',
    },
  ],
  Skilled: [
    {
      when: 'always',
      do: [
        { kind: 'proficiency', skill: 'insight' },
        { kind: 'proficiency', skill: 'stealth' },
        { kind: 'proficiency', tool: "thieves' tools" },
      ],
    },
  ],
  'Tavern Brawler': [
    {
      when: 'roll',
      if: { kind: 'damage', source: 'unarmed' },
      do: [{ kind: 'reroll', keep: 'new' }],
      decide: 'ask_after',
    },
    { when: 'always', do: [{ kind: 'note', text: 'Your Unarmed Strike uses a bigger damage die.' }] },
    { when: 'hit', if: { source: 'unarmed' }, do: [{ kind: 'push_ft', amount: 5 }], uses: 'once_per_turn' },
    { when: 'always', do: [{ kind: 'proficiency', weapon: 'improvised weapons' }] },
  ],
  Tough: [{ when: 'always', do: [{ kind: 'hp_per_level', amount: 2 }] }],
};

const price = (clauses: ClauseInput[]): number => powerReport({ clauses: clausesSchema.parse(clauses) }).budget_used;

// --- the class features the language has to carry ----------------------------

interface Encoded {
  clauses: ClauseInput[];
  /** What of the feature the clauses do not carry, where a note stands in for it. */
  gap?: string;
}

/** Sorcerer and Fighter 1-6 (including the SRD subclass features at those levels), as clauses. */
const CLASS_FEATURES: Record<string, Encoded> = {
  'Fighter: Second Wind': {
    clauses: [
      {
        when: 'action',
        do: [
          { kind: 'effect', effect: { kind: 'heal', healing: { dice: '1d10+level' }, targets: 1 }, economy: 'bonus' },
        ],
        uses: { per: 'short', count: 2 },
      },
    ],
  },
  'Fighter: Tactical Mind': {
    clauses: [
      {
        when: 'roll',
        if: { kind: 'check', roll: { failed: true } },
        do: [{ kind: 'bonus', to: 'check', amount: '1d10' }],
        uses: { per: 'short', count: 2 },
        decide: 'ask_after',
      },
    ],
    gap: 'it spends Second Wind rather than its own uses.',
  },
  'Fighter: Fighter Subclass': {
    clauses: [{ when: 'always', do: [{ kind: 'note', text: 'You gain a Fighter subclass of your choice.' }] }],
  },
  'Fighter: Extra Attack': { clauses: [{ when: 'always', do: [{ kind: 'extra_attack', amount: 1 }] }] },
  'Fighter: Action Surge': {
    clauses: [{ when: 'action', do: [{ kind: 'extra_action' }], uses: { per: 'short', count: 1 } }],
  },
  'Fighter: Improved Critical': { clauses: [{ when: 'always', do: [{ kind: 'crit_range', min: 19 }] }] },
  'Fighter: Remarkable Athlete': {
    clauses: [
      { when: 'roll', if: { kind: 'initiative' }, do: [{ kind: 'advantage' }] },
      { when: 'roll', if: { kind: 'check', skill: ['athletics'] }, do: [{ kind: 'advantage' }] },
      {
        when: 'hit',
        do: [{ kind: 'note', text: 'After a Critical Hit you can move half your Speed without provoking.' }],
      },
    ],
    gap: 'move_ft cannot say "half your Speed", so the movement is a note.',
  },
  'Sorcerer: Sorcerer Subclass': {
    clauses: [{ when: 'always', do: [{ kind: 'note', text: 'You gain a Sorcerer subclass of your choice.' }] }],
  },
  'Sorcerer: Sorcerous Restoration': {
    clauses: [
      {
        when: 'rest_short',
        do: [{ kind: 'recover_resource', key: 'sorcery_points', amount: 'half_level' }],
        uses: { per: 'long', count: 1 },
      },
    ],
  },
  'Sorcerer: Draconic Resilience': {
    clauses: [
      { when: 'always', do: [{ kind: 'hp_per_level', amount: 1 }] },
      {
        when: 'always',
        if: { self: { wearing: 'no_armor' } },
        do: [{ kind: 'note', text: 'Your AC is 10 plus your DEX and CHA modifiers.' }],
      },
    ],
    gap: 'there is no verb for an unarmoured AC formula.',
  },
  'Sorcerer: Draconic Spells': {
    clauses: [
      {
        when: 'always',
        do: [
          { kind: 'always_prepared', name: 'Chromatic Orb' },
          { kind: 'always_prepared', name: 'Command' },
          { kind: 'always_prepared', name: 'Dragon’s Breath' },
        ],
      },
    ],
  },
  'Sorcerer: Elemental Affinity': {
    clauses: [
      {
        when: 'spell_damage',
        if: { damage_type: ['fire'] },
        do: [{ kind: 'bonus', to: 'damage', amount: 'ability:cha' }],
        uses: 'once_per_turn',
      },
      { when: 'always', do: [{ kind: 'resistance', types: ['fire'] }] },
    ],
  },
};

/** The features the language cannot say yet, and the verb each one is waiting for. */
const CANNOT_EXPRESS: Record<string, string> = {
  'Fighter: Fighting Style': 'grant_feat - a feature that hands out a feat the player chooses',
  'Fighter: Weapon Mastery': 'weapon_mastery - choose N mastery properties, swappable on a rest',
  'Fighter: Ability Score Improvement': 'grant_feat - a feature that hands out a feat the player chooses',
  'Fighter: Tactical Shift': 'when: feature_used - a clause that triggers off another feature, plus move_ft "half_speed"',
  'Sorcerer: Spellcasting': 'spellcasting - an ability, a spell list and a slot table',
  'Sorcerer: Innate Sorcery': 'a self-buff with a duration other clauses can test (the spell save DC bonus is there now)',
  'Sorcerer: Font of Magic': 'a resource pool with conversions (sorcery points to slots and back)',
  'Sorcerer: Metamagic': 'when: cast with do: change_spell - altering a spell as it is cast',
  'Sorcerer: Ability Score Improvement': 'grant_feat - a feature that hands out a feat the player chooses',
};

/** Sorcerer and Fighter features up to level 6, as the bundled SRD lists them. */
function classFeatures(): string[] {
  return srd
    .features()
    .filter((feature) => {
      const className = feature.class?.name;
      if (className !== 'Fighter' && className !== 'Sorcerer') return false;
      return Number(String(feature.level?.index ?? '').split('-').pop()) <= 6;
    })
    .map((feature) => `${feature.class!.name}: ${feature.name}`);
}

describe('the pricing table, calibrated against the origin feats', () => {
  for (const [name, clauses] of Object.entries(ORIGIN_FEATS)) {
    it(`prices ${name} at about one feat`, () => {
      expect(() => clausesSchema.parse(clauses)).not.toThrow();
      const used = price(clauses);
      expect(used).toBeGreaterThanOrEqual(0.75);
      expect(used).toBeLessThanOrEqual(1.25);
    });
  }

  it('prices the worked examples the way the design does', () => {
    // Forceful Focus: 0.5 (1d6) x 0.75 (one damage type) x 0.5 (once a turn) = 0.19, floored to 0.25.
    const forcefulFocus: ClauseInput[] = [
      {
        when: 'spell_damage',
        if: { damage_type: ['force'] },
        do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
        uses: 'once_per_turn',
      },
    ];
    expect(price(forcefulFocus)).toBe(0.25);
    expect(describeClause(clauseSchema.parse(forcefulFocus[0]))).toBe(
      'Extra 1d6 force damage when a spell deals force damage, once per turn',
    );

    // Goblin-Bane: 0.5 (+1 damage) x 0.5 (one target type) = 0.25.
    expect(
      price([
        { when: 'damage_dealt', if: { target: { type: ['goblinoid'] } }, do: [{ kind: 'bonus', to: 'damage', amount: 1 }] },
      ]),
    ).toBe(0.25);

    // Mystic Investigator: a proficiency and a once-a-day Advantage - half a feat, which is what it is.
    expect(
      price([
        { when: 'always', do: [{ kind: 'proficiency', skill: 'investigation' }] },
        {
          when: 'roll',
          if: { kind: 'check', skill: ['arcana', 'investigation'] },
          do: [{ kind: 'advantage' }],
          uses: { per: 'long', count: 1 },
          decide: 'ask_before',
        },
      ]),
    ).toBe(0.5);
  });

  it('floors a priced clause at a quarter of a feat and charges a note the same', () => {
    expect(price([{ when: 'always', do: [{ kind: 'note', text: 'You know when the tide turns.' }] }])).toBe(0.25);
    expect(price([{ when: 'roll', do: [{ kind: 'advantage' }], uses: 'once_ever' }])).toBe(0.25);
  });
});

describe('the language carries the class features', () => {
  for (const [name, encoded] of Object.entries(CLASS_FEATURES)) {
    it(`expresses ${name}`, () => {
      expect(() => clausesSchema.parse(encoded.clauses)).not.toThrow();
    });
  }

  it('accounts for every Sorcerer and Fighter feature up to level 6', () => {
    const missing = classFeatures().filter((name) => !(name in CLASS_FEATURES) && !(name in CANNOT_EXPRESS));
    expect(missing).toEqual([]);
  });
});

describe('the clause language', () => {
  it('takes four clauses per feature and no more', () => {
    const one: ClauseInput = { when: 'always', do: [{ kind: 'grant_inspiration' }] };
    expect(() => clausesSchema.parse([one, one, one, one])).not.toThrow();
    expect(() => clausesSchema.parse([one, one, one, one, one])).toThrow();
  });

  it('takes SRD conditions and the marked flag, and names the list when it does not', () => {
    expect(() =>
      clauseSchema.parse({
        when: 'hit',
        do: [{ kind: 'condition', name: 'prone', until: 'end_of_target_next_turn' }],
      }),
    ).not.toThrow();
    expect(() => clauseSchema.parse({ when: 'hit', do: [{ kind: 'mark_target' }], if: { target: { condition: ['marked'] } } })).not.toThrow();
    expect(() =>
      clauseSchema.parse({ when: 'hit', do: [{ kind: 'condition', name: 'dazzled', until: 'save_ends' }] }),
    ).toThrow(/not a condition.*blinded/s);
    // The same holds inside a spell-shaped effect, which is the other way a condition is named.
    expect(() =>
      clauseSchema.parse({
        when: 'action',
        do: [
          {
            kind: 'effect',
            economy: 'action',
            effect: { kind: 'save', save_ability: 'con', condition: { name: 'dazzled', duration_rounds: 1 } },
          },
        ],
      }),
    ).toThrow(/not a condition.*blinded/s);
  });

  it('says which clauses run, which are planned and which only remind, and why', () => {
    // The hooks the H2 interpreter reads run; a verb it has no seam for is still planned.
    const runs = clauseSchema.parse({
      when: 'hit',
      do: [{ kind: 'extra_damage', dice: '1d6', type: 'fire' }],
    });
    expect(classifyClause(runs)).toEqual({ status: 'runs', reasons: [] });

    // Damage-die surgery has no seam between the dice and the total, so it reminds at the damage roll.
    const surgery = clauseSchema.parse({ when: 'roll', if: { kind: 'damage' }, do: [{ kind: 'max_damage_dice' }] });
    expect(classifyClause(surgery)).toEqual({ status: 'reminds', reasons: [DIE_SURGERY_REASON] });

    // A clause action with its own payload still waits for H3, which is what planned means.
    const planned = clauseSchema.parse({
      when: 'action',
      do: [{ kind: 'effect', economy: 'action', effect: { kind: 'auto', damage: { dice: '2d6', type: 'fire' } } }],
    });
    expect(classifyClause(planned).status).toBe('planned');

    const forcefulFocus = clauseSchema.parse({
      when: 'spell_damage',
      if: { damage_type: ['force'] },
      do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
      uses: 'once_per_turn',
    });
    expect(classifyClause(forcefulFocus).status).toBe('runs');

    const dim = clauseSchema.parse({ when: 'roll', if: { light: 'dim' }, do: [{ kind: 'advantage' }] });
    expect(classifyClause(dim).status).toBe('reminds');
    expect(classifyClause(dim).reasons.join(' ')).toMatch(/R7/);

    const note = clauseSchema.parse({ when: 'turn_end', do: [{ kind: 'note', text: 'The ravens watch you.' }] });
    expect(classifyClause(note).status).toBe('reminds');
  });

  it('leaves a gain automatic and hands a choice to the player', () => {
    const passive = clauseSchema.parse({ when: 'always', do: [{ kind: 'resistance', types: ['cold'] }] });
    expect(defaultDecide('You can shrug off the cold.', passive)).toBe('auto');

    const rider = clauseSchema.parse({ when: 'hit', do: [{ kind: 'extra_damage', dice: '1d6' }] });
    expect(defaultDecide('You deal an extra 1d6 damage.', rider)).toBe('auto');

    const boost = clauseSchema.parse({ when: 'roll', if: { kind: 'check' }, do: [{ kind: 'advantage' }] });
    expect(defaultDecide('Once per Long Rest you can give yourself Advantage.', boost)).toBe('ask_before');

    const stance = clauseSchema.parse({ when: 'roll', if: { kind: 'damage' }, do: [{ kind: 'reroll', keep: 'higher' }] });
    expect(defaultDecide('You can roll the damage dice twice.', stance)).toBe('ask_after');
  });

  it('calls an un-narrowed roll clause a D20 Test, not an ability check', () => {
    const any = clauseSchema.parse({ when: 'roll', do: [{ kind: 'advantage' }], uses: { per: 'long', count: 1 } });
    expect(describeClause(any)).toBe('Advantage when you roll a D20 Test, 1 per long rest');

    const check = clauseSchema.parse({ when: 'roll', if: { kind: 'check' }, do: [{ kind: 'advantage' }] });
    expect(describeClause(check)).toBe('Advantage when you roll an ability check');
  });

  it('hands the choice over at every hook, not only on a roll', () => {
    // Nothing asks the player after a hit, so a rider is chosen before the swing - and a miss costs
    // nothing, because the use rides on the rider rather than on the declaration.
    const push = clauseSchema.parse({ when: 'hit', do: [{ kind: 'push_ft', amount: 10 }] });
    expect(defaultDecide('When you hit a creature you can push it 10 feet.', push)).toBe('ask_before');

    // Taking the action is already the choice, so nothing is asked on top of it.
    const teleport = clauseSchema.parse({
      when: 'action',
      do: [{ kind: 'move_ft', amount: 15, no_opportunity_attacks: true }],
      uses: { per: 'long', count: 1 },
    });
    expect(defaultDecide('As a Bonus Action you can teleport 15 feet.', teleport)).toBe('auto');

    const kill = clauseSchema.parse({ when: 'kill', do: [{ kind: 'temp_hp', amount: 5 }] });
    expect(defaultDecide('When you drop a creature you can gain 5 Temporary Hit Points.', kill)).toBe('ask_before');

    // A turn edge is not a swing: there is no moment before it to offer the choice at.
    const regen = clauseSchema.parse({ when: 'turn_start', do: [{ kind: 'temp_hp', amount: 5 }] });
    expect(defaultDecide('At the start of your turn you can gain 5 Temporary Hit Points.', regen)).toBe('ask_after');
  });
});

describe('pricing sanity', () => {
  const verdict = (clauses: ClauseInput[]): string => powerReport({ clauses: clausesSchema.parse(clauses) }).verdict;

  it('never lets a drawback pay for power', () => {
    const withPenalty: ClauseInput[] = [
      {
        when: 'always',
        do: [
          { kind: 'bonus', to: 'ac', amount: -4 },
          { kind: 'extra_attack', amount: 3 },
        ],
      },
    ];
    const attacksAlone: ClauseInput[] = [{ when: 'always', do: [{ kind: 'extra_attack', amount: 3 }] }];
    expect(price(withPenalty)).toBeGreaterThanOrEqual(price(attacksAlone));
    expect(verdict(withPenalty)).toBe('over_budget');
  });

  it('puts the verbs a feat never had above a feat', () => {
    // Extra Attack is a level 5 class feature, not something a boon hands out.
    expect(verdict([{ when: 'always', do: [{ kind: 'extra_attack' }] }])).toBe('over_budget');
    expect(verdict([{ when: 'always', do: [{ kind: 'immunity', types: ['fire'] }] }])).toBe('over_budget');
    expect(
      verdict([
        {
          when: 'hit',
          if: { weapon: { melee: true } },
          do: [{ kind: 'condition', name: 'prone', until: 'save_ends' }],
        },
      ]),
    ).toBe('over_budget');
    expect(
      verdict([
        {
          when: 'always',
          do: [
            { kind: 'free_standard_action', name: 'dash' },
            { kind: 'free_standard_action', name: 'disengage' },
            { kind: 'free_standard_action', name: 'dodge' },
            { kind: 'free_standard_action', name: 'hide' },
          ],
        },
      ]),
    ).toBe('over_budget');
  });

  it('prices the verbs H2 added', () => {
    // Action Surge is a whole second action: two feats, like an extra attack.
    expect(price([{ when: 'action', do: [{ kind: 'extra_action' }] }])).toBe(2);
    // A spell save DC is priced like an attack, half a feat a point.
    expect(price([{ when: 'cast', do: [{ kind: 'bonus', to: 'spell_save_dc', amount: 1 }] }])).toBe(0.5);
    // A scaling token is priced at the reference level, and the rule text says so.
    const scaling = powerReport({
      clauses: clausesSchema.parse([{ when: 'action', do: [{ kind: 'extra_heal', dice: '1d10+level' }] }]),
    });
    expect(scaling.items[0]!.rule).toMatch(/priced at level 4/);
    expect(describeClause(clauseSchema.parse({ when: 'action', do: [{ kind: 'extra_heal', dice: '1d10+level' }] }))).toBe(
      'Extra 1d10 + your level healing',
    );
  });

  it('leaves the prices a feat does carry where they were', () => {
    expect(price([{ when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 2 }] }])).toBe(1);
    expect(price([{ when: 'roll', if: { kind: 'attack' }, do: [{ kind: 'advantage' }] }])).toBe(1);
    expect(price([{ when: 'always', do: [{ kind: 'resistance', types: ['fire', 'cold', 'acid'] }] }])).toBe(1.5);
    expect(price([{ when: 'always', do: [{ kind: 'crit_range', min: 18 }] }])).toBe(2);
  });
});
