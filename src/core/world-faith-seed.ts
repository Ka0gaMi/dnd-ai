// Seeds a living world's faiths: usually one region-wide faith with a church branch in each realm group,
// the odd realm holding its own, and each branch's influence. Every choice comes from the world seed.
import type { Db } from '../db/connection.js';
import { mixSeed, rngInt, seededRng } from './dice.js';
import { faithIdentity } from './faith-names.js';
import { ensurePolitics } from './politics-service.js';
import type { StoredPolitics } from './politics-store.js';
import { getRegion, type RegionView, type WorldPlace } from './region.js';
import {
  insertFaith,
  listFaiths,
  setFactionFaith,
  type FaithInfluence,
  type WorldFaith,
} from './world-faith-store.js';
import { currentGameDay, getWorldState, insertFaction, listFactions } from './world-store.js';

interface RealmInfo {
  id: number;
  government: string | null;
  capital_place_id: number | null;
  county_ids: number[];
  liege_realm_id: number | null;
}

interface FaithHead {
  realm_id: number | null;
  place_id: number | null;
}

/** The generator link's temple flag: the city has a temple building, nothing more. */
export function hasTemple(place: WorldPlace | undefined): boolean {
  if (!place || place.link === null || !URL.canParse(place.link)) return false;
  return new URL(place.link).searchParams.get('temple') === '1';
}

function capitalOf(realm: RealmInfo, placeById: Map<number, WorldPlace>): WorldPlace | undefined {
  return realm.capital_place_id !== null ? placeById.get(realm.capital_place_id) : undefined;
}

/** A theocracy's capital first, then the first temple-flagged capital, then the largest realm. */
function mainFaithHead(realms: RealmInfo[], placeById: Map<number, WorldPlace>): FaithHead {
  const theocracy = realms.find((realm) => realm.government === 'theocracy');
  if (theocracy) return { realm_id: theocracy.id, place_id: theocracy.capital_place_id };
  const temple = realms.find((realm) => hasTemple(capitalOf(realm, placeById)));
  if (temple) return { realm_id: temple.id, place_id: temple.capital_place_id };
  let largest: RealmInfo | undefined;
  for (const realm of realms) {
    if (!largest || realm.county_ids.length > largest.county_ids.length) largest = realm;
  }
  return largest ? { realm_id: largest.id, place_id: largest.capital_place_id } : { realm_id: null, place_id: null };
}

/** The settlements whose anchor hex or seat sits in one of the realm's counties. */
function realmSettlements(politics: StoredPolitics, view: RegionView, realmId: number): WorldPlace[] {
  const counties = politics.counties.filter((county) => county.realm_id === realmId);
  return view.places.filter(
    (place) =>
      place.kind === 'settlement' &&
      counties.some((county) => county.hexes.includes(place.hexes[0]) || county.seat_place_id === place.id),
  );
}

/** A temple is strong where its seat or at least half the settlements it serves keep a temple. */
function templeInfluence(
  rng: () => number,
  seat: WorldPlace | undefined,
  settlements: WorldPlace[],
): FaithInfluence {
  const templed = settlements.filter((place) => hasTemple(place)).length;
  const strong = hasTemple(seat) || (settlements.length > 0 && templed * 2 >= settlements.length);
  if (strong) return 'strong';
  return rng() < 0.2 ? 'strong' : 'minor';
}

/** Each sovereign realm followed by the vassals that answer to it, sovereigns in realm order. */
function realmGroups(realms: RealmInfo[]): RealmInfo[][] {
  const byId = new Map(realms.map((realm) => [realm.id, realm]));
  const groups = new Map<number, RealmInfo[]>();
  for (const realm of realms) {
    let root = realm;
    for (let hop = 0; hop < realms.length && root.liege_realm_id !== null; hop += 1) {
      root = byId.get(root.liege_realm_id) ?? root;
    }
    groups.set(root.id, [...(groups.get(root.id) ?? []), realm]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rootId, members]) => [byId.get(rootId)!, ...members.filter((member) => member.id !== rootId)]);
}

/** One church branch per faith in each realm group, seated at the capital of the first realm there holding it. */
function seedChurchBranches(
  db: Db,
  campaignId: number,
  context: { view: RegionView; politics: StoredPolitics; placeById: Map<number, WorldPlace>; today: number },
  realms: RealmInfo[],
  faithByRealm: Map<number, WorldFaith>,
  rng: () => number,
): void {
  for (const group of realmGroups(realms)) {
    const root = group[0]!;
    const faiths = [...new Set(group.map((realm) => faithByRealm.get(realm.id)))].filter(
      (faith): faith is WorldFaith => faith !== undefined,
    );
    for (const faith of faiths) {
      // A theocracy's crown is its own faith's church, so that faith takes no separate branch there.
      if (root.government === 'theocracy' && faithByRealm.get(root.id) === faith) continue;
      const holders = group.filter((realm) => faithByRealm.get(realm.id) === faith);
      const seatRealm = holders.find((realm) => realm.capital_place_id !== null) ?? holders[0]!;
      const seat = capitalOf(seatRealm, context.placeById);
      const settlements = holders.flatMap((realm) => realmSettlements(context.politics, context.view, realm.id));
      const temple = insertFaction(db, campaignId, {
        name: `Temple of ${seat?.name ?? context.view.name}`,
        type: 'church',
        realm_id: seatRealm.id,
        county_id: null,
        place_id: seat?.id ?? null,
        secrecy: 'open',
        resources: 3,
        capacities: {},
        created_day: context.today,
      });
      setFactionFaith(db, campaignId, temple.id, faith.id, templeInfluence(rng, seat, settlements));
    }
  }
}

