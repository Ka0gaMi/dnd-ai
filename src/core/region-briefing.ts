// The briefing's region block: the map the DM sets the story in, where the party stands on it and the
// dangers only the DM knows. Empty without a region, and the player's window never reads it.
import { governmentLabel } from './governments.js';
import type { Db } from '../db/connection.js';
import { matchPlace } from './place-match.js';
import { ensurePolitics } from './politics-service.js';
import type { StoredCounty, StoredPolitics, StoredRealm } from './politics-store.js';
import { getRegion, type RegionView, type WorldPlace, type WorldRoute } from './region.js';
import { hexDistance, MILES_PER_HEX, nearbyPlaces, parseHex, placeDistance } from './region-graph.js';
import { estimateTokens, REGION_BRIEFING } from './token-budget.js';
import { borderingCountyIds } from './world-seed.js';

const SETTLEMENT_LIMIT = 15;
const AREA_LIMIT = 15;
const ROAD_LIMIT = 10;
const SEA_LIMIT = 5;
const DANGER_LIMIT = 8;
const NEARBY_LIMIT = 8;
const REALM_LIMIT = 6;
const COUNTY_LIMIT = 12;
/** The briefing's lists shrink in this many steps, farthest entries first, once distant realms are one line each. */
const TRIM_STEPS = 10;

/** The tail of a cut list: its own bullet, or a comma-separated addition for an inline list. */
function cutTail(count: number, limit: number, prefix: string): string | null {
  return count > limit ? `${prefix}… and ${count - limit} more` : null;
}

/** Hex distance from the party's place to the nearest of `hexes`; zero for everything when the party is nowhere. */
function distanceFrom(party: WorldPlace | null): (hexes: string[]) => number {
  if (!party) return () => 0;
  const from = party.hexes.map(parseHex);
  return (hexes) => {
    let best = Infinity;
    for (const hex of hexes) {
      const to = parseHex(hex);
      for (const start of from) best = Math.min(best, hexDistance(start, to));
    }
    return best;
  };
}

/** Items nearest first, ties keeping their stored order. */
function nearestFirst<T>(items: T[], distance: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, distance: distance(item) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map((entry) => entry.item);
}

/** Realms from the party outwards: the one holding its place (else the nearest), those bordering it, then the rest. */
function realmFocus(
  politics: StoredPolitics,
  party: WorldPlace | null,
  countyDistance: (county: StoredCounty) => number,
): { realms: StoredRealm[]; near: number } {
  if (!party) return { realms: politics.realms, near: politics.realms.length };
  const territoryOf = (realm: StoredRealm): StoredCounty[] =>
    politics.counties.filter((county) => county.realm_id === realm.id);
  const sorted = nearestFirst(politics.realms, (realm) =>
    Math.min(Infinity, ...territoryOf(realm).map(countyDistance)),
  );

  const anchor = party.hexes[0];
  const holder =
    politics.counties.find((county) => (county.claim_hexes ?? county.hexes).includes(anchor)) ??
    politics.counties.find((county) => county.seat_place_id === party.id);
  const home = sorted.find((realm) => realm.id === holder?.realm_id) ?? sorted[0];
  if (!home) return { realms: sorted, near: 0 };

  const realmOf = new Map(politics.counties.map((county) => [county.id, county.realm_id]));
  const bordering = new Set([...borderingCountyIds(politics, territoryOf(home))].map((id) => realmOf.get(id)));
  const neighbours = sorted.filter((realm) => realm !== home && bordering.has(realm.id));
  const distant = sorted.filter((realm) => realm !== home && !bordering.has(realm.id));
  return { realms: [home, ...neighbours, ...distant], near: 1 + neighbours.length };
}

