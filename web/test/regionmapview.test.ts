import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import RegionMap from '../src/components/RegionMap.svelte';
import type { PlayerRegionMap } from '../src/lib/regionmap';

const hex = (q: number, r: number, county: number | null = null, terrain = 'plains') => ({
  id: `q${q}_r${r}`,
  q,
  r,
  terrain,
  county,
});

/** A player-safe region map; each case overrides what it is about. */
const map = (over: Partial<PlayerRegionMap> = {}): PlayerRegionMap => ({
  name: 'Realm Of Poss',
  width: 1,
  height: 1,
  hexes: [hex(0, 0)],
  counties: [],
  realms: [],
  duchies: [],
  places: [],
  routes: [],
  party: null,
  ...over,
});

describe('RegionMap', () => {
  it('asks for a map when there is none', () => {
    const { body } = render(RegionMap, { props: { map: null } });
    expect(body).toContain('No region map yet');
  });

  it('reports a map the party has not explored', () => {
    const { body } = render(RegionMap, { props: { map: map({ hexes: [] }) } });
    expect(body).toContain('The party has not seen any of Realm Of Poss yet.');
  });

  it('draws the hexes, places, routes, labels and party', () => {
    const { body } = render(RegionMap, {
      props: {
        map: map({
          width: 2,
          height: 2,
          hexes: [hex(0, 0, 0), hex(1, 0, 0, 'forest-light'), hex(0, 1, 0, 'water')],
          counties: [{ name: 'County of Redham', realm: 0 }],
          realms: [{ name: 'Kingdom of Ficengwind' }],
          places: [
            { name: 'Redham', kind: 'settlement', size: 'town', port: true, q: 0, r: 0 },
            { name: 'Coldwood', kind: 'area', size: null, port: false, q: 1, r: 0 },
            { name: 'Hidden Keep', kind: 'danger', size: null, port: false, q: 0, r: 1 },
          ],
          routes: [{ kind: 'road', hexes: ['q0_r0', 'q1_r0'] }],
          party: { q: 0, r: 0 },
        }),
      },
    });

    expect(body).toContain('<svg');
    expect(body).toContain('Redham');
    expect(body).toContain('port-anchor');
    expect(body).toContain('Coldwood');
    expect(body).toContain('Hidden Keep');
    expect(body).toContain('County of Redham');
    // One county covers every visible hex, so its label is kept and the realm label that would pile on it is dropped.
    expect(body).not.toContain('Kingdom of Ficengwind');
    expect(body).toContain('Realm Of Poss — what the party knows; the rest is fog.');
  });

  it('draws a duchy border and its name', () => {
    const { body } = render(RegionMap, {
      props: {
        map: map({
          hexes: [hex(0, 0), hex(1, 0)],
          duchies: [
            { id: 1, name: 'Duchy of Ash', border: [{ from: 'q0_r0', to: 'q1_r0' }], hexes: ['q0_r0', 'q1_r0'] },
          ],
        }),
      },
    });

    expect(body).toContain('duchy-border');
    expect(body).toContain('Duchy of Ash');
  });

  it('leaves an unnamed county unlabelled', () => {
    const { body } = render(RegionMap, {
      props: {
        map: map({
          hexes: [hex(0, 0, 0)],
          counties: [{ name: null, realm: 0 }],
          realms: [{ name: 'Kingdom of Ficengwind' }],
        }),
      },
    });

    expect(body).toContain('Kingdom of Ficengwind');
    expect(body).not.toContain('region-label county');
  });
});
