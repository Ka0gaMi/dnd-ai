import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import {
  boundCounty,
  computeControl,
  seatStrength,
  type ControlBand,
  type ControlOptions,
  type ControlSeat,
  type HexControl,
} from '../src/core/politics-control.js';
import { politicsInputFromDb } from '../src/core/politics-input.js';
import { computeHierarchyParts, type HierarchyParts } from '../src/core/politics.js';
import type { PoliticsHex, PoliticsInput } from '../src/core/politics-types.js';
import { importRegion } from '../src/core/region.js';
import { openDb } from '../src/db/connection.js';

const line = (terrains: string[]): PoliticsHex[] =>
  terrains.map((terrain, q) => ({ id: `q${q}_r0`, q, r: 0, terrain }));

const plains = (count: number): string[] => Array.from({ length: count }, () => 'plains');

const ids = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, index) => `q${from + index}_r0`);

function region(hexes: PoliticsHex[], extra: Partial<PoliticsInput> = {}): PoliticsInput {
  return {
    region_name: 'Line',
    tags: [],
    hexes,
    settlements: [],
    strongholds: [],
    roads: [],
    areas: [],
    edge_hexes: [],
    ...extra,
  };
}

function seat(hex: string, extra: Partial<ControlSeat> = {}): ControlSeat {
  return { place_id: 1, hex, kind: 'town', realm: 0, county: 0, capital: false, march: false, ...extra };
}

const oneCounty: ControlOptions = { claims: [], claimOf: () => 0 };

function along<K extends keyof HexControl>(control: Map<string, HexControl>, count: number, key: K): Array<HexControl[K]> {
  return Array.from({ length: count }, (_, q) => control.get(`q${q}_r0`)![key]);
}

/** Two towns of different realms facing each other along a nine-hex plains line. */
function facingTowns(): { input: PoliticsInput; seats: ControlSeat[] } {
  return {
    input: region(line(plains(9))),
    seats: [seat('q0_r0'), seat('q8_r0', { place_id: 2, realm: 1, county: 1 })],
  };
}

const splitAt = (last: number) => (hex: string): number => (Number(/^q(\d+)_/.exec(hex)![1]) <= last ? 0 : 1);