/** The county holding a place's anchor hex, or, for a settlement, the one seated there. */
function countyFor(politics: StoredPolitics | null, place: WorldPlace): StoredCounty | undefined {
  if (!politics) return undefined;
  return (
    politics.counties.find((entry) => entry.hexes.includes(place.hexes[0])) ??
    (place.kind === 'settlement' ? politics.counties.find((entry) => entry.seat_place_id === place.id) : undefined)
  );
}

/** The duchy a county belongs to, for the settlement lines that name it. */
function duchyNameOf(politics: StoredPolitics, county: StoredCounty | undefined): string | null {
  if (!county || county.duchy_id === null) return null;
  return politics.duchies.find((entry) => entry.id === county.duchy_id)?.name ?? null;
}

/** A realm's descriptor: the living world's government once assigned, else its map kind. */
function realmDescriptor(realm: StoredRealm): string {
  return governmentLabel(realm.government ?? realm.kind);
}

/** Centres the hierarchy on the party for the briefing; the region tool passes none and keeps the capped listing. */
export interface HierarchyFocus {
  /** The party's place, or null to keep the stored order. */
  party: WorldPlace | null;
  /** How many realms from the top keep their duchies and counties; distant realms always read as one line. */
  detailed: number;
}

const countyNoun = (count: number): string => (count === 1 ? 'county' : 'counties');

/** A county list that names what the county budget cut, so an emptied duchy never reads as having none. */
function countyList(shown: string[], total: number): string {
  if (shown.length === total) return shown.join(', ') || 'no counties';
  if (shown.length === 0) return `… ${total} ${countyNoun(total)}`;
  const cut = total - shown.length;
  return `${shown.join(', ')}, … and ${cut} more ${countyNoun(cut)}`;
}

/**
 * The realm, duchy and county hierarchy, capped by REALM_LIMIT and COUNTY_LIMIT; tails name what was cut.
 * With a focus every realm is listed, nearest the party first, and each cut is named on its own line.
 */
