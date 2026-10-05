// Deterministic heraldry for a living-world faction: a short blazon for the codex and an English
// emblem description for an image generator, both replayed from the world seed.
import type { Db } from '../db/connection.js';
import { mixSeed, rngPick, seededRng } from './dice.js';
import type { Government } from './governments.js';
import { factionFaith, getFaith } from './world-faith-store.js';
import { getWorldState, listFactions, type WorldFaction } from './world-store.js';

export type Tincture = 'gold' | 'silver' | 'red' | 'blue' | 'green' | 'black' | 'purple';

export interface Heraldry {
  field: Tincture;
  charge_tincture: Tincture;
  charge: string;
  blazon: string;
  emblem: string;
}

const TINCTURES: readonly Tincture[] = ['gold', 'silver', 'red', 'blue', 'green', 'black', 'purple'];
const METALS: readonly Tincture[] = ['gold', 'silver'];
const COLOURS: readonly Tincture[] = ['red', 'blue', 'green', 'black', 'purple'];

const REALM_CHARGES: Record<Government, readonly string[]> = {
  theocracy: ['radiant sun', 'mitre', 'crossed keys'],
  empire: ['double-headed eagle', 'imperial crown'],
  kingdom: ['lion rampant', 'crown', 'tower'],
  merchant_republic: ['ship', 'three coins'],
  free_city: ['city gate', 'tower'],
  league: ['clasped hands', 'three stars'],
  tribal_confederation: ['antlered stag', "wolf's head"],
};

/** The rough marks an outlaw band daubs instead of a noble charge. */
export const OUTLAW_CHARGES: readonly string[] = [
  'broken sword',
  'noose',
  'black hand',
  'crossed cudgels',
  'skull and crossbones',
];

const OTHER_CHARGES: Record<string, readonly string[]> = {
  house: ['boar', 'stag', 'griffin', 'hawk', 'bear', 'wyvern', 'oak tree', 'crescent moon', 'three roses', 'salmon'],
  church: ['radiant sun', 'eye within a triangle', 'crescent moon', 'flame', 'open hand', 'anvil'],
  guild: ['hammer and tongs', 'balance scales', 'ship', 'key', 'spindle', 'quill'],
  gang: ['dagger', 'skull', 'rat', 'broken chain', 'open hand'],
  bandits: OUTLAW_CHARGES,
  monsters: ['claw', 'beast skull', 'fanged maw', 'spiral'],
  off_map: ['star', 'sea serpent'],
};

