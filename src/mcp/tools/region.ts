import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { findPlace, getRegion, type PlaceKind, type RegionView, type WorldPlace } from '../../core/region.js';
import { ensurePolitics, placePolitics } from '../../core/politics-service.js';
import type { StoredPolitics } from '../../core/politics-store.js';
import { MILES_PER_HEX, nearbyPlaces, placeDistance, routeBetween } from '../../core/region-graph.js';
import { revealPlace } from '../../core/region-reveal.js';
import { fetchPlaceMap, placeMapKind, PlaceMapFetchError } from '../../core/place-map-fetch.js';
import { digestPlaceMap, renderPlaceMapDigest } from '../../core/place-map-digest.js';
import { canHold, getPlaceMap, savePlaceMap } from '../../core/place-map.js';
import { BUILDING_KINDS, digestPlan, dwellingsUrl, renderPlanDigest } from '../../core/building-plan.js';
import { BuildingFetchError, fetchBuildingPlan } from '../../core/building-fetch.js';
import { findBuilding, listBuildings, revealBuilding, saveBuilding } from '../../core/building.js';
import { randomSeed } from '../../core/dice.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

const ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const NO_REGION = 'This campaign has no region map yet. The player adds one in the companion window (Settings, Region).';

const noPlace = (ref: number | string): Error =>
  new Error(`No place "${String(ref)}" on the region map. Call region with op=get for the list.`);

const notASettlement = (name: string): Error =>
  new Error(`${name} is not a settlement; buildings stand in towns, villages and cities.`);

function requireRegion(db: Db, campaignId: number): RegionView {
  const view = getRegion(db, campaignId);
  if (view === null) throw new Error(NO_REGION);
  return view;
}

const knownMark = (place: WorldPlace): string => (place.known_to_party ? ' [known]' : '');

/** The settlement sitting on a route endpoint's hex, if any, so routes read by name. */
const settlementOnHex = (view: RegionView, hex: string): string | undefined =>
  view.places.find((p) => p.kind === 'settlement' && p.hexes.includes(hex))?.name;

/** The closest settlement to a place by hex distance, or null when the map has none. */
function nearestSettlement(view: RegionView, place: WorldPlace): { name: string; hexes: number } | null {
  let best: { name: string; hexes: number } | null = null;
  for (const settlement of view.places.filter((p) => p.kind === 'settlement')) {
    const hexes = placeDistance(place, settlement);
    if (best === null || hexes < best.hexes) best = { name: settlement.name, hexes };
  }
  return best;
}

interface RealmView {
  id: number;
  name: string;
  capital: string | null;
  counties: Array<{ id: number; name: string; seat: string; hexes: number }>;
}

/** The division's realms with capital and seat names resolved against the map's places. */
function realmViews(view: RegionView, politics: StoredPolitics): RealmView[] {
  const nameOf = (id: number | null): string | null =>
    id === null ? null : (view.places.find((p) => p.id === id)?.name ?? null);
  return politics.realms.map((realm) => ({
    id: realm.id,
    name: realm.name,
    capital: nameOf(realm.capital_place_id),
    counties: politics.counties
      .filter((county) => county.realm_id === realm.id)
      .map((county) => ({
        id: county.id,
        name: county.name,
        seat: nameOf(county.seat_place_id) ?? '',
        hexes: county.hexes.length,
      })),
  }));
}

function mapData(view: RegionView, politics: StoredPolitics): Record<string, unknown> {
  const of = (kind: PlaceKind): WorldPlace[] => view.places.filter((p) => p.kind === kind);
  return {
    realms: realmViews(view, politics),
    name: view.name,
    tags: view.tags,
    source: view.source,
    seed: view.seed,
    miles_per_hex: MILES_PER_HEX,
    settlements: of('settlement').map((p) => ({
      id: p.id,
      name: p.name,
      size: p.tags.size,
      walled: p.tags.walled === true,
      coast: p.tags.coast === true,
      terrain: p.tags.terrain,
      info: p.info,
      known: p.known_to_party,
    })),
    areas: of('area').map((p) => ({
      id: p.id,
      name: p.name,
      terrain: p.tags.terrain,
      hexes: p.hexes.length,
      known: p.known_to_party,
    })),
    dangers: of('danger').map((p) => {
      const near = nearestSettlement(view, p);
      return {
        id: p.id,
        name: p.name,
        known: p.known_to_party,
        nearest_settlement: near?.name ?? null,
        hexes_away: near?.hexes ?? null,
      };
    }),
    routes: view.routes.map((r) => ({
      kind: r.kind,
      from: settlementOnHex(view, r.from_hex) ?? r.from_hex,
      to: settlementOnHex(view, r.to_hex) ?? r.to_hex,
      hexes: r.hexes.length - 1,
    })),
  };
}