export function realmHierarchyLines(politics: StoredPolitics, places: WorldPlace[], focus?: HierarchyFocus): string[] {
  const placeName = (id: number | null): string | null =>
    id === null ? null : (places.find((place) => place.id === id)?.name ?? null);
  const realmNames = new Map(politics.realms.map((realm) => [realm.id, realm.name]));
  const counties = new Map(politics.counties.map((county) => [county.id, county]));
  const fromParty = distanceFrom(focus?.party ?? null);
  const countyDistances = new Map<number, number>();
  const countyDistance = (county: StoredCounty): number => {
    const known = countyDistances.get(county.id);
    if (known !== undefined) return known;
    const distance = fromParty(county.claim_hexes ?? county.hexes);
    countyDistances.set(county.id, distance);
    return distance;
  };
  const sorted = <T>(items: T[], distance: (item: T) => number): T[] => (focus ? nearestFirst(items, distance) : items);
  const named = (ids: number[]): string[] =>
    sorted(
      ids
        .map((id) => counties.get(id))
        .filter((county): county is StoredCounty => county !== undefined && county.hexes.length > 0),
      countyDistance,
    ).map((county) => county.name);
  const idsDistance = (ids: number[]): number =>
    Math.min(
      Infinity,
      ...ids
        .map((id) => counties.get(id))
        .filter((county): county is StoredCounty => county !== undefined)
        .map(countyDistance),
    );

  const order = focus
    ? realmFocus(politics, focus.party, countyDistance)
    : { realms: politics.realms.slice(0, REALM_LIMIT), near: REALM_LIMIT };
  const detailed = focus ? Math.min(focus.detailed, order.near) : REALM_LIMIT;

  const lines = ['Realms:'];
  let budget = COUNTY_LIMIT;
  let droppedCounties = 0;

  const take = (names: string[]): string[] => {
    if (names.length <= budget) {
      budget -= names.length;
      return names;
    }
    const shown = names.slice(0, Math.max(budget, 0));
    droppedCounties += names.length - shown.length;
    budget = 0;
    return shown;
  };

  for (const [index, realm] of order.realms.entries()) {
    const capital =
      realm.off_map
        ? 'capital off the map'
        : realm.capital_place_id === null
          ? 'no crown'
          : `capital ${placeName(realm.capital_place_id)}`;
    const liege = realm.liege_realm_id === null ? null : realmNames.get(realm.liege_realm_id);
    const vassal = liege === null || liege === undefined ? '' : `, vassal of ${liege}`;
    const header = `${realm.name} (${realmDescriptor(realm)}, ${capital}${vassal})`;
    // Distant realms, and any reached once the county budget is spent, read as one line with their count.
    if (index >= detailed || (focus && budget === 0)) {
      const total = named(realm.county_ids).length;
      lines.push(total > 0 ? `${header}: … ${total} ${countyNoun(total)}` : header);
      continue;
    }
    lines.push(header);

    const held = new Set<number>();
    const duchies = sorted(
      politics.duchies.filter((entry) => entry.realm_id === realm.id),
      (duchy) => idsDistance(duchy.county_ids),
    );
    for (const duchy of duchies) {
      const ids = duchy.county_ids.filter((id) => (counties.get(id)?.hexes.length ?? 0) > 0);
      ids.forEach((id) => held.add(id));
      const flags = [`seat ${placeName(duchy.seat_place_id) ?? 'unseated'}`];
      if (duchy.demesne) flags.push('crownlands');
      if (duchy.joined_how !== 'core') flags.push(`joined by ${duchy.joined_how}`);
      const names = named(ids);
      const shown = take(names);
      const list = focus ? countyList(shown, names.length) : shown.join(', ') || 'no counties';
      lines.push(`  ${duchy.name} (${flags.join(', ')}): ${list}`);
    }

    const outsideNames = named(realm.county_ids.filter((id) => !held.has(id)));
    const outside = take(outsideNames);
    if (focus && outsideNames.length > 0) lines.push(`  Outside duchies: ${countyList(outside, outsideNames.length)}`);
    else if (outside.length > 0) lines.push(`  Outside duchies: ${outside.join(', ')}`);
  }

  // A focused listing names each cut on its own line and drops no realm, so only the capped one needs the tail.
  const droppedRealms = politics.realms.length - order.realms.length;
  const tails = [
    !focus && droppedCounties > 0 ? `${droppedCounties} more counties` : null,
    droppedRealms > 0 ? `${droppedRealms} more realms` : null,
  ].filter((part): part is string => part !== null);
  if (tails.length > 0) lines.push(`… and ${tails.join(' and ')}`);

  const marches = sorted(
    politics.counties.filter((county) => county.is_march && county.hexes.length > 0),
    countyDistance,
  ).map((county) => county.name);
  if (marches.length > 0) {
    lines.push(`Marches: ${marches.slice(0, COUNTY_LIMIT).join(', ')}${cutTail(marches.length, COUNTY_LIMIT, ', ') ?? ''}`);
  }

  const claims = sorted(politics.claims, (claim) => idsDistance([claim.county_id]));
  for (const claim of claims.slice(0, COUNTY_LIMIT)) {
    const county = counties.get(claim.county_id);
    const claimant = realmNames.get(claim.claimant_realm_id);
    if (!county || claimant === undefined) continue;
    lines.push(`Contested: ${county.name} — claimed by ${claimant} (${claim.reason}, ${claim.strength})`);
  }
  if (politics.claims.length > COUNTY_LIMIT) lines.push(`… and ${politics.claims.length - COUNTY_LIMIT} more claims`);

  return lines;
}

