// The 2024 species traits as engine mechanics: one handler per SRD trait index, held through a species row.
// They plug into the same hooks as the class features, so an action trait adds `action`, `resolve` and `resource`.
import type { Ability } from '../core/rules.js';
import { isIncapacitated, speedZeroBy } from './conditions.js';
import type { FeatureCost, FeatureHandler, HitAsk, HitRider, ResourcePeriod, RollSource, SaveAsk } from './features.js';
import { aoeTargets, type AoeShape } from './grid.js';
import { attacksPerAction, sheetAbilityMod, type CombatSheet, type SheetFeature } from './sheet.js';

// The trait states a fight carries on a combatant; they live in its flags bag beside the class features' own.
declare module './state.js' {
  interface CombatFlags {
    /** Large Form: the rounds left of its ten minutes. */
    large_form?: { rounds_left: number };
    /** Giant Ancestry's on-hit benefit, declared before the swing and spent on the hit that deals damage. */
    giant_ancestry_ready?: boolean;
    /** Stone's Endurance, declared before the blow: the next attack's damage loses 1d12 + CON. */
    stones_endurance_ready?: boolean;
    /** Storm's Thunder, declared before the blow: the next attacker within 60 ft takes 1d8 Thunder. */
    storms_thunder_ready?: boolean;
  }
}

/** The use Relentless Endurance spends, which a Long Rest gives back. */
export const RELENTLESS_ENDURANCE = { resource: 'relentless_endurance', label: 'Relentless Endurance', per: 'long' as const };

/** The pool every Giant Ancestry benefit draws on: Proficiency Bonus uses a Long Rest. */
export const GIANT_ANCESTRY = { resource: 'giant_ancestry', per: 'long' as const };

/** Storm's Thunder reaches a creature that hurt the Goliath from this far away. */
export const STORMS_THUNDER_FT = 60;

const TEN_MINUTES = 100;
const LARGE_FORM_FT = 10;
const MENTAL_SAVES: Ability[] = ['int', 'wis', 'cha'];

const cost = (resource: string): FeatureCost => ({ resource, amount: 1 });

/** Uses left of a trait's resource, read off the row a spend writes; nothing spent yet leaves the whole of it. */
const usesLeft = (sheet: CombatSheet, key: string, max: number): number =>
  max - (sheet.features.find((f) => f.mechanics?.resource === key)?.mechanics?.used ?? 0);

/** Refuses a declared use that has nothing left, before anything is written. */
function requireUse(sheet: CombatSheet, key: string, max: number, label: string, per: ResourcePeriod): void {
  if (usesLeft(sheet, key, max) > 0) return;
  throw new Error(
    `${sheet.name} has no ${label} left: it comes back on a ${per === 'short' ? 'Short or Long' : 'Long'} Rest, so call rest first or use something else.`,
  );
}

/** Advantage on the saves made to avoid or end one condition, as Brave, Fey Ancestry and Dwarven Resilience give. */
const againstCondition =
  (trait: string, condition: string) =>
  (ask: SaveAsk): RollSource[] =>
    ask.against?.includes(condition)
      ? [{ advantage: 'advantage', note: `${trait}: Advantage on a save against being ${condition}` }]
      : [];

// --- Breath Weapon ---------------------------------------------------------------

const BREATH_SHAPES: Record<'cone' | 'line', AoeShape> = {
  cone: { kind: 'cone', size_ft: 15 },
  line: { kind: 'line', size_ft: 30 },
};

/** Breath Weapon's d10s: one, and one more at character levels 5, 11 and 17. */
export const breathDice = (level: number): number => 1 + [5, 11, 17].filter((at) => level >= at).length;

/** 8 + Constitution modifier + Proficiency Bonus: the DC the Breath Weapon's save is made against. */
export const breathDc = (sheet: CombatSheet): number => 8 + sheetAbilityMod(sheet, 'con') + sheet.proficiency_bonus;

