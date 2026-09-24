// Procedural people for the living world: personal names by sex and culture, noble house names,
// traits and epithets. Every part is an invented syllable, so no real-world or published name leaks in.
import { rngInt, rngPick } from './dice.js';

export type Culture = 'highland' | 'lowland' | 'coastal' | 'tribal';

/** Where a realm's people sound like they come from: a tribe, a coast, the highlands or the lowlands. */
export function cultureFor(
  tags: string[],
  terrain: string | null,
  coastal: boolean,
  kind: 'kingdom' | 'free_city' | 'lordship' | 'tribe',
): Culture {
  if (kind === 'tribe') return 'tribal';
  if (coastal) return 'coastal';
  if (tags.includes('highland') || (terrain !== null && HIGHLAND_TERRAIN.has(terrain))) return 'highland';
  return 'lowland';
}

const HIGHLAND_TERRAIN = new Set(['mountain', 'rocks', 'forest-dark']);

interface NameForms {
  onsets: readonly string[];
  middles: readonly string[];
  maleEnds: readonly string[];
  femaleEnds: readonly string[];
}

interface HouseForms {
  stems: readonly string[];
  suffixes: readonly string[];
}

const HIGHLAND_NAMES: NameForms = {
  onsets: ['Bral', 'Cael', 'Dun', 'Eir', 'Fen', 'Gair', 'Hal', 'Inn', 'Kerr', 'Lom', 'Mael', 'Nar', 'Oss', 'Rhu', 'Sgath', 'Tav', 'Ull', 'Vael', 'Wyn', 'Yor', 'Ard', 'Cad', 'Dol', 'Esk', 'Glen', 'Ith'],
  middles: ['a', 'e', 'i', 'o', 'u', 'an', 'en', 'in', 'on', 'ar', 'er', 'ir', 'or', 'al', 'el', 'il', 'ol', 'ach', 'ech', 'ich', 'och', 'ann', 'enn', 'inn', 'onn'],
  maleEnds: ['ric', 'dan', 'gar', 'mar', 'thas', 'wyr', 'vyn', 'dral', 'grim', 'wald', 'mund', 'bert', 'can', 'dyn', 'fyr', 'gal', 'harn', 'kell', 'lor', 'mon', 'nar', 'reth', 'tar', 'ven', 'wick'],
  femaleEnds: ['wen', 'lyn', 'wyn', 'gwen', 'neth', 'ril', 'sar', 'tin', 'vel', 'ash', 'el', 'ild', 'un', 'ys', 'dell', 'mir', 'nor', 'rith', 'beth', 'sai', 'morn', 'gail', 'mell', 'eth'],
};

const LOWLAND_NAMES: NameForms = {
  onsets: ['Ald', 'Bel', 'Cor', 'Dev', 'Eld', 'Fen', 'Hal', 'Iv', 'Lan', 'Mor', 'Nor', 'Orl', 'Pell', 'Rho', 'Sel', 'Tor', 'Val', 'Wes', 'Bram', 'Ced', 'Dorn', 'Wan', 'Irl', 'Gale', 'Holt', 'Jor'],
  middles: ['a', 'e', 'i', 'o', 'u', 'an', 'en', 'in', 'on', 'ar', 'er', 'ir', 'or', 'al', 'el', 'il', 'ol', 'is', 'es', 'os', 'am', 'em', 'im', 'om', 'ad'],
  maleEnds: ['ric', 'ard', 'don', 'mar', 'ton', 'vin', 'lan', 'dan', 'frey', 'mond', 'bert', 'gar', 'lin', 'den', 'sel', 'wick', 'ham', 'ley', 'ford', 'ston', 'mer', 'nor', 'tas', 'ver', 'rin'],
  femaleEnds: ['lyn', 'wyn', 'in', 'el', 'ell', 'an', 'en', 'ette', 'ine', 'a', 'i', 'o', 'na', 'ne', 'ra', 'sa', 'ta', 'la', 'ma', 'ys', 'eth', 'il'],
};

const COASTAL_NAMES: NameForms = {
  onsets: ['Mar', 'Sel', 'Cor', 'Thal', 'Brin', 'Cove', 'Dune', 'Ebb', 'Firth', 'Gale', 'Hav', 'Isle', 'Kelp', 'Lir', 'Mist', 'Ner', 'Pearl', 'Reef', 'Shoal', 'Tide', 'Vane', 'Wave', 'Wyn', 'Zeph', 'Brine', 'Corl'],
  middles: ['a', 'e', 'i', 'o', 'u', 'an', 'en', 'in', 'on', 'ar', 'er', 'ir', 'or', 'al', 'el', 'il', 'ol', 'ys', 'is', 'es', 'os', 'as', 'em', 'om', 'im'],
  maleEnds: ['ric', 'dan', 'mar', 'thal', 'wyr', 'vyn', 'dral', 'mund', 'can', 'dyn', 'gal', 'lor', 'mon', 'nar', 'tar', 'ven', 'wick', 'ston', 'mer', 'kell', 'sail', 'tide', 'reef', 'cove', 'bay'],
  femaleEnds: ['wen', 'lyn', 'wyn', 'neth', 'ril', 'sar', 'tin', 'vel', 'ash', 'el', 'ild', 'un', 'ys', 'dell', 'mir', 'nor', 'rith', 'beth', 'sai', 'morn', 'gail', 'mell', 'eth', 'sha', 'ka'],
};