function settlementLine(place: WorldPlace, county: string | null, duchy: string | null): string {
  const tags = place.tags;
  const flags = [String(tags.size ?? '')];
  if (tags.walled === true) flags.push('walled');
  if (tags.coast === true) flags.push('coast');
  const town = tags.size === 'town' || tags.size === 'city';
  const holds = county === null ? '' : `; ${county}${town && duchy !== null ? `, ${duchy}` : ''}`;
  const info = place.info.trim();
  return `- ${place.name} (${flags.filter((flag) => flag.length > 0).join(', ')}; ${String(tags.terrain)}${holds})${
    info ? ` - ${info}` : ''
  }${tags.coast === true ? ' [port]' : ''}${place.known_to_party ? ' [known]' : ''}`;
}

/** A route endpoint reads as the settlement on that hex; any other endpoint is where the route leaves the map. */
function routeEndpoint(view: RegionView, hex: string): string {
  const settlement = view.places.find((p) => p.kind === 'settlement' && p.hexes.includes(hex));
  return settlement?.name ?? 'the map edge';
}

function routeItem(view: RegionView, route: WorldRoute): string {
  return `${routeEndpoint(view, route.from_hex)}-${routeEndpoint(view, route.to_hex)} ${route.hexes.length - 1} hexes`;
}

/** A danger with its distance to the nearest settlement, ties going to the first in place order. */
function dangerLine(danger: WorldPlace, settlements: WorldPlace[], where: string | null): string {
  let nearest: WorldPlace | null = null;
  let distance = Infinity;
  for (const settlement of settlements) {
    const hexes = placeDistance(danger, settlement);
    if (hexes < distance) {
      nearest = settlement;
      distance = hexes;
    }
  }
  const from = nearest ? `, ${distance} hexes from ${nearest.name}` : '';
  const lies = where === null ? '' : `, ${where}`;
  return `- ${danger.name} (dungeon${from}${lies})${danger.known_to_party ? ' [known]' : ''}`;
}

/** Land outside every held county: the wilds, named for the realm whose claim covers it, or its Marches. */
function wildsOf(politics: StoredPolitics, place: WorldPlace): string {
  const hex = place.hexes[0];
  const claim = politics.counties.find((county) => (county.claim_hexes ?? county.hexes).includes(hex));
  const realm = claim === undefined ? undefined : politics.realms.find((entry) => entry.id === claim.realm_id);
  if (claim === undefined || realm === undefined) return 'in the wilds';
  return claim.is_march ? `in the Marches of ${realm.name}` : `in the wilds of ${realm.name}`;
}

