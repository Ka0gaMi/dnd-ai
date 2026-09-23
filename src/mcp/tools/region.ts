import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { findPlace, getRegion, type PlaceKind, type RegionView, type WorldPlace } from '../../core/region.js';
import { MILES_PER_HEX, nearbyPlaces, placeDistance, routeBetween } from '../../core/region-graph.js';
import { revealPlace } from '../../core/region-reveal.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

const ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const NO_REGION = 'This campaign has no region map yet. The player adds one in the companion window (Settings, Region).';

const noPlace = (ref: number | string): Error =>
  new Error(`No place "${String(ref)}" on the region map. Call region with op=get for the list.`);

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

function mapData(view: RegionView): Record<string, unknown> {
  const of = (kind: PlaceKind): WorldPlace[] => view.places.filter((p) => p.kind === kind);
  return {
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

function renderMap(view: RegionView): string {
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
  return lines.join('\n');
}

function renderPlace(
  place: WorldPlace,
  nearby: ReturnType<typeof nearbyPlaces>,
  route: ReturnType<typeof routeBetween> | undefined,
  target: WorldPlace | undefined,
): string {
  const detail = place.info || place.link || '';
  const lines = [
    `${place.name} (${place.kind})${knownMark(place)}${detail ? ` - ${detail}` : ''}`,
    nearby.length === 0
      ? 'Within 3 hexes: nothing.'
      : `Within 3 hexes: ${nearby.map((e) => `${e.place.name} (${e.place.kind}, ${e.hexes} hexes, ${e.miles} miles)`).join('; ')}.`,
  ];
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
            return reply(db, input.campaign_id, mapData(view), renderMap(view));
          }
          const place = findPlace(db, input.campaign_id, input.place);
          if (!place) throw noPlace(input.place);
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
            nearby: nearby.map((entry) => ({
              id: entry.place.id,
              name: entry.place.name,
              kind: entry.place.kind,
              hexes: entry.hexes,
              miles: entry.miles,
            })),
          };
          let route: ReturnType<typeof routeBetween> | undefined;
          let target: WorldPlace | undefined;
          if (input.to !== undefined) {
            target = findPlace(db, input.campaign_id, input.to);
            if (!target) throw noPlace(input.to);
            route = routeBetween(view, place, target);
            data.route = route;
          }
          return reply(db, input.campaign_id, data, renderPlace(place, nearby, route, target));
        },
      },
      reveal: {
        summary:
          'The party has learned of place: mark it known and give it a codex entry, so the player can see it',
        requires: ['place'],
        run: (args) => {
          const { op, ...input } = args;
          requireRegion(db, input.campaign_id);
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
    },
    annotations: { ...ANNOTATIONS },
  });
}