const TRIBAL_NAMES: NameForms = {
  onsets: ['Ash', 'Bear', 'Bran', 'Crow', 'Dun', 'Elk', 'Fen', 'Flint', 'Fox', 'Gor', 'Hawk', 'Stag', 'Kor', 'Lynx', 'Moss', 'Oak', 'Rav', 'Reed', 'Stone', 'Thorn', 'Vale', 'Wolf', 'Wren', 'Yew', 'Brack', 'Sage'],
  middles: ['a', 'e', 'i', 'o', 'u', 'an', 'en', 'in', 'on', 'ar', 'er', 'ir', 'or', 'al', 'el', 'il', 'ol', 'ak', 'ek', 'ik', 'ok', 'uk', 'am', 'um', 'un'],
  maleEnds: ['run', 'gar', 'tak', 'dor', 'mar', 'nak', 'rek', 'gorn', 'vak', 'dal', 'rin', 'kar', 'tuk', 'nor', 'gash', 'drek', 'vun', 'tar', 'kad', 'morn', 'sul', 'bek', 'gan', 'oth', 'urn'],
  femaleEnds: ['ra', 'sha', 'ka', 'na', 'ta', 'ma', 'sa', 'la', 'ya', 'wen', 'lyn', 'in', 'el', 'ell', 'an', 'en', 'ette', 'ine', 'a', 'i', 'o', 'ys', 'eth', 'il', 'un'],
};

const NAMES: Record<Culture, NameForms> = {
  highland: HIGHLAND_NAMES,
  lowland: LOWLAND_NAMES,
  coastal: COASTAL_NAMES,
  tribal: TRIBAL_NAMES,
};

/** Tribal given names may be a two-root compound ("Ash-Eye") or an ordinary syllable name. */
const TRIBAL_ROOTS: readonly string[] = ['Ash', 'Bear', 'Eye', 'Wolf', 'Stone', 'Rav', 'Flint', 'Storm', 'Stag', 'Fox', 'Elk', 'Crow', 'Owl', 'Hawk', 'Bull', 'Fern', 'Elm', 'Birch', 'Moss', 'Reed', 'Sage', 'Thorn', 'Vale', 'Wren', 'Lynx', 'Hound'];

const CLAN_TAILS: readonly string[] = ['claw', 'heart', 'fang', 'wood', 'stone', 'foot', 'eye', 'mane', 'hide', 'wind', 'shadow', 'spear', 'shield', 'walker', 'hunter', 'fire', 'water', 'root', 'song', 'cry'];

const HIGHLAND_HOUSES: HouseForms = {
  stems: ['Venn', 'Thorn', 'Bral', 'Cael', 'Dun', 'Gair', 'Kerr', 'Mael', 'Nar', 'Oss', 'Rhu', 'Tav', 'Ull', 'Vael', 'Wyn', 'Yor', 'Ash', 'Black', 'Grey', 'Marrow', 'Raven', 'Stone', 'Wolf', 'Frost'],
  suffixes: ['ford', 'wind', 'mere', 'hall', 'vale', 'crest', 'moor', 'fell', 'crag', 'burn', 'stead', 'wick', 'dale', 'garth', 'march', 'ridge', 'holm', 'thorpe', 'shaw', 'bourne'],
};

const LOWLAND_HOUSES: HouseForms = {
  stems: ['Ald', 'Bel', 'Cor', 'Dev', 'Eld', 'Fen', 'Hal', 'Iver', 'Lan', 'Mor', 'Nor', 'Orl', 'Pell', 'Rho', 'Sel', 'Tor', 'Val', 'Wes', 'Bram', 'Ced', 'Dorn', 'Ewan', 'Gale', 'Holt'],
  suffixes: ['ton', 'bury', 'field', 'gate', 'worth', 'mont', 'ford', 'ley', 'ham', 'wick', 'dale', 'stead', 'moor', 'brook', 'combe', 'ridge', 'marsh', 'well', 'grove', 'court'],
};