/** The DM's region block, centred on the party and trimmed, distant detail first, to REGION_BRIEFING tokens. */
export function regionBriefing(db: Db, campaignId: number, locationName: string | null): string {
  const view = getRegion(db, campaignId);
  if (!view) return '';

  const politics = ensurePolitics(db, campaignId);
  const located = locationName !== null && locationName.trim().length > 0;
  const at = located ? matchPlace(db, campaignId, locationName) : undefined;
  const fromParty = distanceFrom(at ?? null);
  const byParty = <T extends { hexes: string[] }>(items: T[]): T[] =>
    nearestFirst(items, (item) => fromParty(item.hexes));

  const head = [
    `## Region: ${view.name} (${view.tags.join(', ')}; 1 hex = ${MILES_PER_HEX} miles)`,
    'Set the story in this region: open scenes in or between these places, and name new places (an inn, a farm, a shrine) only inside it. Look a place up with region {op: get, place}; when the party learns of one, region {op: reveal, place}.',
  ];

  const partyLines: string[] = [];
  if (located) {
    if (!at) {
      partyLines.push(`Party is at "${locationName}", which is not on the region map.`);
    } else if (at.name.toLowerCase() === locationName.trim().toLowerCase()) {
      partyLines.push(`Party is at: ${at.name} (${at.kind})`);
    } else {
      partyLines.push(`Party is around: ${at.name} (${at.kind}), from the scene location "${locationName}"`);
    }
  }

  const settlements = view.places.filter((p) => p.kind === 'settlement');
  const settlementLines = byParty(settlements).map((place) => {
    const county = countyFor(politics, place);
    return settlementLine(place, county?.name ?? null, politics ? duchyNameOf(politics, county) : null);
  });
  const areaItems = byParty(view.places.filter((p) => p.kind === 'area')).map(
    (area) => `${area.name} (${String(area.tags.terrain)})`,
  );
  const routeItems = (kind: WorldRoute['kind']): string[] =>
    byParty(view.routes.filter((route) => route.kind === kind)).map((route) => routeItem(view, route));
  const roadItems = routeItems('road');
  const seaItems = routeItems('searoute');

  const dangerLines = byParty(view.places.filter((p) => p.kind === 'danger')).map((danger) => {
    const county = countyFor(politics, danger);
    const where = !politics ? null : county ? `in ${county.name}` : wildsOf(politics, danger);
    return dangerLine(danger, settlements, where);
  });

  let nearLine: string | null = null;
  if (at) {
    const near = nearbyPlaces(view, at, 3);
    if (near.length > 0) {
      const shown = near
        .slice(0, NEARBY_LIMIT)
        .map((entry) => `${entry.place.name} (${entry.place.kind}, ${entry.hexes} hexes)`);
      nearLine = `Near the party: ${shown.join(', ')}${cutTail(near.length, NEARBY_LIMIT, ', ') ?? ''}`;
    }
  }

  const render = (detailed: number, keep: number): string[] => {
    const scaled = (limit: number): number => Math.max(1, Math.ceil((limit * keep) / TRIM_STEPS));
    const lines = [...head];

    if (politics && politics.realms.length > 0) {
      lines.push(...realmHierarchyLines(politics, view.places, { party: at ?? null, detailed }));
    }
    lines.push(...partyLines);

    if (settlementLines.length > 0) {
      const limit = scaled(SETTLEMENT_LIMIT);
      lines.push('Settlements:', ...settlementLines.slice(0, limit));
      const tail = cutTail(settlementLines.length, limit, '- ');
      if (tail) lines.push(tail);
    }

    if (areaItems.length > 0) {
      const limit = scaled(AREA_LIMIT);
      lines.push(`Areas: ${areaItems.slice(0, limit).join(', ')}${cutTail(areaItems.length, limit, ', ') ?? ''}`);
    }

    if (view.routes.length > 0) {
      const roadLimit = scaled(ROAD_LIMIT);
      const seaLimit = scaled(SEA_LIMIT);
      const roadsPart = roadItems.slice(0, roadLimit).join(', ') + (cutTail(roadItems.length, roadLimit, ', ') ?? '');
      const seasPart = seaItems.slice(0, seaLimit).join(', ') + (cutTail(seaItems.length, seaLimit, ', ') ?? '');
      let line = `Routes: ${roadsPart}`;
      if (seaItems.length > 0) line += `${roadItems.length > 0 ? '; ' : ''}sea: ${seasPart}`;
      lines.push(line);
    }

    if (dangerLines.length > 0) {
      const limit = scaled(DANGER_LIMIT);
      lines.push('Dangers (DM only):', ...dangerLines.slice(0, limit));
      const tail = cutTail(dangerLines.length, limit, '- ');
      if (tail) lines.push(tail);
    }

    if (nearLine !== null) lines.push(nearLine);
    return lines;
  };

  // Collapse the farthest detailed realms first, then shorten every list from its far end, then cut from the bottom.
  let detailed = politics
    ? realmFocus(politics, at ?? null, (county) => fromParty(county.claim_hexes ?? county.hexes)).near
    : 0;
  let keep = TRIM_STEPS;
  let lines = render(detailed, keep);
  while (estimateTokens(lines.join('\n')) > REGION_BRIEFING) {
    if (detailed > 1) detailed -= 1;
    else if (keep > 0) keep -= 1;
    else if (lines.length > head.length) {
      lines.pop();
      continue;
    } else break;
    lines = render(detailed, keep);
  }
  return lines.join('\n');
}