const NO_ARTICLE = new Set(['crossed keys', 'clasped hands', 'hammer and tongs', 'balance scales']);
const NUMBER_WORD = /^(one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/;

/** How many consecutive re-rolls a faction may make before the untaken combination is chosen outright. */
const REROLL_LIMIT = 64;

function isMetal(tincture: Tincture): boolean {
  return tincture === 'gold' || tincture === 'silver';
}

/** The lower-case tincture-and-charge phrase a blazon and an emblem share, with its article. */
export function chargePhrase(tincture: Tincture, charge: string): string {
  const counted = NUMBER_WORD.exec(charge);
  if (counted) return `${counted[1]} ${tincture} ${counted[2]}`;
  if (NO_ARTICLE.has(charge)) return `${tincture} ${charge}`;
  return `a ${tincture} ${charge}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Two tinctures of the same class clash, so a charge is set in the other class from its field. */
function tincturesFor(field: Tincture): readonly Tincture[] {
  return isMetal(field) ? COLOURS : METALS;
}

function armsKey(field: Tincture, charge: string, charge_tincture: Tincture): string {
  return `${field}|${charge}|${charge_tincture}`;
}

interface RealmInfo {
  government: Government;
  kind: string | null;
}

/** A realm's government and kind, defaulting to a kingdom when the faction names no known realm. */
function realmInfo(db: Db, campaignId: number, faction: WorldFaction): RealmInfo {
  if (faction.realm_id === null) return { government: 'kingdom', kind: null };
  const row = db
    .prepare('SELECT government, kind FROM world_realm WHERE campaign_id = ? AND id = ?')
    .get(campaignId, faction.realm_id) as { government: string | null; kind: string | null } | undefined;
  const government = row?.government;
  return {
    government:
      government !== null && government !== undefined && government in REALM_CHARGES
        ? (government as Government)
        : 'kingdom',
    kind: row?.kind ?? null,
  };
}

/** The charges a faction may bear: a church its faith's symbol, a lordship no crown, outlaws their badge. */
function chargesFor(db: Db, campaignId: number, faction: WorldFaction): readonly string[] {
  if (faction.type === 'realm') {
    const info = realmInfo(db, campaignId, faction);
    const realmCharges = REALM_CHARGES[info.government];
    return info.kind === 'lordship' ? realmCharges.filter((charge) => charge !== 'crown') : realmCharges;
  }
  if (faction.type === 'church') {
    const faithId = factionFaith(db, campaignId, faction.id).faith_id;
    const faith = faithId !== null ? getFaith(db, campaignId, faithId) : undefined;
    if (faith) return [faith.symbol];
  }
  return OTHER_CHARGES[faction.type] ?? OTHER_CHARGES.off_map!;
}

function emblemFor(type: string, phrase: string, field: Tincture): string {
  switch (type) {
    case 'church':
      return `holy symbol medallion: ${phrase} on ${field} enamel`;
    case 'guild':
      return `guild seal: ${phrase} on a ${field} roundel`;
    case 'gang':
      return `crude painted gang sign: ${phrase} daubed over ${field} paint`;
    case 'bandits':
      return `rough outlaw badge: ${phrase} scratched onto ${field} cloth`;
    case 'monsters':
      return `tribal totem of bone and hide, marked with ${phrase} on ${field} hide`;
    case 'off_map':
      return `foreign banner: ${phrase} on a ${field} field`;
    default:
      return `heraldic coat of arms on a shield: ${phrase} on a ${field} field`;
  }
}

function buildHeraldry(type: string, field: Tincture, charge: string, charge_tincture: Tincture): Heraldry {
  const phrase = chargePhrase(charge_tincture, charge);
  return {
    field,
    charge_tincture,
    charge,
    blazon: `${capitalise(field)}, ${phrase}`,
    emblem: emblemFor(type, phrase, field),
  };
}

/** The first triple no earlier faction bears, scanned in a fixed order when repeated re-rolls keep colliding. */
function freeArms(
  type: string,
  charges: readonly string[],
  borrowed: Tincture | undefined,
  taken: ReadonlySet<string>,
): Heraldry {
  const fields = borrowed === undefined ? TINCTURES : [borrowed, ...TINCTURES];
  for (const field of fields) {
    const tinctures = tincturesFor(field);
    for (const charge of charges) {
      for (const charge_tincture of tinctures) {
        if (!taken.has(armsKey(field, charge, charge_tincture))) {
          return buildHeraldry(type, field, charge, charge_tincture);
        }
      }
    }
  }
  const field = borrowed ?? TINCTURES[0]!;
  return buildHeraldry(type, field, charges[0]!, tincturesFor(field)[0]!);
}

/** Rolls one faction's arms, re-rolling while the triple repeats an earlier faction's. */
function rollArms(
  db: Db,
  campaignId: number,
  faction: WorldFaction,
  seed: number,
  realmField: ReadonlyMap<number, Tincture>,
  taken: ReadonlySet<string>,
): Heraldry {
  const rng = seededRng(mixSeed(seed, faction.id, 1301));
  const charges = chargesFor(db, campaignId, faction);
  // A house borrows its realm's field, which is fixed before it is rolled, so only its charge varies.
  const borrowed =
    faction.type === 'house' && faction.realm_id !== null ? realmField.get(faction.realm_id) : undefined;
  for (let tries = 0; tries < REROLL_LIMIT; tries += 1) {
    const field = borrowed ?? rngPick(rng, TINCTURES);
    const charge = rngPick(rng, charges);
    const charge_tincture = rngPick(rng, tincturesFor(field));
    if (!taken.has(armsKey(field, charge, charge_tincture))) {
      return buildHeraldry(faction.type, field, charge, charge_tincture);
    }
  }
  return freeArms(faction.type, charges, borrowed, taken);
}

/**
 * Every faction's arms, in id order, each re-rolled when it would repeat an earlier triple. Resolving
 * in id order is what keeps an existing faction's arms fixed when a new one is added later.
 */
function computeArms(db: Db, campaignId: number, seed: number): Map<number, Heraldry> {
  const arms = new Map<number, Heraldry>();
  const realmField = new Map<number, Tincture>();
  const taken = new Set<string>();
  for (const faction of listFactions(db, campaignId, { includeEnded: true })) {
    const heraldry = rollArms(db, campaignId, faction, seed, realmField, taken);
    arms.set(faction.id, heraldry);
    taken.add(armsKey(heraldry.field, heraldry.charge, heraldry.charge_tincture));
    if (faction.type === 'realm' && faction.realm_id !== null) realmField.set(faction.realm_id, heraldry.field);
  }
  return arms;
}

/** A faction's heraldry from the world seed; null when the campaign has no world state yet. */
export function heraldryFor(db: Db, campaignId: number, faction: WorldFaction): Heraldry | null {
  const state = getWorldState(db, campaignId);
  if (!state) return null;
  return computeArms(db, campaignId, state.seed).get(faction.id) ?? null;
}
