import { describe, expect, it } from 'vitest';
import { mixSeed, rngInt, rngPick, seededRng } from '../src/core/dice.js';

describe('seededRng', () => {
  it('replays the same sequence for the same seed', () => {
    const first = seededRng(42);
    const second = seededRng(42);
    const a = Array.from({ length: 5 }, () => first());
    const b = Array.from({ length: 5 }, () => second());
    expect(a).toEqual(b);
  });

  it('gives different sequences for different seeds', () => {
    const a = Array.from({ length: 5 }, seededRng(1));
    const b = Array.from({ length: 5 }, seededRng(2));
    expect(a).not.toEqual(b);
  });

  it('stays in [0, 1)', () => {
    const rng = seededRng(123456);
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('mixSeed', () => {
  it('is deterministic and order-sensitive', () => {
    expect(mixSeed(1, 2, 3)).toBe(mixSeed(1, 2, 3));
    expect(mixSeed(1, 2, 3)).not.toBe(mixSeed(3, 2, 1));
  });

  it('tells a negative part from its unsigned twin', () => {
    expect(mixSeed(-1)).not.toBe(mixSeed(4294967295));
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const seed of [mixSeed(), mixSeed(-1), mixSeed(1, 2, 3), mixSeed(4294967295)]) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('rngInt', () => {
  it('stays in range and reaches every face', () => {
    const rng = seededRng(mixSeed(7, 100));
    const faces = new Set<number>();
    for (let i = 0; i < 10_000; i += 1) {
      const value = rngInt(rng, 1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      faces.add(value);
    }
    expect([...faces].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('throws on an inverted range', () => {
    expect(() => rngInt(seededRng(1), 3, 1)).toThrow();
  });
});

describe('rngPick', () => {
  it('picks the same element for the same seed', () => {
    const items = ['a', 'b', 'c', 'd'] as const;
    const first = Array.from({ length: 5 }, () => rngPick(seededRng(9), items));
    const second = Array.from({ length: 5 }, () => rngPick(seededRng(9), items));
    expect(first).toEqual(second);
  });

  it('throws on an empty array', () => {
    expect(() => rngPick(seededRng(1), [])).toThrow();
  });
});

describe('golden sequence', () => {
  it('pins the first three values of seededRng(mixSeed(7, 100))', () => {
    expect(mixSeed(7, 100)).toBe(446833525);
    const rng = seededRng(mixSeed(7, 100));
    expect([rng(), rng(), rng()]).toEqual([
      0.21498831966891885, 0.21501185512170196, 0.8894286337308586,
    ]);
  });
});
