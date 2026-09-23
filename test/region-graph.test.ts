import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { importRegion, type RegionView, type WorldPlace } from '../src/core/region.js';
import {
  hexDistance,
  locatePlace,
  nearbyPlaces,
  parseHex,
  placeDistance,
  routeBetween,
} from '../src/core/region-graph.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function importedRegion(): RegionView {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  return importRegion(db, campaignId, safe, { source: 'generated' });
}

function place(view: RegionView, name: string): WorldPlace {
  const found = view.places.find((p) => p.name === name);
  if (!found) throw new Error(`No place named ${name}`);
  return found;
}

describe('parseHex', () => {
  it('reads a hex id', () => {
    expect(parseHex('q6_r8')).toEqual({ q: 6, r: 8 });
  });

  it('refuses anything else', () => {
    expect(() => parseHex('x')).toThrow('Not a hex id: "x"');
  });
});

describe('hexDistance', () => {
  const origin = { q: 0, r: 0 };

  it('counts steps in even-r offset', () => {
    expect(hexDistance(origin, { q: 1, r: 0 })).toBe(1);
    expect(hexDistance(origin, { q: 0, r: 1 })).toBe(1);
    expect(hexDistance(origin, { q: 1, r: 1 })).toBe(1);
    expect(hexDistance(origin, { q: 0, r: 2 })).toBe(2);
  });
});

describe('placeDistance on the safe realm', () => {
  it('measures straight-line hex distances between places', () => {
    const view = importedRegion();

    expect(placeDistance(place(view, 'Stormcourtby'), place(view, 'Redham'))).toBe(4);
    expect(placeDistance(place(view, 'Redham'), place(view, 'Ficengwind'))).toBe(4);
    expect(placeDistance(place(view, 'Hotfield'), place(view, 'Southern Landing'))).toBe(3);
    expect(placeDistance(place(view, 'Stormcourtby'), place(view, 'Southern Landing'))).toBe(9);
    expect(placeDistance(place(view, 'Ironfall Fens'), place(view, 'Redham'))).toBe(1);
  });
});

describe('nearbyPlaces on the safe realm', () => {
  it('lists places within the hex radius and never the place itself', () => {
    const view = importedRegion();
    const redham = place(view, 'Redham');
    const near = nearbyPlaces(view, redham, 1);

    expect(near.find((entry) => entry.place.name === 'Ironfall Fens')).toMatchObject({ hexes: 1, miles: 6 });
    expect(near.some((entry) => entry.place.id === redham.id)).toBe(false);
  });
});

describe('routeBetween on the safe realm', () => {
  it('travels a single road between its endpoints', () => {
    const view = importedRegion();

    expect(routeBetween(view, place(view, 'Stormcourtby'), place(view, 'Redham'))).toEqual({
      hexes: 4,
      miles: 24,
      kinds: ['road'],
      stops: [],
    });
  });

  it('chains roads through Stormcourtby', () => {
    const view = importedRegion();

    expect(routeBetween(view, place(view, 'Redham'), place(view, 'Ficengwind'))).toEqual({
      hexes: 16,
      miles: 96,
      kinds: ['road', 'road'],
      stops: ['Stormcourtby'],
    });
  });

  it('chains roads through Ficengwind', () => {
    const view = importedRegion();

    expect(routeBetween(view, place(view, 'Hotfield'), place(view, 'Stormcourtby'))).toEqual({
      hexes: 21,
      miles: 126,
      kinds: ['road', 'road'],
      stops: ['Ficengwind'],
    });
  });

  it('sails a single searoute between its endpoints', () => {
    const view = importedRegion();

    expect(routeBetween(view, place(view, 'Southern Landing'), place(view, 'Redham'))).toEqual({
      hexes: 16,
      miles: 96,
      kinds: ['searoute'],
      stops: [],
    });
  });

  it('returns a zero-length plan for the same place', () => {
    const view = importedRegion();
    const redham = place(view, 'Redham');

    expect(routeBetween(view, redham, redham)).toEqual({ hexes: 0, miles: 0, kinds: [], stops: [] });
  });

  it('refuses to route into an area', () => {
    const view = importedRegion();

    expect(routeBetween(view, place(view, 'Coldwood'), place(view, 'Redham'))).toBeNull();
    expect(routeBetween(view, place(view, 'Redham'), place(view, 'Coldwood'))).toBeNull();
  });
});

describe('locatePlace', () => {
  it('matches an exact name in any case', () => {
    const view = importedRegion();

    expect(locatePlace(view, 'redham')).toMatchObject({ name: 'Redham', kind: 'settlement' });
  });

  it('finds the place named inside a longer description', () => {
    const view = importedRegion();

    expect(locatePlace(view, 'The Gilded Goose tavern in Redham')).toMatchObject({ name: 'Redham' });
  });

  it('chooses the longest contained name', () => {
    const view = importedRegion();

    expect(locatePlace(view, 'Outside Ficengwind, by the Raven Marshes')).toMatchObject({ name: 'Raven Marshes' });
  });

  it('returns undefined for an unknown name, null or blank text', () => {
    const view = importedRegion();

    expect(locatePlace(view, 'Nowhere')).toBeUndefined();
    expect(locatePlace(view, null)).toBeUndefined();
    expect(locatePlace(view, '   ')).toBeUndefined();
  });
});
