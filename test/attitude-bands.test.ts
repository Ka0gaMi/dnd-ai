import { describe, expect, it } from 'vitest';
import { ATTITUDE_BANDS, attitudeBand } from '../src/core/attitude-bands.js';
import { regardLabel } from '../web/src/lib/world.js';

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

  it('agrees with the window regardLabel for every total from -10 to +10', () => {
    for (let total = -10; total <= 10; total += 1) {
      expect(attitudeBand(total)).toBe(regardLabel(total));
    }
  });

  it('exports every band name it can return', () => {
    expect(ATTITUDE_BANDS).toEqual(['hostile', 'wary', 'neutral', 'friendly', 'devoted']);
    for (const total of [-10, -2, 0, 2, 6]) {
      expect(ATTITUDE_BANDS).toContain(attitudeBand(total));
    }
  });
});
