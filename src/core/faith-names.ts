// Procedural faith identities for the living world. SRD 5.2.1 names no pantheon, so each faith is a
// generic aspect, a deity title, a heraldic charge and one of that aspect's name forms.
import { rngPick } from './dice.js';

export interface FaithIdentity {
  name: string;
  aspect: string;
  symbol: string;
  deity: string;
}

export const FAITH_ASPECTS: readonly {
  aspect: string;
  deity: string;
  symbol: string;
  nameForms: readonly string[];
}[] = [
  {
    aspect: 'sun',
    deity: 'the Dawnfather',
    symbol: 'radiant sun',
    nameForms: ['the Faith of {deity}', 'the Church of {deity}', 'the Order of the Radiant Dawn'],
  },
  {
    aspect: 'moon',
    deity: 'the Silver Lady',
    symbol: 'crescent moon',
    nameForms: ['the Faith of {deity}', 'the Church of {deity}', 'the Children of {deity}'],
  },
  {
    aspect: 'hearth',
    deity: 'the Hearthmother',
    symbol: 'flame',
    nameForms: ['the Faith of {deity}', 'the Children of {deity}', 'the Hearthfire Covenant'],
  },
  {
    aspect: 'grave',
    deity: 'the Grey Warden',
    symbol: 'hourglass',
    nameForms: ['the Faith of {deity}', 'the Order of {deity}', 'the Grey Pilgrimage'],
  },
  {
    aspect: 'storm',
    deity: 'the Stormlord',
    symbol: 'lightning bolt',
    nameForms: ['the Faith of {deity}', 'the Church of {deity}', 'the Thunder Choir'],
  },
  {
    aspect: 'forge',
    deity: 'the Maker',
    symbol: 'anvil',
    nameForms: ['the Faith of {deity}', 'the Order of {deity}', 'the Forge Covenant'],
  },
  {
    aspect: 'harvest',
    deity: 'the Green Mother',
    symbol: 'sheaf of wheat',
    nameForms: ['the Faith of {deity}', 'the Children of {deity}', 'the Harvest Rite'],
  },
  {
    aspect: 'sea',
    deity: 'the Deep Father',
    symbol: 'trident',
    nameForms: ['the Faith of {deity}', 'the Church of {deity}', 'the Tidebound Fellowship'],
  },
  {
    aspect: 'justice',
    deity: 'the Just One',
    symbol: 'balance scales',
    nameForms: ['the Faith of {deity}', 'the Order of {deity}', 'the Tribunal of the Just'],
  },
  {
    aspect: 'stars',
    deity: 'the Watcher in the Stars',
    symbol: 'eight-pointed star',
    nameForms: ['the Faith of {deity}', 'the Church of {deity}', 'the Vigil of the Stars'],
  },
];

/** One aspect-flavoured adjective for a breakaway movement's name. */
const HERESY_EPITHETS: Record<string, string> = {
  sun: 'Dawn',
  moon: 'Silver',
  hearth: 'Hearth',
  grave: 'Grey',
  storm: 'Storm',
  forge: 'Forged',
  harvest: 'Green',
  sea: 'Deep',
  justice: 'Just',
  stars: 'Vigilant',
};

const HERESY_FORMS: readonly string[] = [
  'the Reformed {parentShort}',
  'the True {parentShort}',
  'the Penitents of {deity}',
  'the {epithet} Dissenters',
  'the {parentShort} Reborn',
];

/** A parent's name without its leading article or Faith-of/Church-of prefix, where sensible. */
function shortName(name: string): string {
  return name
    .replace(/^the\s+/i, '')
    .replace(/^(?:Faith|Church) of\s+/i, '')
    .replace(/^the\s+/i, '')
    .trim();
}

function deityFor(aspect: string): string {
  return FAITH_ASPECTS.find((entry) => entry.aspect === aspect)?.deity ?? 'the Hidden One';
}

/** A faith identity from the generator: pick an aspect, then one of its name forms. */
export function faithIdentity(rng: () => number): FaithIdentity {
  const chosen = rngPick(rng, FAITH_ASPECTS);
  const name = rngPick(rng, chosen.nameForms).replace('{deity}', chosen.deity);
  return { name, aspect: chosen.aspect, symbol: chosen.symbol, deity: chosen.deity };
}

/** A reforming or dissenting movement derived from its parent, never equal to the parent's name. */
export function heresyName(
  parent: FaithIdentity | { name: string; aspect: string },
  rng: () => number,
): string {
  const parentShort = shortName(parent.name);
  const deity = deityFor(parent.aspect);
  const epithet = HERESY_EPITHETS[parent.aspect] ?? 'Hidden';
  const candidates = HERESY_FORMS.map((form) =>
    form.replace('{parentShort}', parentShort).replace('{deity}', deity).replace('{epithet}', epithet),
  ).filter((name) => name !== parent.name);
  return rngPick(rng, candidates);
}
