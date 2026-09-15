import { describe, expect, it } from 'vitest';
import { itemWeightLabel, loadBar } from '../src/lib/encumbrance';

describe('loadBar', () => {
  it('is good under 80% of capacity', () => {
    expect(loadBar(100, 255)).toMatchObject({ tone: 'good' });
    expect(loadBar(203, 255).tone).toBe('good');
  });

  it('warns from 80% up to capacity', () => {
    expect(loadBar(204, 255).tone).toBe('warn');
    expect(loadBar(255, 255).tone).toBe('warn');
  });

  it('is bad over capacity', () => {
    expect(loadBar(256, 255).tone).toBe('bad');
  });

  it('clamps the fill width at 100% even when over capacity', () => {
    expect(loadBar(500, 255).percent).toBe(100);
  });

  it('is good with nothing carried and no capacity known', () => {
    expect(loadBar(0, 0)).toEqual({ percent: 0, tone: 'good' });
  });
});

describe('itemWeightLabel', () => {
  it('shows the weight in pounds', () => {
    expect(itemWeightLabel({ weight_lb: 3 })).toBe('3 lb');
    expect(itemWeightLabel({ weight_lb: 0.5 })).toBe('0.5 lb');
  });

  it('shows a dash when the weight is unknown', () => {
    expect(itemWeightLabel({ weight_lb: 0, notes: 'weight unknown' })).toBe('—');
    expect(itemWeightLabel({ weight_lb: 0, notes: 'a trinket; weight unknown' })).toBe('—');
    expect(itemWeightLabel({})).toBe('—');
  });

  it('treats a known zero weight as a real weight', () => {
    expect(itemWeightLabel({ weight_lb: 0, notes: 'a feather' })).toBe('0 lb');
  });
});
