// People for a living world replay from a seed: names by sex and culture, house names, traits and
// epithets. Everything is procedural, so the same seed always gives the same person.
import { beforeAll, describe, expect, it, vi } from 'vitest';

type PersonModule = typeof import('../src/core/person-names.js');

let personName: PersonModule['personName'];
let houseName: PersonModule['houseName'];
let cultureFor: PersonModule['cultureFor'];
let pickTraits: PersonModule['pickTraits'];
let epithetFor: PersonModule['epithetFor'];
let TRAITS: PersonModule['TRAITS'];
let seededRng: (typeof import('../src/core/dice.js'))['seededRng'];
let mixSeed: (typeof import('../src/core/dice.js'))['mixSeed'];

beforeAll(async () => {
  // With isolate: false a prior file in this worker may have cached dice.ts under its own mock, so
  // reload the modules here to get the real generator.
  vi.resetModules();
  ({ personName, houseName, cultureFor, pickTraits, epithetFor, TRAITS } = await import('../src/core/person-names.js'));
  ({ seededRng, mixSeed } = await import('../src/core/dice.js'));
});

const CULTURES = ['highland', 'lowland', 'coastal', 'tribal'] as const;
const SEXES = ['male', 'female'] as const;

describe('personName', () => {
  it('replays the same name for the same seed', () => {
    for (const culture of CULTURES) {
      for (const sex of SEXES) {
        expect(personName(seededRng(42), sex, culture)).toBe(personName(seededRng(42), sex, culture));
      }
    }
  });

  it('gives at least fifteen distinct names per culture and sex over forty seeds', () => {
    for (const culture of CULTURES) {
      for (const sex of SEXES) {
        const names = new Set(
          Array.from({ length: 40 }, (_value, i) => personName(seededRng(mixSeed(2024, i)), sex, culture)),
        );
        expect(names.size).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('uses only letters, a hyphen or an apostrophe, and starts capitalised', () => {
    for (const culture of CULTURES) {
      for (let i = 0; i < 50; i += 1) {
        for (const sex of SEXES) {
          const name = personName(seededRng(mixSeed(7, i)), sex, culture);
          expect(name).toMatch(/^[A-Za-z]+(?:['-][A-Za-z]+)*$/);
          expect(name[0]).toBe(name[0]!.toUpperCase());
        }
      }
    }
  });
});

describe('houseName', () => {
  it('replays the same house for the same seed', () => {
    for (const culture of CULTURES) {
      expect(houseName(seededRng(42), culture)).toBe(houseName(seededRng(42), culture));
    }
  });

  it('uses only letters and starts capitalised', () => {
    for (const culture of CULTURES) {
      for (let i = 0; i < 50; i += 1) {
        const house = houseName(seededRng(mixSeed(9, i)), culture);
        expect(house).toMatch(/^[A-Za-z]+$/);
        expect(house[0]).toBe(house[0]!.toUpperCase());
      }
    }
  });
});

describe('TRAITS', () => {
  it('lists sixteen distinct traits', () => {
    expect(TRAITS).toHaveLength(16);
    expect(new Set(TRAITS).size).toBe(16);
  });
});

describe('pickTraits', () => {
  it('returns the requested number of distinct traits', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(pickTraits(seededRng(mixSeed(3, i)), 1)).toHaveLength(1);
      const two = pickTraits(seededRng(mixSeed(4, i)), 2);
      expect(two).toHaveLength(2);
      expect(new Set(two).size).toBe(2);
    }
  });

  it('never returns both sides of an opposing pair', () => {
    const pairs: Array<[string, string]> = [
      ['bold', 'craven'],
      ['cruel', 'gentle'],
      ['just', 'cruel'],
      ['honourable', 'cunning'],
    ];
    for (let i = 0; i < 500; i += 1) {
      const two = pickTraits(seededRng(mixSeed(5, i)), 2);
      for (const [a, b] of pairs) expect(two.includes(a) && two.includes(b)).toBe(false);
    }
  });

  it('is deterministic', () => {
    expect(pickTraits(seededRng(11), 2)).toEqual(pickTraits(seededRng(11), 2));
  });
});

describe('epithetFor', () => {
  it('maps a trait to its epithet', () => {
    expect(epithetFor(['bold'], seededRng(1))).toBe('the Bold');
    expect(epithetFor(['cruel'], seededRng(1))).toBe('the Cruel');
    expect(epithetFor(['wise'], seededRng(1))).toBe('the Wise');
  });

  it('falls back to a neutral epithet when no trait maps', () => {
    const epithet = epithetFor([], seededRng(1));
    expect(epithet).toMatch(/^the [A-Z][a-z]+$/);
    expect(epithet).not.toBe('the Bold');
  });

  it('is deterministic', () => {
    expect(epithetFor(['bold', 'wise'], seededRng(2))).toBe(epithetFor(['bold', 'wise'], seededRng(2)));
  });
});

describe('cultureFor', () => {
  it('makes every tribe tribal', () => {
    expect(cultureFor([], null, false, 'tribe')).toBe('tribal');
    expect(cultureFor([], 'mountain', true, 'tribe')).toBe('tribal');
  });

  it('makes a coastal seat coastal', () => {
    expect(cultureFor([], null, true, 'kingdom')).toBe('coastal');
    expect(cultureFor([], 'mountain', true, 'kingdom')).toBe('coastal');
  });

  it('makes highland terrain or the highland tag highland', () => {
    expect(cultureFor([], 'mountain', false, 'kingdom')).toBe('highland');
    expect(cultureFor([], 'rocks', false, 'lordship')).toBe('highland');
    expect(cultureFor([], 'forest-dark', false, 'free_city')).toBe('highland');
    expect(cultureFor(['highland'], null, false, 'kingdom')).toBe('highland');
  });

  it('falls back to lowland', () => {
    expect(cultureFor([], 'plains', false, 'kingdom')).toBe('lowland');
    expect(cultureFor([], null, false, 'free_city')).toBe('lowland');
    expect(cultureFor(['coastal'], null, false, 'lordship')).toBe('lowland');
  });
});
