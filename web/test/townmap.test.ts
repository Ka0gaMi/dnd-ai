import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import TownMap from '../src/components/TownMap.svelte';
import { townLayers } from '../src/lib/townmap';

interface Feature {
  id: string;
  type: string;
  coordinates?: unknown;
  geometries?: unknown;
}

// Real Watabou exports, imported as JSON so the web type check needs no Node types.
import redham from '../../test/fixtures/map-city-redham.json';
import hotfield from '../../test/fixtures/map-village-hotfield.json';

const FIXTURES: Record<string, unknown> = { 'map-city-redham.json': redham, 'map-village-hotfield.json': hotfield };

/** A fixture by file name; only the fields the tests touch are typed. */
const load = (file: string): { features: Feature[] } => structuredClone(FIXTURES[file]) as { features: Feature[] };

describe('townLayers', () => {
  it('reads the city: every building, its six districts, one wall and a containing viewBox', () => {
    const city = load('map-city-redham.json');
    const layers = townLayers(city);

    expect(layers.buildings.length).toBe(343);
    expect(layers.districts.map((district) => district.name)).toEqual([
      'Merchants District',
      'Docks Ward',
      'South Redham',
      'Downfall Gate',
      'Bone Orchard',
      'Daggerchurch Square',
    ]);
    expect(layers.walls.length).toBe(1);

    const [minX, minY, width, height] = layers.viewBox.split(' ').map(Number);
    for (const value of [minX, minY, width, height]) expect(Number.isFinite(value)).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    const buildings = city.features.find((feature) => feature.id === 'buildings');
    for (const polygon of buildings?.coordinates as number[][][][]) {
      const [x, north] = polygon[0][0];
      const y = -north;
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(minX + width);
      expect(y).toBeGreaterThanOrEqual(minY);
      expect(y).toBeLessThanOrEqual(minY + height);
    }
  });

  it('reads the village and thins its trees to the cap', () => {
    const layers = townLayers(load('map-village-hotfield.json'));

    expect(layers.water.length).toBeGreaterThan(0);
    expect(layers.buildings.length).toBe(20);
    expect(layers.trees.length).toBeLessThanOrEqual(400);
    expect(layers.districts.length).toBe(0);
  });

  it('draws one square building and pads its viewBox', () => {
    const layers = townLayers({
      type: 'FeatureCollection',
      features: [
        {
          type: 'MultiPolygon',
          id: 'buildings',
          coordinates: [
            [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
            ],
          ],
        },
      ],
    });

    // y is mirrored: the generator's north-up coordinates become SVG's down-positive ones.
    expect(layers.buildings).toEqual(['M 0 0 L 10 0 L 10 -10 L 0 -10 L 0 0 Z']);
    expect(layers.viewBox).toBe('-20 -30 50 50');
  });

  it('refuses anything that is not a town map', () => {
    expect(() => townLayers({})).toThrow('Not a town map');
  });

  it('thins a dense stand of trees to the cap', () => {
    const trees = Array.from({ length: 1000 }, (_, index) => [index, 0]);
    const layers = townLayers({
      type: 'FeatureCollection',
      features: [
        {
          type: 'MultiPolygon',
          id: 'buildings',
          coordinates: [
            [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
            ],
          ],
        },
        { type: 'MultiPoint', id: 'trees', coordinates: trees },
      ],
    });

    expect(layers.trees.length).toBeGreaterThan(0);
    expect(layers.trees.length).toBeLessThanOrEqual(400);
  });

  it('labels each named district and skips the unnamed one', () => {
    const layers = townLayers({
      type: 'FeatureCollection',
      features: [
        {
          type: 'MultiPolygon',
          id: 'buildings',
          coordinates: [
            [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
            ],
          ],
        },
        {
          type: 'GeometryCollection',
          id: 'districts',
          geometries: [
            { type: 'Polygon', name: 'Old Town', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
            { type: 'Polygon', name: 'Old Town', coordinates: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]] },
            { type: 'Polygon', coordinates: [[[40, 0], [50, 0], [50, 10], [40, 10], [40, 0]]] },
          ],
        },
      ],
    });

    expect(layers.districts.map((district) => district.name)).toEqual(['Old Town', 'Old Town']);
  });
});

describe('TownMap', () => {
  it('draws the city and names it', () => {
    const { body } = render(TownMap, {
      props: { name: 'Redham', kind: 'city', geojson: load('map-city-redham.json') },
    });

    expect(body).toContain('<svg');
    expect(body).toContain('Merchants District');
    expect(body).toContain("Redham — drawn from Watabou's city generator");
  });

  it('renders two same-named districts without a key clash', () => {
    const geojson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'GeometryCollection',
          id: 'districts',
          geometries: [
            { type: 'Polygon', name: 'Old Town', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
            { type: 'Polygon', name: 'Old Town', coordinates: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]] },
            { type: 'Polygon', coordinates: [[[40, 0], [50, 0], [50, 10], [40, 10], [40, 0]]] },
          ],
        },
      ],
    };

    expect(() => render(TownMap, { props: { name: 'Old Town', kind: 'city', geojson } })).not.toThrow();
  });
});