const COASTAL_HOUSES: HouseForms = {
  stems: ['Mar', 'Sel', 'Cor', 'Thal', 'Brin', 'Cove', 'Dune', 'Ebb', 'Firth', 'Gale', 'Harbor', 'Isle', 'Kelp', 'Lir', 'Mist', 'Ner', 'Pearl', 'Reef', 'Shoal', 'Tide', 'Vane', 'Wave', 'Wyn', 'Zeph'],
  suffixes: ['port', 'haven', 'shore', 'reach', 'sound', 'strand', 'bay', 'cove', 'tide', 'moor', 'cliff', 'sand', 'helm', 'keel', 'sail', 'wake', 'fleet', 'bank', 'rowe', 'sea'],
};

const HOUSES: Record<Exclude<Culture, 'tribal'>, HouseForms> = {
  highland: HIGHLAND_HOUSES,
  lowland: LOWLAND_HOUSES,
  coastal: COASTAL_HOUSES,
};

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Onset plus end gives two syllables; an inserted middle makes three. */
function buildName(rng: () => number, forms: NameForms, sex: 'male' | 'female'): string {
  const onset = rngPick(rng, forms.onsets);
  const end = rngPick(rng, sex === 'male' ? forms.maleEnds : forms.femaleEnds);
  if (rngInt(rng, 0, 1) === 0) return capitalise(onset + end);
  return capitalise(onset + rngPick(rng, forms.middles) + end);
}

function compoundName(rng: () => number): string {
  const first = rngPick(rng, TRIBAL_ROOTS);
  let second = rngPick(rng, TRIBAL_ROOTS);
  while (second === first) second = rngPick(rng, TRIBAL_ROOTS);
  return `${capitalise(first)}-${capitalise(second)}`;
}

/** A personal name in the culture's own syllables, deterministic for the generator. */
export function personName(rng: () => number, sex: 'male' | 'female', culture: Culture): string {
  if (culture === 'tribal') {
    if (rngInt(rng, 0, 2) === 0) return compoundName(rng);
    return buildName(rng, TRIBAL_NAMES, sex);
  }
  return buildName(rng, NAMES[culture], sex);
}

/** A noble house name ("Venn", "Ashford", "Marrowind"); a tribe gets a clan name ("Bearclaw"). */
export function houseName(rng: () => number, culture: Culture): string {
  if (culture === 'tribal') return capitalise(rngPick(rng, TRIBAL_ROOTS)) + rngPick(rng, CLAN_TAILS);
  const forms = HOUSES[culture];
  const stem = capitalise(rngPick(rng, forms.stems));
  return rngInt(rng, 0, 2) === 0 ? stem : stem + rngPick(rng, forms.suffixes);
}

export const TRAITS: readonly string[] = [
  'pious', 'ailing', 'bold', 'cruel', 'just', 'ambitious', 'craven', 'wise',
  'greedy', 'gentle', 'proud', 'cunning', 'zealous', 'drunkard', 'honourable', 'paranoid',
];

/** Pairs that cannot sit on the same person; cruel opposes both the gentle and the just. */
const OPPOSING_PAIRS: readonly (readonly [string, string])[] = [
  ['bold', 'craven'],
  ['cruel', 'gentle'],
  ['just', 'cruel'],
  ['honourable', 'cunning'],
];

function opposes(a: string, b: string): boolean {
  return OPPOSING_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** One or two distinct traits, never two sides of an opposing pair. */
export function pickTraits(rng: () => number, count: 1 | 2): string[] {
  const chosen: string[] = [];
  while (chosen.length < count) {
    const trait = rngPick(rng, TRAITS);
    if (chosen.includes(trait) || chosen.some((other) => opposes(other, trait))) continue;
    chosen.push(trait);
  }
  return chosen;
}

const TRAIT_EPITHETS: Record<string, string> = {
  pious: 'the Pious', ailing: 'the Ailing', bold: 'the Bold', cruel: 'the Cruel',
  just: 'the Just', ambitious: 'the Ambitious', craven: 'the Craven', wise: 'the Wise',
  greedy: 'the Greedy', gentle: 'the Gentle', proud: 'the Proud', cunning: 'the Cunning',
  zealous: 'the Zealous', drunkard: 'the Drunkard', honourable: 'the Honourable', paranoid: 'the Paranoid',
};

const NEUTRAL_EPITHETS: readonly string[] = ['the Elder', 'the Quiet', 'the Younger', 'the Wanderer', 'the Nameless', 'the Steadfast', 'the Grey', 'the Unmarked'];

/** The byname a trait earns ("the Bold"), or a neutral one when no trait maps. */
export function epithetFor(traits: string[], rng: () => number): string {
  const mapped = traits.filter((trait) => TRAIT_EPITHETS[trait] !== undefined);
  if (mapped.length === 0) return rngPick(rng, NEUTRAL_EPITHETS);
  return TRAIT_EPITHETS[rngPick(rng, mapped)]!;
}