describe('computeControl on synthetic lines', () => {
  it('drops a town by 10 per plains hex through every band', () => {
    const control = computeControl(region(line(plains(10))), [seat('q0_r0')], oneCounty);

    expect(along(control, 10, 'control')).toEqual([80, 70, 60, 50, 40, 30, 20, 10, 0, 0]);
    expect(along(control, 10, 'band')).toEqual<ControlBand[]>([
      'core', 'core', 'held', 'held', 'held', 'frontier', 'frontier', 'wild', 'wild', 'wild',
    ]);
    expect(along(control, 10, 'realm')).toEqual(new Array(10).fill(0));
    expect(along(control, 10, 'rival')).toEqual(new Array(10).fill(null));
  });

  it('halves the cost along a road, so core ends exactly at 65', () => {
    const control = computeControl(region(line(plains(10)), { roads: [ids(0, 9)] }), [seat('q0_r0')], oneCounty);

    expect(along(control, 10, 'control')).toEqual([80, 75, 70, 65, 60, 55, 50, 45, 40, 35]);
    expect(along(control, 10, 'band')).toEqual<ControlBand[]>([
      'core', 'core', 'core', 'core', 'held', 'held', 'held', 'held', 'held', 'frontier',
    ]);
  });

  it('collapses control across mountains', () => {
    const input = region(line(['plains', 'mountain', 'mountain', 'plains']));
    const capital = computeControl(input, [seat('q0_r0', { capital: true })], oneCounty);
    const town = computeControl(input, [seat('q0_r0')], oneCounty);

    expect(along(capital, 4, 'control')).toEqual([100, 60, 20, 10]);
    expect(along(capital, 4, 'band')).toEqual<ControlBand[]>(['core', 'held', 'frontier', 'wild']);
    expect(along(town, 4, 'control')).toEqual([80, 40, 0, 0]);
    expect(along(town, 4, 'band')).toEqual<ControlBand[]>(['core', 'held', 'wild', 'wild']);
  });

  it('lets a capital hold to cost 6 where a castle holds only to cost 3', () => {
    const input = region(line(plains(10)));
    const capital = computeControl(input, [seat('q0_r0', { kind: 'city', capital: true })], oneCounty);
    const castle = computeControl(input, [seat('q0_r0', { kind: 'castle' })], oneCounty);

    expect(along(capital, 10, 'band')).toEqual<ControlBand[]>([
      'core', 'core', 'core', 'core', 'held', 'held', 'held', 'frontier', 'frontier', 'wild',
    ]);
    expect(along(castle, 10, 'band')).toEqual<ControlBand[]>([
      'core', 'held', 'held', 'held', 'frontier', 'frontier', 'wild', 'wild', 'wild', 'wild',
    ]);
  });

  it('rates seats by kind, capital and march', () => {
    expect(seatStrength({ kind: 'city', capital: false, march: false })).toBe(90);
    expect(seatStrength({ kind: 'town', capital: false, march: false })).toBe(80);
    expect(seatStrength({ kind: 'castle', capital: false, march: false })).toBe(70);
    expect(seatStrength({ kind: 'castle', capital: true, march: false })).toBe(100);
    expect(seatStrength({ kind: 'town', capital: false, march: true })).toBe(90);
    expect(seatStrength({ kind: 'city', capital: true, march: true })).toBe(110);
  });

  it('extends a march seat one hex further', () => {
    const control = computeControl(region(line(plains(8))), [seat('q0_r0', { march: true })], oneCounty);

    expect(along(control, 8, 'control')).toEqual([90, 80, 70, 60, 50, 40, 30, 20]);
    expect(control.get('q5_r0')!.band).toBe('held');
  });

  it('takes 10 off every seat in a wild or dangerous region, once', () => {
    const hexes = line(plains(3));
    const at = (input: PoliticsInput, options: ControlOptions = oneCounty): number[] =>
      along(computeControl(input, [seat('q0_r0')], options), 3, 'control');

    expect(at(region(hexes, { tags: ['wild'] }))).toEqual([70, 60, 50]);
    expect(at(region(hexes, { tags: ['dangerous'] }))).toEqual([70, 60, 50]);
    expect(at(region(hexes, { tags: ['wild', 'chaotic', 'dangerous'] }))).toEqual([70, 60, 50]);
    expect(at(region(hexes, { tags: ['civilized'] }))).toEqual([80, 70, 60]);
    expect(at(region(hexes, { tags: ['wild'] }), { ...oneCounty, tagModifier: 0 })).toEqual([80, 70, 60]);
  });

  it('applies a per-seat modifier by place id', () => {
    const input = region(line(plains(3)), { tags: ['wild'] });
    const raided = computeControl(input, [seat('q0_r0')], { ...oneCounty, seatModifiers: new Map([[1, -20]]) });
    const elsewhere = computeControl(input, [seat('q0_r0')], { ...oneCounty, seatModifiers: new Map([[9, -20]]) });

    expect(along(raided, 3, 'control')).toEqual([50, 40, 30]);
    expect(along(elsewhere, 3, 'control')).toEqual([70, 60, 50]);
  });

  it('keeps the best seat of the owning realm', () => {
    const input = region(line(plains(9)));
    const control = computeControl(
      input,
      [seat('q0_r0'), seat('q8_r0', { place_id: 2, county: 1, kind: 'castle' })],
      { claims: [], claimOf: splitAt(4) },
    );

    expect(along(control, 9, 'control')).toEqual([80, 70, 60, 50, 40, 40, 50, 60, 70]);
    expect(along(control, 9, 'rival')).toEqual(new Array(9).fill(null));
  });
});