/** One realm's own faith, re-rolled while its name clashes; null when it falls back to the main one. */
function ownFaith(
  db: Db,
  campaignId: number,
  realm: RealmInfo,
  today: number,
  names: Set<string>,
  rng: () => number,
): WorldFaith | null {
  let candidate = faithIdentity(rng);
  for (let attempt = 0; attempt < 5 && names.has(candidate.name); attempt += 1) {
    candidate = faithIdentity(rng);
  }
  if (names.has(candidate.name)) return null;

  const faith = insertFaith(db, campaignId, {
    name: candidate.name,
    aspect: candidate.aspect,
    symbol: candidate.symbol,
    head_place_id: realm.capital_place_id,
    fervor: rngInt(rng, 45, 65),
    heresy_of: null,
    last_heresy_day: null,
    created_day: today,
  });
  names.add(faith.name);
  return faith;
}

/**
 * Seeds the world's faiths and their links once; later calls are a no-op returning zero. A new world
 * also gets its church branches, while a world seeded before faiths only links the temples it has.
 */
export function ensureFaiths(db: Db, campaignId: number, seedChurches = false): number {
  const state = getWorldState(db, campaignId);
  if (!state) return 0;
  if (listFaiths(db, campaignId).length > 0) return 0;

  const view = getRegion(db, campaignId);
  const politics = ensurePolitics(db, campaignId);
  if (!view || !politics) return 0;

  return db.transaction(() => {
    const rng = seededRng(mixSeed(state.seed, 7717));
    const today = currentGameDay(db, campaignId);
    const placeById = new Map(view.places.map((place) => [place.id, place]));
    const governmentRows = db
      .prepare('SELECT id, government FROM world_realm WHERE campaign_id = ?')
      .all(campaignId) as Array<{ id: number; government: string | null }>;
    const governmentById = new Map(governmentRows.map((row) => [row.id, row.government]));
    const realms: RealmInfo[] = politics.realms.map((realm) => ({
      id: realm.id,
      government: governmentById.get(realm.id) ?? null,
      capital_place_id: realm.capital_place_id,
      county_ids: realm.county_ids,
      liege_realm_id: realm.liege_realm_id,
    }));

    const identity = faithIdentity(rng);
    const head = mainFaithHead(realms, placeById);
    const main = insertFaith(db, campaignId, {
      name: identity.name,
      aspect: identity.aspect,
      symbol: identity.symbol,
      head_place_id: head.place_id,
      fervor: rngInt(rng, 45, 65),
      heresy_of: null,
      last_heresy_day: null,
      created_day: today,
    });
    let created = 1;

    const names = new Set([main.name]);
    const faithByRealm = new Map<number, WorldFaith>();
    for (const realm of realms) {
      if (realm.id === head.realm_id) {
        faithByRealm.set(realm.id, main);
        continue;
      }
      let faith = main;
      if (realms.length >= 2 && rng() < 0.25) {
        const own = ownFaith(db, campaignId, realm, today, names, rng);
        if (own) {
          faith = own;
          created += 1;
        }
      }
      faithByRealm.set(realm.id, faith);
    }

    const factions = listFactions(db, campaignId);
    for (const realm of realms) {
      const faith = faithByRealm.get(realm.id);
      if (!faith) continue;
      if (realm.government === 'theocracy') {
        const crown = factions.find((faction) => faction.type === 'realm' && faction.realm_id === realm.id);
        if (crown) setFactionFaith(db, campaignId, crown.id, faith.id, 'dominant');
      }
      for (const temple of factions.filter((faction) => faction.type === 'church' && faction.realm_id === realm.id)) {
        const settlements = realmSettlements(politics, view, realm.id);
        const influence = templeInfluence(rng, capitalOf(realm, placeById), settlements);
        setFactionFaith(db, campaignId, temple.id, faith.id, influence);
      }
      db.prepare('UPDATE world_realm SET faith = ? WHERE id = ? AND campaign_id = ?').run(faith.name, realm.id, campaignId);
    }
    if (seedChurches) {
      seedChurchBranches(db, campaignId, { view, politics, placeById, today }, realms, faithByRealm, rng);
    }

    return created;
  })();
}
