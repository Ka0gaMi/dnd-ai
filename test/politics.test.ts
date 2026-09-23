import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hexDistance } from '../src/core/region-graph.js';
import {
  computePolitics,
  countyOfHex,
  hexNeighbours,
  type ComputedPolitics,
  type PoliticsHex,
  type PoliticsInput,
  type PoliticsSettlement,
} from '../src/core/politics.js';

interface RawHex {
  q: number;
  r: number;
  terrain?: string;
  town?: { name: string; type: 'village' | 'town' | 'city' };
}

interface RawRealm {
  name: string;
  hexes: Record<string, RawHex>;
}

const safe = JSON.parse(
  readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8'),
) as RawRealm;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as RawRealm;

function toInput(raw: RawRealm): PoliticsInput {
  const hexes: PoliticsHex[] = Object.entries(raw.hexes).map(([id, cell]) => ({
    id,
    q: cell.q,
    r: cell.r,
    terrain: cell.terrain ?? 'plains',
  }));
  const settlements: PoliticsSettlement[] = [];
  for (const [id, cell] of Object.entries(raw.hexes)) {
    if (!cell.town) continue;
    settlements.push({
      place_id: settlements.length + 1,
      name: cell.town.name,
      size: cell.town.type,
      hex: id,
    });
  }
  return { region_name: raw.name, hexes, settlements };
}

function seatId(input: PoliticsInput, name: string): number {
  const seat = input.settlements.find((settlement) => settlement.name === name);
  if (!seat) throw new Error(`No settlement named ${name}`);
  return seat.place_id;
}

function countInCounties(politics: ComputedPolitics, hex: string): number {
  return politics.counties.filter((county) => county.hexes.includes(hex)).length;
}

describe('hexNeighbours', () => {
  it('returns six neighbours one step away on an even row', () => {
    const centre = { q: 4, r: 4 };
    const neighbours = hexNeighbours(centre.q, centre.r);

    expect(neighbours).toHaveLength(6);
    for (const neighbour of neighbours) {
      expect(hexDistance(centre, neighbour)).toBe(1);
    }
  });

  it('returns six neighbours one step away on an odd row', () => {
    const centre = { q: 4, r: 5 };
    const neighbours = hexNeighbours(centre.q, centre.r);

    expect(neighbours).toHaveLength(6);
    for (const neighbour of neighbours) {
      expect(hexDistance(centre, neighbour)).toBe(1);
    }
  });
});

describe('computePolitics on the safe realm', () => {
  const input = toInput(safe);
  const politics = computePolitics(input);

  it('grows two counties, one per town or city seat', () => {
    expect(politics.counties.map((county) => county.name)).toEqual([
      'County of Redham',
      'County of Ficengwind',
    ]);
    expect(politics.counties.map((county) => county.hexes.length)).toEqual([67, 102]);
  });

  it('puts both counties under the single city kingdom', () => {
    expect(politics.realms).toEqual([
      { name: 'Kingdom of Ficengwind', capital_place_id: seatId(input, 'Ficengwind') },
    ]);
    expect(politics.counties.map((county) => county.realm)).toEqual([0, 0]);
  });

  it('assigns every land hex to exactly one county and no water hex to any', () => {
    for (const hex of input.hexes) {
      const expected = hex.terrain === 'water' ? 0 : 1;
      expect(countInCounties(politics, hex.id)).toBe(expected);
    }
  });

  it('places the villages in the county that grew past them', () => {
    expect(countyOfHex(politics, 'q9_r5')).toBe(politics.counties.findIndex((c) => c.name === 'County of Redham'));
    const ficengwind = politics.counties.findIndex((c) => c.name === 'County of Ficengwind');
    expect(countyOfHex(politics, 'q12_r11')).toBe(ficengwind);
    expect(countyOfHex(politics, 'q11_r14')).toBe(ficengwind);
  });

  it('is deterministic', () => {
    expect(computePolitics(input)).toEqual(computePolitics(input));
  });
});

describe('computePolitics on the dangerous realm', () => {
  const input = toInput(dangerous);
  const politics = computePolitics(input);

  it('grows one county per village seat', () => {
    expect(politics.counties.map((county) => county.name)).toEqual([
      'County of Frostcot',
      'County of Crimson Wharf',
    ]);
    expect(politics.counties.map((county) => county.hexes.length)).toEqual([29, 50]);
  });

  it('folds every county into one nameless-capital realm', () => {
    expect(politics.realms).toEqual([{ name: 'Ta Isle', capital_place_id: null }]);
    expect(politics.counties.map((county) => county.realm)).toEqual([0, 0]);
  });
});

describe('computePolitics on a synthetic strip', () => {
  it('ignores the village when a town is present and grows one county', () => {
    const hexes: PoliticsHex[] = [0, 1, 2, 3, 4].map((q) => ({
      id: `q${q}_r0`,
      q,
      r: 0,
      terrain: 'plains',
    }));
    const settlements: PoliticsSettlement[] = [
      { place_id: 1, name: 'Hamlet', size: 'village', hex: 'q0_r0' },
      { place_id: 2, name: 'Bigton', size: 'town', hex: 'q4_r0' },
    ];
    const politics = computePolitics({ region_name: 'The Strip', hexes, settlements });

    expect(politics.counties).toEqual([
      {
        name: 'County of Bigton',
        seat_place_id: 2,
        realm: 0,
        hexes: ['q0_r0', 'q1_r0', 'q2_r0', 'q3_r0', 'q4_r0'],
      },
    ]);
    expect(politics.realms).toEqual([{ name: 'The Strip', capital_place_id: null }]);
  });
});