describe('contested land', () => {
  it('is contested where a rival at 20 or more comes within 15 of the owner or above', () => {
    const { input, seats } = facingTowns();
    const control = computeControl(input, seats, { claims: [], claimOf: splitAt(5) });

    expect(control.get('q2_r0')).toEqual({ realm: 0, control: 60, band: 'held', rival: null });
    expect(control.get('q3_r0')).toEqual({ realm: 0, control: 50, band: 'held', rival: null });
    expect(control.get('q4_r0')).toEqual({ realm: 0, control: 40, band: 'contested', rival: 1 });
    expect(control.get('q5_r0')).toEqual({ realm: 0, control: 30, band: 'contested', rival: 1 });
    expect(control.get('q6_r0')).toEqual({ realm: 1, control: 60, band: 'held', rival: null });
  });

  it('never counts a rival under 20, however weak the owner', () => {
    const input = region(line(plains(16)));
    const seats = [seat('q0_r0'), seat('q15_r0', { place_id: 2, realm: 1, county: 1 })];
    const control = computeControl(input, seats, { claims: [], claimOf: () => 0 });

    expect(control.get('q8_r0')).toEqual({ realm: 0, control: 0, band: 'wild', rival: null });
    expect(control.get('q9_r0')).toEqual({ realm: 0, control: 0, band: 'contested', rival: 1 });
  });

  it('is contested where a claimant on the county reaches 20', () => {
    const { input, seats } = facingTowns();
    const claimOf = splitAt(4);
    const plain = computeControl(input, seats, { claims: [], claimOf });
    const claimed = computeControl(input, seats, { claims: [{ county: 1, claimant_realm: 0 }], claimOf });

    expect(plain.get('q5_r0')).toEqual({ realm: 1, control: 50, band: 'held', rival: null });
    expect(plain.get('q6_r0')).toEqual({ realm: 1, control: 60, band: 'held', rival: null });
    expect(claimed.get('q5_r0')).toEqual({ realm: 1, control: 50, band: 'contested', rival: 0 });
    expect(claimed.get('q6_r0')).toEqual({ realm: 1, control: 60, band: 'contested', rival: 0 });
    expect(claimed.get('q7_r0')).toEqual({ realm: 1, control: 70, band: 'core', rival: null });
    expect(claimed.get('q4_r0')).toEqual(plain.get('q4_r0'));
  });

  it('gives unclaimed land to the strongest realm and leaves unreached land wild and ownerless', () => {
    const input = region([
      ...line(plains(9)),
      { id: 'q10_r0', q: 10, r: 0, terrain: 'water' },
      { id: 'q11_r0', q: 11, r: 0, terrain: 'plains' },
    ]);
    const { seats } = facingTowns();
    const control = computeControl(input, seats, { claims: [], claimOf: () => null });

    expect(control.get('q2_r0')).toEqual({ realm: 0, control: 60, band: 'held', rival: null });
    expect(control.get('q4_r0')).toEqual({ realm: 0, control: 40, band: 'contested', rival: 1 });
    expect(control.get('q6_r0')).toEqual({ realm: 1, control: 60, band: 'held', rival: null });
    expect(control.has('q10_r0')).toBe(false);
    expect(control.get('q11_r0')).toEqual({ realm: null, control: 0, band: 'wild', rival: null });
    expect(control.size).toBe(10);
  });

  it('is deterministic', () => {
    const { input, seats } = facingTowns();
    const options: ControlOptions = { claims: [{ county: 1, claimant_realm: 0 }], claimOf: splitAt(4) };
    expect(computeControl(input, seats, options)).toEqual(computeControl(input, seats, options));
  });
});