function renderMap(view: RegionView, politics: StoredPolitics): string {
  const of = (kind: PlaceKind): WorldPlace[] => view.places.filter((p) => p.kind === kind);
  const lines = [
    `${view.name} (${view.source}, seed ${view.seed}, tags: ${view.tags.join(', ') || 'none'}; ${MILES_PER_HEX} miles per hex)`,
    'Settlements:',
  ];
  const settlements = of('settlement');
  if (settlements.length === 0) lines.push('- none');
  for (const p of settlements) {
    const flags = [p.tags.walled === true ? 'walled' : 'unwalled', p.tags.coast === true ? 'on the coast' : 'inland'];
    lines.push(`- ${p.name} (${String(p.tags.size ?? '')}, ${flags.join(', ')}, ${String(p.tags.terrain ?? '')})${knownMark(p)}: ${p.info}`);
  }
  lines.push('Areas:');
  const areas = of('area');
  if (areas.length === 0) lines.push('- none');
  for (const p of areas) lines.push(`- ${p.name} (${String(p.tags.terrain ?? '')}, ${p.hexes.length} hexes)${knownMark(p)}`);
  lines.push('Dangers:');
  const dangers = of('danger');
  if (dangers.length === 0) lines.push('- none');
  for (const p of dangers) {
    const near = nearestSettlement(view, p);
    const where = near ? `nearest ${near.name}, ${near.hexes} hexes away` : 'no settlement near';
    lines.push(`- ${p.name} (${where})${knownMark(p)}`);
  }
  lines.push('Routes:');
  if (view.routes.length === 0) lines.push('- none');
  for (const r of view.routes) {
    const from = settlementOnHex(view, r.from_hex) ?? r.from_hex;
    const to = settlementOnHex(view, r.to_hex) ?? r.to_hex;
    lines.push(`- ${r.kind}: ${from} - ${to}, ${r.hexes.length - 1} hexes`);
  }
  for (const realm of realmViews(view, politics)) {
    const counties = realm.counties.map((c) => `${c.name} (seat ${c.seat}, ${c.hexes} hexes)`).join(', ');
    const crown = realm.capital === null ? 'no crown' : `capital ${realm.capital}`;
    lines.push(`Realm ${realm.name} (${crown}): ${counties || 'no counties'}`);
  }
  return lines.join('\n');
}

function renderPlace(
  place: WorldPlace,
  nearby: ReturnType<typeof nearbyPlaces>,
  route: ReturnType<typeof routeBetween> | undefined,
  target: WorldPlace | undefined,
  buildings: Array<{ name: string; kind: string; known: boolean }> = [],
  politics?: ReturnType<typeof placePolitics>,
): string {
  const detail = place.info || place.link || '';
  const holds = [politics?.county?.name, politics?.realm?.name].filter((name) => name !== undefined);
  const lines = [
    `${place.name} (${place.kind})${knownMark(place)}${detail ? ` - ${detail}` : ''}${holds.length > 0 ? ` — ${holds.join(', ')}` : ''}`,
    nearby.length === 0
      ? 'Within 3 hexes: nothing.'
      : `Within 3 hexes: ${nearby.map((e) => `${e.place.name} (${e.place.kind}, ${e.hexes} hexes, ${e.miles} miles)`).join('; ')}.`,
  ];
  if (buildings.length > 0) {
    lines.push(
      `Buildings: ${buildings.map((b) => `${b.name} (${b.kind})${b.known ? ' [known]' : ''}`).join(', ')}`,
    );
  }
  if (target !== undefined) {
    if (route) {
      const kinds = route.kinds.length > 0 ? route.kinds.join(' + ') : 'same hex';
      const via = route.stops.length > 0 ? ` via ${route.stops.join(', ')}` : '';
      lines.push(`Route to ${target.name}: ${kinds}, ${route.hexes} hexes (${route.miles} miles)${via}.`);
    } else {
      const hexes = placeDistance(place, target);
      lines.push(
        `No road or sea route to ${target.name}; the straight-line distance is ${hexes} hexes (${hexes * MILES_PER_HEX} miles).`,
      );
    }
  }
  return lines.join('\n');
}

