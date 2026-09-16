// The 2024 SRD conditions as mechanics the engine reads: what each one does to a d20, a speed or a turn.
import type { Ability } from '../core/rules.js';

export interface ConditionRule {
  /** One line for the DM, the legal-action hints and the guide. */
  summary: string;
  /** No action, bonus action or reaction; the supersets below carry it too. */
  incapacitated?: boolean;
  speed_zero?: boolean;
  /** The condition holder's own attack rolls. */
  attack_disadvantage?: boolean;
  attack_advantage?: boolean;
  /** Grappled: only the attacks aimed at anyone but the grappler suffer. */
  attack_disadvantage_except_grappler?: boolean;
  /** Attack rolls made against the holder. */
  attacked_advantage?: boolean;
  attacked_disadvantage?: boolean;
  /** Prone: advantage from within 5 ft, disadvantage from further away. */
  attacked_advantage_within_5ft?: boolean;
  /** A hit landed from within 5 ft is a critical hit. */
  crit_within_5ft?: boolean;
  /** The holder's ability checks. */
  check_disadvantage?: boolean;
  /** Saves the holder fails without rolling. */
  auto_fail_saves?: Ability[];
  save_disadvantage?: Ability[];
  /** Initiative is a DEX check: the condition's own edge on the roll. */
  initiative_advantage?: boolean;
  initiative_disadvantage?: boolean;
  /** Damage the holder resists while the condition holds; "all" is every type. */
  damage_resistances?: string[];
  /** Conditions the holder cannot receive. */
  condition_immunities?: string[];
  /** Only while the creature that caused it is in sight (Frightened). */
  while_source_seen?: boolean;
}

/** Keyed by the SRD condition name as the engine and the character sheet store it: lower case. */
export const CONDITIONS: Record<string, ConditionRule> = {
  blinded: {
    summary: 'Cannot see: its attacks have disadvantage, attacks against it have advantage, sight checks fail.',
    attack_disadvantage: true,
    attacked_advantage: true,
  },
  charmed: {
    summary: 'Cannot attack the charmer or target them with harmful effects; the charmer has advantage on social checks.',
  },
  deafened: { summary: 'Cannot hear: checks that need hearing fail.' },
  frightened: {
    summary: 'Disadvantage on attacks and checks while the source is in sight, and it cannot move closer to it.',
    attack_disadvantage: true,
    check_disadvantage: true,
    while_source_seen: true,
  },
  grappled: {
    summary:
      'Speed 0 and disadvantage on attacks against anyone but the grappler; ends if the grappler is incapacitated or the two are moved apart.',
    speed_zero: true,
    attack_disadvantage_except_grappler: true,
  },
  incapacitated: {
    summary: 'No action, bonus action or reaction, and concentration breaks.',
    incapacitated: true,
    initiative_disadvantage: true,
  },
  invisible: {
    summary: 'Unseen: its attacks have advantage, attacks against it have disadvantage.',
    attack_advantage: true,
    attacked_disadvantage: true,
    initiative_advantage: true,
  },
  paralyzed: {
    summary:
      'Incapacitated, speed 0, STR and DEX saves fail; attacks against it have advantage and a hit from within 5 ft is a critical hit.',
    incapacitated: true,
    speed_zero: true,
    attacked_advantage: true,
    crit_within_5ft: true,
    auto_fail_saves: ['str', 'dex'],
  },
  petrified: {
    summary:
      'Turned to stone: incapacitated, speed 0, resistance to all damage, immunity to Poisoned, STR and DEX saves fail, attacks against it have advantage.',
    incapacitated: true,
    speed_zero: true,
    attacked_advantage: true,
    auto_fail_saves: ['str', 'dex'],
    damage_resistances: ['all'],
    condition_immunities: ['poisoned'],
  },
  poisoned: { summary: 'Disadvantage on attack rolls and ability checks.', attack_disadvantage: true, check_disadvantage: true },
  prone: {
    summary:
      'On the ground: its attacks have disadvantage, attacks from within 5 ft have advantage and further ones disadvantage; standing up costs half its speed.',
    attack_disadvantage: true,
    attacked_advantage_within_5ft: true,
  },
  restrained: {
    summary: 'Speed 0, its attacks have disadvantage, attacks against it have advantage, DEX saves have disadvantage.',
    speed_zero: true,
    attack_disadvantage: true,
    attacked_advantage: true,
    save_disadvantage: ['dex'],
  },
  stunned: {
    summary: 'Incapacitated, STR and DEX saves fail, attacks against it have advantage.',
    incapacitated: true,
    attacked_advantage: true,
    auto_fail_saves: ['str', 'dex'],
  },
  unconscious: {
    summary:
      'Out cold and prone: incapacitated, speed 0, STR and DEX saves fail, attacks against it have advantage and a hit from within 5 ft is a critical hit.',
    incapacitated: true,
    speed_zero: true,
    attacked_advantage: true,
    crit_within_5ft: true,
    auto_fail_saves: ['str', 'dex'],
  },
};

export const conditionRule = (name: string): ConditionRule | undefined => CONDITIONS[name.trim().toLowerCase()];

/** Every rule a list of conditions brings, unknown names ignored. */
export const rulesOf = (conditions: string[]): ConditionRule[] =>
  conditions.map(conditionRule).filter((rule): rule is ConditionRule => rule !== undefined);

export const isIncapacitated = (conditions: string[]): boolean => rulesOf(conditions).some((r) => r.incapacitated);

export const hasSpeedZero = (conditions: string[]): boolean => rulesOf(conditions).some((r) => r.speed_zero);

/** The conditions in a list that stop a creature moving, for the message that refuses the move. */
export const speedZeroBy = (conditions: string[]): string[] =>
  conditions.filter((c) => conditionRule(c)?.speed_zero);

/** Damage a list of conditions resists; "all" is expanded to the SRD types by the engine. */
export const conditionDamageResistances = (conditions: string[]): string[] =>
  rulesOf(conditions).flatMap((r) => r.damage_resistances ?? []);

/** The conditions a creature holding this list cannot receive. */
export const conditionImmunitiesFrom = (conditions: string[]): string[] =>
  rulesOf(conditions).flatMap((r) => r.condition_immunities ?? []);

/** 2024 exhaustion: every d20 test is reduced by 2 per level, and death comes at level 6. */
export const exhaustionPenalty = (level: number): number => (level > 0 ? -2 * level : 0);

/** 2024 exhaustion: 5 ft of speed per level. */
export const exhaustionSpeedPenalty = (level: number): number => 5 * Math.max(0, level);

export const EXHAUSTION_DEATH = 6;