describe('boundCounty', () => {
  it('keeps core and held land, the seat and bound villages', () => {
    const input = region(line(plains(10)), {
      settlements: [
        { place_id: 1, name: 'Seat', size: 'town', hex: 'q0_r0', coast: false },
        { place_id: 2, name: 'Far End', size: 'village', hex: 'q9_r0', coast: false },
      ],
    });
    const control = computeControl(input, [seat('q0_r0')], oneCounty);
    const county = { hexes: ids(0, 9), seat_place_id: 1, village_place_ids: [2] };

    expect(boundCounty(input, county, control)).toEqual([...ids(0, 4), 'q9_r0']);
  });

  it('keeps contested land only where the owner holds 40 or more', () => {
    const { input, seats } = facingTowns();
    const control = computeControl(input, seats, { claims: [], claimOf: splitAt(5) });
    const west = { hexes: ids(0, 5), seat_place_id: 1, village_place_ids: [] };

    expect(control.get('q5_r0')!.band).toBe('contested');
    expect(boundCounty(input, west, control)).toEqual(ids(0, 4));
  });

  it('keeps a stronghold seat even when its own hex falls below held', () => {
    const input = region(line(plains(4)), { strongholds: [{ place_id: 1, name: 'Keep', hex: 'q0_r0' }] });
    const control = computeControl(input, [seat('q0_r0', { kind: 'castle' })], {
      ...oneCounty,
      seatModifiers: new Map([[1, -50]]),
    });

    expect(control.get('q0_r0')!.band).toBe('frontier');
    expect(boundCounty(input, { hexes: ids(0, 3), seat_place_id: 1, village_place_ids: [] }, control)).toEqual([
      'q0_r0',
    ]);
  });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

function inputFrom(name: string): PoliticsInput {
  const db = openDb(':memory:');
  const campaignId = createCampaign(db, { name: 'Control', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, fixture(name), { source: 'generated' });
  return politicsInputFromDb(db, campaignId)!;
}

/** The seats, claims and legal claim lookup a computed hierarchy implies. */
function controlFor(input: PoliticsInput, parts: HierarchyParts): { seats: ControlSeat[]; options: ControlOptions } {
  const hexOf = new Map([...input.settlements, ...input.strongholds].map((place) => [place.place_id, place.hex]));
  const march = new Set(parts.hierarchy.march_counties);
  const seats = parts.counties.counties.map((county, index): ControlSeat => {
    const realm = parts.realms.county_realm[index];
    return {
      place_id: county.seat_place_id,
      hex: hexOf.get(county.seat_place_id)!,
      kind: county.seat_kind,
      realm,
      county: index,
      capital: parts.realms.realms[realm].capital_place_id === county.seat_place_id,
      march: march.has(index),
    };
  });
  const claim = new Map<string, number>();
  parts.counties.counties.forEach((county, index) => county.hexes.forEach((hex) => claim.set(hex, index)));
  return { seats, options: { claims: parts.hierarchy.claims, claimOf: (hex) => claim.get(hex) ?? null } };
}

const bandFor = (value: number): ControlBand =>
  value >= 65 ? 'core' : value >= 40 ? 'held' : value >= 20 ? 'frontier' : 'wild';

describe('computeControl on the stored fixtures', () => {
  it('large: bands land close to the planned split', () => {
    const input = inputFrom('realm-large.json');
    const parts = computeHierarchyParts(input);
    const { seats, options } = controlFor(input, parts);
    const control = computeControl(input, seats, options);
    const land = input.hexes.filter((hex) => hex.terrain !== 'water');

    expect(control.size).toBe(land.length);
    const share = (bands: ControlBand[]): number =>
      [...control.values()].filter((entry) => bands.includes(entry.band)).length / control.size;
    // Measured 2026-10-05: core 16.5%, held 22.8%, frontier 19.4%, contested 4.7%, wild 36.6%.
    expect(share(['core', 'held'])).toBeGreaterThan(0.33);
    expect(share(['core', 'held'])).toBeLessThan(0.5);
    expect(share(['frontier'])).toBeGreaterThan(0.12);
    expect(share(['frontier'])).toBeLessThan(0.27);
    expect(share(['contested'])).toBeGreaterThan(0.01);
    expect(share(['contested'])).toBeLessThan(0.1);
    expect(share(['wild'])).toBeGreaterThan(0.28);
    expect(share(['wild'])).toBeLessThan(0.45);

    for (const [hex, entry] of control) {
      const county = options.claimOf(hex);
      expect(county).not.toBeNull();
      expect(entry.realm).toBe(parts.realms.county_realm[county!]);
      if (entry.band === 'contested') expect(entry.rival).not.toBe(entry.realm);
      else expect(entry.band).toBe(bandFor(entry.control));
      if (entry.band !== 'contested') expect(entry.rival).toBeNull();
    }
    for (const capital of seats.filter((entry) => entry.capital)) {
      expect(control.get(capital.hex)!.control).toBeGreaterThanOrEqual(100);
    }

    let bounded = 0;
    parts.counties.counties.forEach((county, index) => {
      const hexes = boundCounty(input, county, control);
      expect(hexes).toContain(seats[index].hex);
      const allowed = new Set([...county.hexes, seats[index].hex]);
      for (const hex of hexes) expect(allowed.has(hex)).toBe(true);
      bounded += hexes.length;
    });
    expect(bounded / land.length).toBeGreaterThan(0.35);
    expect(bounded / land.length).toBeLessThan(0.5);

    expect(computeControl(input, seats, options)).toEqual(control);
  });

  it('dangerous: the region tags weaken the lone capital by 10', () => {
    const input = inputFrom('realm-dangerous.json');
    const parts = computeHierarchyParts(input);
    const { seats, options } = controlFor(input, parts);
    const control = computeControl(input, seats, options);

    expect(seats).toHaveLength(1);
    expect(seats[0].capital).toBe(true);
    expect(control.get(seats[0].hex)!.control).toBe(90);
    expect([...control.values()].some((entry) => entry.band === 'wild')).toBe(true);
  });
});
