import { describe, expect, it } from 'vitest';
import { ATTITUDE_BANDS, attitudeBand } from '../src/core/attitude-bands.js';

// web/test/world.test.ts pins the window's regardLabel to the same boundaries.
describe('attitudeBand', () => {
  it('names each boundary and its neighbours', () => {
    expect(attitudeBand(-10)).toBe('hostile');
    expect(attitudeBand(-6)).toBe('hostile');
    expect(attitudeBand(-5)).toBe('wary');
    expect(attitudeBand(-2)).toBe('wary');
    expect(attitudeBand(-1)).toBe('neutral');
    expect(attitudeBand(1)).toBe('neutral');
    expect(attitudeBand(2)).toBe('friendly');
    expect(attitudeBand(5)).toBe('friendly');
    expect(attitudeBand(6)).toBe('devoted');
    expect(attitudeBand(10)).toBe('devoted');
  });

  it('exports every band name it can return', () => {
    expect(ATTITUDE_BANDS).toEqual(['hostile', 'wary', 'neutral', 'friendly', 'devoted']);
    for (const total of [-10, -2, 0, 2, 6]) {
      expect(ATTITUDE_BANDS).toContain(attitudeBand(total));
    }
  });
});