export function registerRegionTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'region', {
    title: 'Region map',
    description:
      "The campaign's region map: its settlements, areas, roads and sea routes, and the dangers only the DM knows. Set the story inside it and use its distances for travel.",
    fields: {
      campaign_id: z.number().int(),
      place: z.union([z.number().int(), z.string()]).optional().describe('A place id or name on the region map.'),
      to: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe('(op=get) A second place: adds the travel route from place to it.'),
      building: z
        .string()
        .optional()
        .describe("(op=building, reveal) A building's name inside the settlement given as place."),
      kind: z.enum(BUILDING_KINDS).optional().describe('(op=building) What the building is, when creating it.'),
    },
    ops: {
      get: {
        summary:
          'With no place, the whole map: settlements, areas, routes and the DM-only dangers. With place, that place, what lies within 3 hexes and, with to, the travel route between them',
        requires: [],
        uses: ['place', 'to'],
        run: (args) => {
          const { op, ...input } = args;
          const view = requireRegion(db, input.campaign_id);
          if (input.place === undefined) {
            const politics = ensurePolitics(db, input.campaign_id)!;
            return reply(db, input.campaign_id, mapData(view, politics), renderMap(view, politics));
          }
          const place = findPlace(db, input.campaign_id, input.place);
          if (!place) throw noPlace(input.place);
          const held = placePolitics(db, input.campaign_id, place);
          const nearby = nearbyPlaces(view, place, 3);
          const data: Record<string, unknown> = {
            place: {
              id: place.id,
              kind: place.kind,
              name: place.name,
              tags: place.tags,
              info: place.info,
              known: place.known_to_party,
              link: place.link,
            },
            politics: held,
            nearby: nearby.map((entry) => ({
              id: entry.place.id,
              name: entry.place.name,
              kind: entry.place.kind,
              hexes: entry.hexes,
              miles: entry.miles,
            })),
          };
          const buildings =
            place.kind === 'settlement'
              ? listBuildings(db, input.campaign_id, place.id).map((b) => ({
                  name: b.name,
                  kind: b.kind,
                  known: b.known_to_party,
                }))
              : [];
          if (buildings.length > 0) data.buildings = buildings;
          let route: ReturnType<typeof routeBetween> | undefined;
          let target: WorldPlace | undefined;
          if (input.to !== undefined) {
            target = findPlace(db, input.campaign_id, input.to);
            if (!target) throw noPlace(input.to);
            route = routeBetween(view, place, target);
            data.route = route;
          }
          return reply(db, input.campaign_id, data, renderPlace(place, nearby, route, target, buildings, held));
        },
      },
      building: {
        summary:
          'A named building inside a settlement, with its floor plan as a digest (floors, rooms, doors, windows, stairs, entrance). The first call with a kind creates it (fetching the plan takes about a minute); later calls return it instantly',
        requires: ['place', 'building'],
        uses: ['kind'],
        run: async (args) => {
          const { op, ...input } = args;
          requireRegion(db, input.campaign_id);
          const place = findPlace(db, input.campaign_id, input.place!);
          if (!place) throw noPlace(input.place!);
          if (place.kind !== 'settlement') throw notASettlement(place.name);
          const name = input.building!.trim();
          if (!name) throw new Error('A building needs a name.');

          const existing = findBuilding(db, input.campaign_id, place.id, name);
          let building = existing;
          let digest: ReturnType<typeof digestPlan>;
          let cached = existing !== undefined;
          if (building) {
            digest = digestPlan(building.raw);
          } else {
            if (input.kind === undefined) {
              throw new Error(
                `No building "${name}" in ${place.name} yet. To create it, give a kind: ${BUILDING_KINDS.join(', ')}.`,
              );
            }
            const seed = randomSeed();
            const url = dwellingsUrl(seed, input.kind);
            const fetched = await fetchBuildingPlan(url, { timeoutMs: 35000 }).catch((err: unknown) => {
              if (err instanceof BuildingFetchError) {
                throw new Error(`${err.message} Try again, or describe ${name} without its plan.`);
              }
              throw err;
            });
            try {
              digest = digestPlan(fetched.raw);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(`The floor plan for ${name} could not be read (${message}).`);
            }
            const raced = findBuilding(db, input.campaign_id, place.id, name);
            if (raced) {
              building = raced;
              digest = digestPlan(raced.raw);
              cached = true;
            } else {
              building = saveBuilding(db, input.campaign_id, place.id, {
                name,
                kind: input.kind,
                seed,
                url: fetched.url,
                raw: fetched.raw,
              });
            }
          }

          const data = {
            place: place.name,
            building: building.name,
            kind: building.kind,
            known: building.known_to_party,
            cached,
            digest,
          };
          let text = renderPlanDigest(building.name, building.kind, digest);
          if (!building.known_to_party) {
            text += `\nThe party has not been inside ${building.name} yet. Once you reveal it with region {op: reveal, place, building}, the player can open its plan in the codex.`;
          }
          return reply(db, input.campaign_id, data, text);
        },
      },
      reveal: {
        summary:
          'The party has learned of place: mark it known and give it a codex entry, so the player can see it',
        requires: ['place'],
        uses: ['building'],
        run: (args) => {
          const { op, ...input } = args;
          requireRegion(db, input.campaign_id);
          if (input.building !== undefined) {
            const place = findPlace(db, input.campaign_id, input.place!);
            if (!place) throw noPlace(input.place!);
            if (place.kind !== 'settlement') throw notASettlement(place.name);
            const building = findBuilding(db, input.campaign_id, place.id, input.building);
            if (!building) {
              throw new Error(
                `No building "${input.building}" in ${place.name}. Create it with region {op: building, place, building, kind}.`,
              );
            }
            const reveal = place.known_to_party ? undefined : revealPlace(db, input.campaign_id, place.id);
            revealBuilding(db, input.campaign_id, building.id);
            const after = findPlace(db, input.campaign_id, place.id)!;
            const data: Record<string, unknown> = { place: place.name, building: building.name, known: true };
            if (reveal?.warning !== undefined) data.warning = reveal.warning;
            let text =
              after.entity_id === null
                ? `${building.name} in ${place.name} is now known to the party; ${place.name} has no codex entry the player can open (a codex entry of another kind uses that name), so they cannot see the plan yet.`
                : `${building.name} in ${place.name} is now known to the party; its plan shows in ${place.name}'s codex entry.`;
            if (reveal?.warning !== undefined) text += ` ${reveal.warning}`;
            return reply(db, input.campaign_id, data, text);
          }
          const result = revealPlace(db, input.campaign_id, input.place!);
          const data: Record<string, unknown> = {
            place: result.place.name,
            kind: result.place.kind,
            entity_id: result.entity_id,
            created: result.created,
          };
          if (result.warning !== undefined) data.warning = result.warning;
          const text = result.warning ?? `${result.place.name} is now known to the party and has a codex entry.`;
          return reply(db, input.campaign_id, data, text);
        },
      },
      map: {
        summary:
          'The map of a settlement (its city or village) or of a danger (its dungeon), as a short digest: districts, walls and water for a town; rooms, doors, story and keyed notes for a dungeon. The first call fetches it (about a minute; if it times out, call again); later calls are instant',
        requires: ['place'],
        run: async (args) => {
          const { op, ...input } = args;
          requireRegion(db, input.campaign_id);
          const place = findPlace(db, input.campaign_id, input.place!);
          if (!place) throw noPlace(input.place!);
          if (place.kind === 'area') {
            throw new Error(`${place.name} is an area; only settlements and dangers have their own maps.`);
          }
          if (place.link === null || placeMapKind(place.link) === null) {
            throw new Error(`${place.name} has no map link.`);
          }
          const mapKind = placeMapKind(place.link)!;
          if (!canHold(place.kind, mapKind)) {
            throw new Error(`${place.name}'s link points at a ${mapKind} map, which a ${place.kind} cannot have.`);
          }
          const stored = getPlaceMap(db, input.campaign_id, place.id);
          let map = stored;
          let digest: ReturnType<typeof digestPlaceMap>;
          if (map === null) {
            const fetched = await fetchPlaceMap(place.link, { timeoutMs: 35000 }).catch((err: unknown) => {
              if (err instanceof PlaceMapFetchError) {
                throw new Error(`${err.message} Try again, or describe ${place.name} without its map.`);
              }
              throw err;
            });
            try {
              digest = digestPlaceMap(fetched.kind, fetched.raw, place.link, place.name);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(
                `${place.name}'s map file could not be read (${message}). Try again, or describe ${place.name} without its map.`,
              );
            }
            map = savePlaceMap(db, input.campaign_id, place.id, {
              kind: fetched.kind,
              url: fetched.url,
              raw: fetched.raw,
            });
          } else {
            digest = digestPlaceMap(map.kind, map.raw, place.link, place.name);
          }
          const data = {
            place: place.name,
            place_kind: place.kind,
            map_kind: map.kind,
            cached: stored !== null,
            fetched_at: map.fetched_at,
            digest,
          };
          let text = renderPlaceMapDigest(digest);
          if (place.kind === 'settlement' && !place.known_to_party) {
            text += `\nThe party has not heard of ${place.name} yet. Once you reveal it with region {op: reveal}, the player can open its map in the codex.`;
          }
          return reply(db, input.campaign_id, data, text);
        },
      },
    },
    annotations: { ...ANNOTATIONS },
  });
}
