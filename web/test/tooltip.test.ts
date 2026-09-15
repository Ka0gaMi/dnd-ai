import { describe, expect, it } from 'vitest';
import { tooltipPosition } from '../src/lib/tooltip';

const VIEW = { width: 1000, height: 800 };
const TIP = { width: 200, height: 100 };
const anchor = (left: number, top: number) => ({ left, right: left + 60, top, bottom: top + 20 });

describe('tooltip placement', () => {
  it('sits under the trigger, left edges lined up', () => {
    expect(tooltipPosition(anchor(100, 200), TIP, VIEW)).toEqual({
      left: 100,
      top: 224,
      flippedX: false,
      flippedY: false,
    });
  });

  it('hangs off the right edge of the trigger when the window runs out to the right', () => {
    const placed = tooltipPosition(anchor(900, 200), TIP, VIEW);
    expect(placed.flippedX).toBe(true);
    expect(placed.left).toBe(760);
    expect(placed.left + TIP.width).toBeLessThanOrEqual(VIEW.width - 8);
  });

  it('goes above the trigger when there is no room below', () => {
    const placed = tooltipPosition(anchor(100, 740), TIP, VIEW);
    expect(placed.flippedY).toBe(true);
    expect(placed.top).toBe(636);
  });

  it('stays below and slides up when flipping would run off the top instead', () => {
    const placed = tooltipPosition(anchor(100, 60), { width: 200, height: 760 }, VIEW);
    expect(placed.flippedY).toBe(false);
    expect(placed.top).toBe(32);
  });

  it('never leaves the window', () => {
    const placed = tooltipPosition(anchor(-40, -30), TIP, VIEW);
    expect(placed.left).toBe(8);
    expect(placed.top).toBe(8);
  });
});
