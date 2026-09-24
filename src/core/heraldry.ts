// Deterministic heraldry for a living-world faction: a short blazon for the codex and an English
// emblem description for an image generator, both replayed from the world seed.
import type { Db } from '../db/connection.js';
import { mixSeed, rngPick, seededRng } from './dice.js';
import type { Government } from './governments.js';
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

const OTHER_CHARGES: Record<string, readonly string[]> = {
  house: ['boar', 'stag', 'griffin', 'hawk', 'bear', 'wyvern', 'oak tree', 'crescent moon', 'three roses', 'salmon'],
  church: ['radiant sun', 'eye within a triangle', 'crescent moon', 'flame', 'open hand', 'anvil'],
  guild: ['hammer and tongs', 'balance scales', 'ship', 'key', 'spindle', 'quill'],
  gang: ['dagger', 'skull', 'rat', 'broken chain', 'open hand'],
  monsters: ['claw', 'beast skull', 'fanged maw', 'spiral'],
  off_map: ['star', 'sea serpent'],
};

const NO_ARTICLE = new Set(['crossed keys', 'clasped hands', 'hammer and tongs', 'balance scales']);
const NUMBER_WORD = /^(one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/;

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

/** The government of the realm a faction belongs to, defaulting to a kingdom when it is unknown. */
function realmGovernment(db: Db, campaignId: number, faction: WorldFaction): Government {
  if (faction.realm_id === null) return 'kingdom';
  const row = db
    .prepare('SELECT government FROM world_realm WHERE campaign_id = ? AND id = ?')
    .get(campaignId, faction.realm_id) as { government: string | null } | undefined;
  const government = row?.government;
  return government !== null && government !== undefined && government in REALM_CHARGES
    ? (government as Government)
    : 'kingdom';
}

function chargesFor(db: Db, campaignId: number, faction: WorldFaction): readonly string[] {
  if (faction.type === 'realm') return REALM_CHARGES[realmGovernment(db, campaignId, faction)];
  return OTHER_CHARGES[faction.type] ?? OTHER_CHARGES.off_map!;
}

/** The field a house borrows from its realm's faction, or null when no such realm exists. */
function realmField(db: Db, campaignId: number, faction: WorldFaction): Tincture | null {
  if (faction.type !== 'house' || faction.realm_id === null) return null;
  const realm = listFactions(db, campaignId).find(
    (other) => other.type === 'realm' && other.realm_id === faction.realm_id,
  );
  return realm ? (heraldryFor(db, campaignId, realm)?.field ?? null) : null;
}

function emblemFor(type: string, phrase: string, field: Tincture): string {
  switch (type) {
    case 'church':
      return `holy symbol medallion: ${phrase} on ${field} enamel`;
    case 'guild':
      return `guild seal: ${phrase} on a ${field} roundel`;
    case 'gang':
      return `crude painted gang sign: ${phrase} daubed over ${field} paint`;
    case 'monsters':
      return `tribal totem of bone and hide, marked with ${phrase} on ${field} hide`;
    case 'off_map':
      return `foreign banner: ${phrase} on a ${field} field`;
    default:
      return `heraldic coat of arms on a shield: ${phrase} on a ${field} field`;
  }
}

/** A faction's heraldry from the world seed; null when the campaign has no world state yet. */
export function heraldryFor(db: Db, campaignId: number, faction: WorldFaction): Heraldry | null {
  const state = getWorldState(db, campaignId);
  if (!state) return null;

  const rng = seededRng(mixSeed(state.seed, faction.id, 1301));
  const field = realmField(db, campaignId, faction) ?? rngPick(rng, TINCTURES);
  const charge = rngPick(rng, chargesFor(db, campaignId, faction));
  const charge_tincture = rngPick(rng, isMetal(field) ? COLOURS : METALS);
  const phrase = chargePhrase(charge_tincture, charge);

  return {
    field,
    charge_tincture,
    charge,
    blazon: `${capitalise(field)}, ${phrase}`,
    emblem: emblemFor(faction.type, phrase, field),
  };
}
