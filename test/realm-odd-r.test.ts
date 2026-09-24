import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { hexNeighbours } from '../src/core/politics.js';
import { regionHexes } from '../src/core/politics-store.js';
import { evenRHexId, parseRealm, realmAsEvenR } from '../src/core/realm.js';
import { getRegion, importRegion } from '../src/core/region.js';
import { parseHex } from '../src/core/region-graph.js';
import { openDb } from '../src/db/connection.js';

interface RawHex {
  q: number;
  r: number;
  terrain?: string;
  town?: { name: string; type: 'village' | 'town' | 'city' };
}

interface RawRealm {
  name: string;
  layout: string;
  bp: { tags: string[]; seed: number };
  hexes: Record<string, RawHex>;
  roads?: Record<string, string[]>;
  searoutes?: Record<string, string[]>;
  features?: Array<{ name: string; hexes: string[] }>;
  rivers?: Record<string, { parent?: string | null; channel: string[] }>;
}

function fixture(name: string): RawRealm {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as RawRealm;
}

const medium = fixture('realm-medium.json');

/** Odd-r offset neighbours: even rows step one way, odd rows the other, mirrored from the engine's even-r rule. */
function oddRNeighbours(q: number, r: number): string[] {
  const offsets =
    r % 2 === 0
      ? [
          [1, 0],
          [-1, 0],
          [0, -1],
          [-1, -1],
          [-1, 1],
          [0, 1],
        ]
      : [
          [1, 0],
          [-1, 0],
          [1, -1],
          [0, -1],
          [0, 1],
          [1, 1],
        ];
  return offsets.map(([dq, dr]) => `q${q + dq}_r${r + dr}`);
}

/** The even-r neighbours of a hex id, as ids. */
function evenRNeighbours(id: string): string[] {
  const { q, r } = parseHex(id);
  return hexNeighbours(q, r).map((neighbour) => `q${neighbour.q}_r${neighbour.r}`);
}

describe('parseRealm on the odd-r fixture', () => {
  it('accepts it and reads every settlement, with its own hex re-keyed to even-r', () => {
    const realm = parseRealm(medium);
    expect(realm.name).toBe('Easter Duilindir Kingdom');
    expect(realm.seed).toBe(5);
    expect(realm.settlements).toHaveLength(25);
    expect(realm.settlements.filter((settlement) => settlement.size === 'city')).toHaveLength(4);
    expect(realm.settlements.find((settlement) => settlement.name === 'Emberpoint')).toMatchObject({
      hex: 'q15_r4',
      q: 15,
      r: 4,
    });
    // Kaz sat on odd-r row 11, which shifts one column right in even-r.
    expect(realm.settlements.find((settlement) => settlement.name === 'Kaz')).toMatchObject({
      hex: 'q31_r11',
      q: 31,
      r: 11,
    });
  });

  it('re-keys every parsed hex reference into the converted hexes map', () => {
    const converted = realmAsEvenR(medium);
    const ids = new Set(Object.keys(converted.hexes));
    const realm = parseRealm(medium);

    const referenced = [
      ...realm.settlements.map((settlement) => settlement.hex),
      ...realm.dangers.map((danger) => danger.hex),
      ...realm.routes.flatMap((route) => [route.from_hex, route.to_hex, ...route.hexes]),
      ...(converted.features ?? []).flatMap((feature) => feature.hexes),
      ...Object.values(converted.roads ?? {}).flat(),
      ...Object.values(converted.searoutes ?? {}).flat(),
    ];
    expect(referenced.length).toBeGreaterThan(100);
    expect(referenced.filter((id) => !ids.has(id))).toEqual([]);

    // A route key joins its first and last converted hex ids, so the keys were re-keyed too.
    for (const entries of [converted.roads ?? {}, converted.searoutes ?? {}]) {
      for (const [key, list] of Object.entries(entries)) {
        expect(key).toBe(`${list[0]}-${list.at(-1)}`);
      }
    }
  });

  it('keeps hexes that were adjacent in the odd-r grid adjacent under the even-r rule', () => {
    const converted = realmAsEvenR(medium);
    const ids = new Set(Object.keys(converted.hexes));
    const broken: string[] = [];
    let checked = 0;
    for (const id of Object.keys(medium.hexes)) {
      const { q, r } = parseHex(id);
      for (const neighbour of oddRNeighbours(q, r)) {
        if (!(neighbour in medium.hexes)) continue;
        checked++;
        const from = evenRHexId(id);
        const to = evenRHexId(neighbour);
        if (!ids.has(to) || !evenRNeighbours(from).includes(to)) broken.push(`${from} -> ${to}`);
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(broken).toEqual([]);
  });

  it('keeps every road hex list contiguous after conversion', () => {
    const roads = parseRealm(medium).routes.filter((route) => route.kind === 'road');
    expect(roads.length).toBeGreaterThan(0);
    const broken: string[] = [];
    for (const route of roads) {
      for (let i = 1; i < route.hexes.length; i++) {
        if (!evenRNeighbours(route.hexes[i - 1]).includes(route.hexes[i])) {
          broken.push(`${route.hexes[i - 1]} -> ${route.hexes[i]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('re-keys river edge pairs so each converted edge still joins adjacent hexes', () => {
    const converted = realmAsEvenR(medium);
    const ids = new Set(Object.keys(converted.hexes));
    const broken: string[] = [];
    const rivers = Object.values(converted.rivers ?? {});
    expect(rivers.length).toBeGreaterThan(0);
    for (const river of rivers) {
      for (const edge of river.channel) {
        const [a, b] = edge.split(':');
        if (a === undefined || b === undefined || !ids.has(a) || !ids.has(b) || !evenRNeighbours(a).includes(b)) {
          broken.push(edge);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('imports through the real path and stores its four cities', () => {
    const db = openDb(':memory:');
    const campaignId = createCampaign(db, { name: 'Odd R', story_shape: 'structured' }).campaign_id;
    const view = importRegion(db, campaignId, medium, { source: 'generated' });
    const cities = view.places.filter((place) => place.kind === 'settlement' && place.tags.size === 'city');
    expect(cities.map((place) => place.name).sort()).toEqual(['Comon', 'Goldcaster', 'Kaz', 'Mirkwind']);
    const stored = getRegion(db, campaignId)!;
    expect(stored.places.filter((place) => place.kind === 'settlement' && place.tags.size === 'city')).toHaveLength(4);

    // The stored file stays as uploaded, but the raw-json reader hands back even-r hexes that line up.
    const row = db.prepare('SELECT raw_json FROM world_region WHERE campaign_id = ?').get(campaignId) as {
      raw_json: string;
    };
    expect((JSON.parse(row.raw_json) as { layout: string }).layout).toBe('odd-r');
    const hexes = regionHexes(db, campaignId)!;
    const hexIds = new Set(hexes.map((hex) => hex.id));
    expect(hexes).toHaveLength(968);
    expect(hexIds.has('q31_r11')).toBe(true);
    for (const place of stored.places) expect(hexIds.has(place.hexes[0]!)).toBe(true);
  });
});

describe('realmAsEvenR', () => {
  it('returns an even-r file untouched, so even-r parsing is unchanged', () => {
    const safe = fixture('realm-safe.json');
    expect(realmAsEvenR(safe)).toBe(safe);
  });
});