/** One Draconic Ancestor's Breath Weapon; the lineage decides which of them the sheet carries. */
function breathWeapon(type: 'acid' | 'cold' | 'fire' | 'lightning' | 'poison'): FeatureHandler {
  const name = `Breath Weapon: ${type[0]!.toUpperCase()}${type.slice(1)}`;
  return {
    index: `draconic-breath-weapon-${type}`,
    name,
    species: 'dragonborn',
    level: 1,
    resource: { key: 'breath_weapon', label: name, per: 'long', max: (sheet) => sheet.proficiency_bonus },
    action: (sheet) => ({
      id: 'breath_weapon',
      kind: 'action',
      name: 'Breath Weapon',
      hint: `In place of one attack of the Attack action: a 15 ft Cone (breath_weapon_cone, the default) or a 30 ft Line 5 ft wide (breath_weapon_line), aimed with point or target_id. Each creature in it makes a DEX save against DC ${breathDc(sheet)} for ${breathDice(sheet.level)}d10 ${type} damage, half on a success.`,
      cost: cost('breath_weapon'),
      targets: 'creature',
    }),
    resolve: (ask) => {
      const { actor, sheet } = ask;
      // It replaces one attack of the Attack action: the action itself, or one swing still owed by it.
      const swings = attacksPerAction(sheet);
      const taken = actor.flags.attacks_used ?? 0;
      const midAttack = actor.action_used && swings > 1 && taken > 0 && taken < swings;
      if (actor.action_used && !midAttack && !actor.flags.surge_action_banked) {
        throw new Error(
          `Breath Weapon replaces one attack of the Attack action, and ${actor.name} has no attack of it left this turn: use it after advance_turn.`,
        );
      }
      if (ask.option && ask.option !== 'cone' && ask.option !== 'line') {
        throw new Error(`Breath Weapon comes out as a cone or a line, not "${ask.option}": take breath_weapon_cone or breath_weapon_line.`);
      }
      const shape = BREATH_SHAPES[ask.option === 'line' ? 'line' : 'cone'];
      const aim = ask.point ?? (ask.target ? { x: ask.target.x, y: ask.target.y } : null);
      if (!aim) throw new Error('Aim the Breath Weapon: pass point {x, y}, or the target_id of a creature it is breathed at.');
      const inside = new Set(aoeTargets(ask.combatants, { x: actor.x, y: actor.y }, aim, shape).map((t) => t.id));
      const caught = ask.combatants.filter((c) => inside.has(c.id) && c.id !== actor.id);
      const dice = `${breathDice(sheet.level)}d10`;
      return {
        economy: midAttack ? 'free' : 'action',
        spend: cost('breath_weapon'),
        flags: { attacks_used: (midAttack ? taken : 0) + 1 },
        ...(caught.length
          ? {
              save: {
                ability: 'dex' as const,
                dc: breathDc(sheet),
                target_ids: caught.map((c) => c.id),
                damage_expr: dice,
                damage_type: type,
                half_on_save: true,
              },
            }
          : {}),
        text: `${actor.name} exhales ${type} in a ${shape.size_ft} ft ${shape.kind} (Breath Weapon, ${dice})${
          caught.length ? `: ${caught.map((c) => c.name).join(', ')} must save` : ', and it catches no one'
        }.`,
      };
    },
  };
}

// --- Giant Ancestry ----------------------------------------------------------------

/** One Giant Ancestry benefit, sharing the pool of uses every benefit draws on. */
function giantAncestry(
  benefit: string,
  rest: Omit<FeatureHandler, 'index' | 'name' | 'species' | 'level' | 'resource'>,
): FeatureHandler {
  const name = `Giant Ancestry: ${benefit}`;
  return {
    index: `giant-ancestry-${benefit.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-')}`,
    name,
    species: 'goliath',
    level: 1,
    resource: { key: GIANT_ANCESTRY.resource, label: name, per: GIANT_ANCESTRY.per, max: (sheet) => sheet.proficiency_bonus },
    ...rest,
  };
}

/** The on-hit benefits are declared before the swing, as a homebrew rider is, and cost nothing on a miss. */
function declareOnHit(id: string, benefit: string, hint: string, rider: (ask: HitAsk) => HitRider[]): FeatureHandler {
  return giantAncestry(benefit, {
    action: (sheet) => ({
      id,
      kind: 'free',
      name: benefit,
      hint: `Declare it before the swing: ${hint} The use is spent only on the hit that deals damage.`,
      cost: cost(GIANT_ANCESTRY.resource),
      targets: 'self',
    }),
    resolve: (ask) => {
      requireUse(ask.sheet, GIANT_ANCESTRY.resource, ask.sheet.proficiency_bonus, benefit, GIANT_ANCESTRY.per);
      if (ask.actor.flags.giant_ancestry_ready) {
        throw new Error(`${ask.actor.name} has ${benefit} declared already: attack first, and it lands on the next hit.`);
      }
      return {
        economy: 'free',
        flags: { giant_ancestry_ready: true },
        text: `${ask.actor.name} calls on their giant blood: the next hit carries ${benefit}.`,
      };
    },
    onHit: (ask) => {
      if (!ask.actor.flags.giant_ancestry_ready) return [];
      const riders = rider(ask);
      if (riders.length === 0) return [];
      return [
        ...riders,
        { kind: 'stance', feature: benefit, on: 'self', flags: { giant_ancestry_ready: undefined }, note: `${benefit} is spent.` },
      ];
    },
  });
}

