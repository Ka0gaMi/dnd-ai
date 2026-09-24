// Faith identities for a living world replay from a seed, one image per aspect, and dissent that never
// repeats its parent. SRD 5.2.1 names no pantheon, so all of this is procedural.
import { beforeAll, describe, expect, it, vi } from 'vitest';

let faithIdentity: (typeof import('../src/core/faith-names.js'))['faithIdentity'];
let heresyName: (typeof import('../src/core/faith-names.js'))['heresyName'];
let FAITH_ASPECTS: (typeof import('../src/core/faith-names.js'))['FAITH_ASPECTS'];
let seededRng: (typeof import('../src/core/dice.js'))['seededRng'];
let mixSeed: (typeof import('../src/core/dice.js'))['mixSeed'];

beforeAll(async () => {
  // With isolate: false a prior file in this worker may have cached dice.ts under its own mock, so
  // reload the modules here to get the real generator.
  vi.resetModules();
  ({ faithIdentity, heresyName, FAITH_ASPECTS } = await import('../src/core/faith-names.js'));
  ({ seededRng, mixSeed } = await import('../src/core/dice.js'));
});

describe('FAITH_ASPECTS', () => {
  it('lists around ten aspects, each with a deity, a symbol and name forms', () => {
    expect(FAITH_ASPECTS.length).toBeGreaterThanOrEqual(8);
    expect(FAITH_ASPECTS.length).toBeLessThanOrEqual(12);
    for (const entry of FAITH_ASPECTS) {
      expect(entry.deity.trim()).not.toBe('');
      expect(entry.symbol.trim()).not.toBe('');
      expect(entry.nameForms.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses no named or trademarked deities, only generic titles', () => {
    for (const entry of FAITH_ASPECTS) {
      expect(entry.deity.toLowerCase()).toMatch(/^the /);
    }
  });
});

describe('faithIdentity determinism', () => {
  it('replays the same identity for the same seed', () => {
    expect(faithIdentity(seededRng(42))).toEqual(faithIdentity(seededRng(42)));
  });

  it('gives at least three distinct names over twenty seeds', () => {
    const names = new Set(
      Array.from({ length: 20 }, (_value, i) => faithIdentity(seededRng(mixSeed(2024, i))).name),
    );
    expect(names.size).toBeGreaterThanOrEqual(3);
  });

  it('returns a complete identity with no unfilled placeholders', () => {
    for (let i = 0; i < 50; i += 1) {
      const identity = faithIdentity(seededRng(mixSeed(11, i)));
      expect(identity.name.trim()).not.toBe('');
      expect(identity.name).not.toMatch(/[{}]/);
      expect(identity.aspect.trim()).not.toBe('');
      expect(identity.deity.trim()).not.toBe('');
      expect(identity.symbol.trim()).not.toBe('');
    }
  });

  it('only ever names aspects from the catalog', () => {
    const aspects = new Set(FAITH_ASPECTS.map((entry) => entry.aspect));
    for (let i = 0; i < 50; i += 1) {
      expect(aspects.has(faithIdentity(seededRng(mixSeed(13, i))).aspect)).toBe(true);
    }
  });
});

describe('heresyName', () => {
  it('differs from the parent and is deterministic', () => {
    for (let i = 0; i < 20; i += 1) {
      const parent = faithIdentity(seededRng(mixSeed(5, i)));
      const first = heresyName(parent, seededRng(mixSeed(6, i)));
      const second = heresyName(parent, seededRng(mixSeed(6, i)));
      expect(first).toBe(second);
      expect(first).not.toBe(parent.name);
      expect(first).not.toMatch(/[{}]/);
    }
  });

  it('accepts a bare name and aspect', () => {
    const name = heresyName({ name: 'the Faith of the Dawnfather', aspect: 'sun' }, seededRng(3));
    expect(name).not.toBe('the Faith of the Dawnfather');
    expect(name).not.toMatch(/[{}]/);
  });

  it('strips the article and Faith-of/Church-of prefix for short parent forms', () => {
    const results = Array.from({ length: 100 }, (_value, i) =>
      heresyName({ name: 'the Church of the Silver Lady', aspect: 'moon' }, seededRng(mixSeed(9, i))),
    );
    expect(results.find((name) => name.startsWith('the Reformed '))).toBe('the Reformed Silver Lady');
  });
});
