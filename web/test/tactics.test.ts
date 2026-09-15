import { describe, expect, it, vi } from 'vitest';
import { TacticsCache, tacticsLine, type Tactics } from '../src/lib/tactics';

const tactics = (over: Partial<Tactics> = {}): Tactics => ({
  distance_ft: 45,
  line_of_sight: true,
  cover: 'half',
  in_reach: false,
  in_range: { normal: true, long: true },
  path_cost_ft: 45,
  ...over,
});

describe('tactics line', () => {
  it('reads as one plain sentence', () => {
    expect(tacticsLine(tactics())).toBe('45 ft · line of sight · half cover · in range');
  });

  it('says when the shot is blocked, long or within reach', () => {
    expect(tacticsLine(tactics({ line_of_sight: false, cover: 'total' }))).toContain('no line of sight');
    expect(tacticsLine(tactics({ cover: 'none', in_reach: true }))).toBe(
      '45 ft · line of sight · no cover · in reach',
    );
    expect(tacticsLine(tactics({ in_range: { normal: false, long: true } }))).toContain('at long range');
    expect(tacticsLine(tactics({ in_range: { normal: false, long: false } }))).toContain('out of range');
    expect(tacticsLine(tactics({ in_range: null }))).toContain('no weapon to measure');
  });
});

describe('TacticsCache', () => {
  it('asks once per pair and answers the rest from memory', async () => {
    const cache = new TacticsCache();
    const load = vi.fn(async () => tactics());
    expect(await cache.lookup(1, 10, 20, load)).toEqual(tactics());
    expect(await cache.lookup(1, 10, 20, load)).toEqual(tactics());
    expect(cache.cached(1, 10, 20)).toEqual(tactics());
    expect(load).toHaveBeenCalledTimes(1);

    await cache.lookup(1, 10, 21, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('forgets everything once the fight moves on', async () => {
    const cache = new TacticsCache();
    const load = vi.fn(async () => tactics());
    await cache.lookup(1, 10, 20, load);
    expect(cache.cached(2, 10, 20)).toBeNull();
    await cache.lookup(2, 10, 20, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('answers null when the lookup fails and does not remember the failure', async () => {
    const cache = new TacticsCache();
    const failing = vi.fn(async () => {
      throw new Error('404');
    });
    expect(await cache.lookup(1, 10, 20, failing)).toBeNull();
    expect(cache.cached(1, 10, 20)).toBeNull();
  });
});