// --- the registry ------------------------------------------------------------------

const TRAITS: FeatureHandler[] = [
  {
    index: 'brave',
    name: 'Brave',
    species: 'halfling',
    level: 1,
    beforeSave: againstCondition('Brave', 'frightened'),
  },
  {
    index: 'fey-ancestry',
    name: 'Fey Ancestry',
    species: 'elf',
    level: 1,
    beforeSave: againstCondition('Fey Ancestry', 'charmed'),
  },
  {
    index: 'dwarven-resilience',
    name: 'Dwarven Resilience',
    species: 'dwarf',
    level: 1,
    // The Poison resistance is read off the trait text with the other species resistances (sheet.ts).
    beforeSave: againstCondition('Dwarven Resilience', 'poisoned'),
  },
  {
    index: 'gnomish-cunning',
    name: 'Gnomish Cunning',
    species: 'gnome',
    level: 1,
    beforeSave: (ask) =>
      MENTAL_SAVES.includes(ask.ability)
        ? [{ advantage: 'advantage', note: 'Gnomish Cunning: Advantage on Intelligence, Wisdom and Charisma saves' }]
        : [],
  },
  {
    index: 'luck',
    name: 'Luck',
    species: 'halfling',
    level: 1,
    naturalOne: () => 'Halfling Luck',
  },
  {
    index: 'relentless-endurance',
    name: 'Relentless Endurance',
    species: 'orc',
    level: 1,
    // effects.ts applies it after damage, the way Relentless Rage is applied.
    resource: { key: RELENTLESS_ENDURANCE.resource, label: RELENTLESS_ENDURANCE.label, per: RELENTLESS_ENDURANCE.per, max: () => 1 },
  },
  {
    index: 'adrenaline-rush',
    name: 'Adrenaline Rush',
    species: 'orc',
    level: 1,
    resource: { key: 'adrenaline_rush', label: 'Adrenaline Rush', per: 'short', max: (sheet) => sheet.proficiency_bonus },
    action: (sheet) => ({
      id: 'adrenaline_rush',
      kind: 'bonus_action',
      name: 'Adrenaline Rush',
      hint: `Dash as a Bonus Action and gain ${sheet.proficiency_bonus} temporary hit points.`,
      cost: cost('adrenaline_rush'),
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'bonus_action',
      spend: cost('adrenaline_rush'),
      standard: ['dash'],
      temp_hp_amount: ask.sheet.proficiency_bonus,
      text: `${ask.actor.name} surges forward (Adrenaline Rush): a Dash, and ${ask.sheet.proficiency_bonus} temporary hit points.`,
    }),
  },
  ...(['acid', 'cold', 'fire', 'lightning', 'poison'] as const).map(breathWeapon),
  {
    index: 'draconic-flight',
    name: 'Draconic Flight',
    species: 'dragonborn',
    level: 5,
    dm_applied:
      'Flight is not on the grid yet: the Fly Speed equal to Speed, its 10 minutes and the wings vanishing when the Dragonborn is Incapacitated are yours to hold them to.',
    resource: { key: 'draconic_flight', label: 'Draconic Flight', per: 'long', max: () => 1 },
    action: (sheet) =>
      sheet.level >= 5
        ? {
            id: 'draconic_flight',
            kind: 'bonus_action',
            name: 'Draconic Flight',
            hint: `Spectral wings for 10 minutes: a Fly Speed equal to your Speed (${sheet.speed} ft). Once per Long Rest.`,
            cost: cost('draconic_flight'),
            targets: 'self',
          }
        : null,
    resolve: (ask) => ({
      economy: 'bonus_action',
      spend: cost('draconic_flight'),
      text: `Spectral wings sprout from ${ask.actor.name}'s back: a Fly Speed of ${ask.actor.speed} ft for 10 minutes (Draconic Flight).`,
    }),
  },
  {
    index: 'large-form',
    name: 'Large Form',
    species: 'goliath',
    level: 5,
    dm_applied: 'The token keeps its footprint: being Large (its space, its reach, what can grapple it) and ending the form early are yours to rule on.',
    resource: { key: 'large_form', label: 'Large Form', per: 'long', max: () => 1 },
    action: (sheet) =>
      sheet.level >= 5
        ? {
            id: 'large_form',
            kind: 'bonus_action',
            name: 'Large Form',
            hint: 'Become Large for 10 minutes: Advantage on Strength checks and 10 ft more Speed. Once per Long Rest.',
            cost: cost('large_form'),
            targets: 'self',
          }
        : null,
    resolve: (ask) => {
      if (ask.actor.flags.large_form) throw new Error(`${ask.actor.name} is in Large Form already: use another Bonus Action instead.`);
      return {
        economy: 'bonus_action',
        spend: cost('large_form'),
        flags: { large_form: { rounds_left: TEN_MINUTES } },
        movement_ft: LARGE_FORM_FT,
        text: `${ask.actor.name} grows to Large size for 10 minutes (Large Form): Advantage on Strength checks and ${LARGE_FORM_FT} ft more Speed.`,
      };
    },
    beforeCheck: (ask) =>
      ask.ability === 'str' && ask.actor.flags.large_form
        ? [{ advantage: 'advantage', note: 'Large Form: Advantage on Strength checks' }]
        : [],
    // The turn opens on the creature's own Speed, so the extra 10 ft is added back at each start.
    turnStart: (ask) =>
      ask.actor.flags.large_form && speedZeroBy(ask.actor.conditions).length === 0
        ? { economy: 'free', movement_ft: LARGE_FORM_FT, text: `Large Form: ${ask.actor.name} has ${LARGE_FORM_FT} ft more Speed.` }
        : null,
  },
  giantAncestry("Cloud's Jaunt", {
    dm_applied: "Teleportation is not on the grid yet: place the token yourself, up to 30 ft away in an unoccupied space the Goliath can see.",
    action: () => ({
      id: 'clouds_jaunt',
      kind: 'bonus_action',
      name: "Cloud's Jaunt",
      hint: 'Teleport up to 30 ft to an unoccupied space you can see, as a Bonus Action.',
      cost: cost(GIANT_ANCESTRY.resource),
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'bonus_action',
      spend: cost(GIANT_ANCESTRY.resource),
      text: `${ask.actor.name} vanishes in a gust and reappears up to 30 ft away (Cloud's Jaunt).`,
      dm_note: 'Move the token to the space the player names, up to 30 ft away; no movement is spent and nothing provokes.',
    }),
  }),
  declareOnHit('fires_burn', "Fire's Burn", 'the next attack roll that hits also deals 1d10 Fire damage.', (ask) => [
    {
      kind: 'damage',
      feature: "Fire's Burn",
      dice: '1d10',
      damage_type: 'fire',
      spend: cost(GIANT_ANCESTRY.resource),
      note: "Fire's Burn: 1d10 Fire damage.",
    },
  ]),
  declareOnHit(
    'frosts_chill',
    "Frost's Chill",
    'the next attack roll that hits also deals 1d6 Cold damage and takes 10 ft off its Speed until the start of your next turn.',
    (ask) => [
      {
        kind: 'damage',
        feature: "Frost's Chill",
        dice: '1d6',
        damage_type: 'cold',
        spend: cost(GIANT_ANCESTRY.resource),
        note: "Frost's Chill: 1d6 Cold damage.",
      },
      {
        kind: 'stance',
        feature: "Frost's Chill",
        on: 'target',
        flags: { slowed_by: { attacker_id: ask.actor.id, ft: 10 } },
        note: `Frost's Chill: ${ask.target.name}'s Speed is 10 ft lower until the start of ${ask.actor.name}'s next turn.`,
      },
    ],
  ),
  declareOnHit('hills_tumble', "Hill's Tumble", 'the next Large or smaller creature you hit with an attack roll falls Prone.', (ask) =>
    ask.target.size === 'H' || ask.target.size === 'G'
      ? []
      : [
          {
            kind: 'condition',
            feature: "Hill's Tumble",
            condition: 'prone',
            ends: 'manual',
            spend: cost(GIANT_ANCESTRY.resource),
            note: `Hill's Tumble: ${ask.target.name} is knocked Prone.`,
          },
        ],
  ),
  giantAncestry("Stone's Endurance", {
    action: () => ({
      id: 'stones_endurance',
      kind: 'reaction',
      name: "Stone's Endurance",
      hint: 'Declare it before the blow: the next attack that damages you takes 1d12 + your Constitution modifier off. The Reaction goes now, the use when it lands.',
      cost: cost(GIANT_ANCESTRY.resource),
      targets: 'self',
    }),
    resolve: (ask) => {
      requireUse(ask.sheet, GIANT_ANCESTRY.resource, ask.sheet.proficiency_bonus, "Stone's Endurance", GIANT_ANCESTRY.per);
      return {
        economy: 'reaction',
        flags: { stones_endurance_ready: true },
        text: `${ask.actor.name} sets like stone: the next attack that hurts them loses 1d12 + CON of its damage (Stone's Endurance).`,
      };
    },
    onDamageTaken: (ask) =>
      ask.actor.flags.stones_endurance_ready || ask.actor.reaction_used || isIncapacitated(ask.actor.conditions)
        ? null
        : usesLeft(ask.sheet, GIANT_ANCESTRY.resource, ask.sheet.proficiency_bonus) > 0
          ? {
              action: 'stones_endurance',
              name: "Stone's Endurance",
              hint: `${ask.actor.name} may take 1d12 + CON off the next attack that hurts them: use_action {action_name: "stones_endurance", out_of_turn: true} before that attack.`,
            }
          : null,
  }),
  giantAncestry("Storm's Thunder", {
    action: () => ({
      id: 'storms_thunder',
      kind: 'reaction',
      name: "Storm's Thunder",
      hint: `Declare it before the blow: the next creature within ${STORMS_THUNDER_FT} ft whose attack damages you takes 1d8 Thunder damage. The Reaction goes now, the use when it lands.`,
      cost: cost(GIANT_ANCESTRY.resource),
      targets: 'self',
    }),
    resolve: (ask) => {
      requireUse(ask.sheet, GIANT_ANCESTRY.resource, ask.sheet.proficiency_bonus, "Storm's Thunder", GIANT_ANCESTRY.per);
      return {
        economy: 'reaction',
        flags: { storms_thunder_ready: true },
        text: `Thunder gathers around ${ask.actor.name}: the next creature within ${STORMS_THUNDER_FT} ft that hurts them takes 1d8 Thunder (Storm's Thunder).`,
      };
    },
    onDamageTaken: (ask) =>
      ask.actor.flags.storms_thunder_ready || ask.actor.reaction_used || isIncapacitated(ask.actor.conditions)
        ? null
        : usesLeft(ask.sheet, GIANT_ANCESTRY.resource, ask.sheet.proficiency_bonus) > 0
          ? {
              action: 'storms_thunder',
              name: "Storm's Thunder",
              hint: `${ask.actor.name} may answer the next blow from within ${STORMS_THUNDER_FT} ft with 1d8 Thunder: use_action {action_name: "storms_thunder", out_of_turn: true} before that attack.`,
            }
          : null,
  }),
];

