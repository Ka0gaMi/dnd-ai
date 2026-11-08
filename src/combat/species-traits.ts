// The 2024 species traits as engine mechanics: one handler per SRD trait index, held through a species row.
// They plug into the same hooks as the class features, so an action trait adds `action`, `resolve` and `resource`.
import type { Ability } from '../core/rules.js';
import type { FeatureHandler, RollSource, SaveAsk } from './features.js';

/** The use Relentless Endurance spends, which a Long Rest gives back. */
export const RELENTLESS_ENDURANCE = { resource: 'relentless_endurance', label: 'Relentless Endurance', per: 'long' as const };

const MENTAL_SAVES: Ability[] = ['int', 'wis', 'cha'];

/** Advantage on the saves made to avoid or end one condition, as Brave, Fey Ancestry and Dwarven Resilience give. */
const againstCondition =
  (trait: string, condition: string) =>
  (ask: SaveAsk): RollSource[] =>
    ask.against?.includes(condition)
      ? [{ advantage: 'advantage', note: `${trait}: Advantage on a save against being ${condition}` }]
      : [];

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
];

/** Every species trait the engine knows, keyed by its SRD trait index. */
export const SPECIES_TRAITS: Record<string, FeatureHandler> = Object.fromEntries(TRAITS.map((handler) => [handler.index, handler]));

const BY_NAME = new Map(TRAITS.map((handler) => [handler.name.toLowerCase(), handler]));

/** The handler behind a species row, by the trait name the row carries. */
export const speciesTraitNamed = (name: string): FeatureHandler | undefined => BY_NAME.get(name.trim().toLowerCase());