/** Every species trait the engine knows, keyed by its SRD trait index. */
export const SPECIES_TRAITS: Record<string, FeatureHandler> = Object.fromEntries(TRAITS.map((handler) => [handler.index, handler]));

const BY_NAME = new Map(TRAITS.map((handler) => [handler.name.toLowerCase(), handler]));

/** The trait families a lineage picks one of; the family is the name before the colon. */
const lineageFamily = (handler: FeatureHandler): string | null =>
  handler.name.startsWith('Breath Weapon: ') || handler.name.startsWith('Giant Ancestry: ') ? handler.name.split(':')[0]! : null;

/**
 * The SRD species traits a sheet holds, by name on its species rows. A row the DM wrote runs its own clauses
 * and never an SRD handler, and a sheet listing a whole lineage family never chose one, so none of it acts.
 */
export function speciesTraitsHeld(features: SheetFeature[]): Array<{ handler: FeatureHandler; feature: SheetFeature }> {
  const found = features.flatMap((feature) => {
    if (feature.source !== 'species' || feature.mechanics?.homebrew_id !== undefined || feature.clauses?.length) return [];
    // Wild Shape keeps no species trait: combatSheet marks these rows while a form is worn, in a fight or out of one.
    if (feature.wild_shape) return [];
    const handler = BY_NAME.get(feature.name.trim().toLowerCase());
    return handler ? [{ handler, feature }] : [];
  });
  const families = found.map(({ handler }) => lineageFamily(handler));
  return found.filter(({ handler }) => {
    const family = lineageFamily(handler);
    return family === null || families.filter((one) => one === family).length === 1;
  });
}
