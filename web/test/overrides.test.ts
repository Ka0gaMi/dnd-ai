import { describe, expect, it } from 'vitest';
import { handSetDot, isHandSet, overridePatch } from '../src/lib/overrides';

describe('sheet overrides', () => {
  it('sends the number the player typed', () => {
    expect(overridePatch('ac', ' 18 ')).toEqual({ patch: { ac: 18 } });
    expect(overridePatch('initiative_bonus', '-1')).toEqual({ patch: { initiative_bonus: -1 } });
  });

  it('clears the field when the box is left empty', () => {
    expect(overridePatch('gold', '')).toEqual({ patch: { gold: null } });
    expect(overridePatch('gold', '   ')).toEqual({ patch: { gold: null } });
  });

  it('refuses anything that is not a whole number', () => {
    expect(overridePatch('speed', '30.5')).toEqual({ error: 'Whole numbers only' });
    expect(overridePatch('speed', 'fast')).toEqual({ error: 'Whole numbers only' });
  });

  it('accepts exhaustion from 0 to 6 and refuses outside that range', () => {
    expect(overridePatch('exhaustion', '0')).toEqual({ patch: { exhaustion: 0 } });
    expect(overridePatch('exhaustion', '6')).toEqual({ patch: { exhaustion: 6 } });
    expect(overridePatch('exhaustion', '7')).toEqual({ error: 'Must be 0–6' });
    expect(overridePatch('exhaustion', '-1')).toEqual({ error: 'Must be 0–6' });
  });

  it('knows which tiles the player set by hand', () => {
    expect(isHandSet(['ac', 'gold'], 'ac')).toBe(true);
    expect(isHandSet(['ac'], 'speed')).toBe(false);
    expect(isHandSet(undefined, 'ac')).toBe(false);
  });

  it('shows a clearable button for a hand-set tile only in cheat mode', () => {
    expect(handSetDot(true, ['ac'], 'ac')).toBe('button');
    expect(handSetDot(false, ['ac'], 'ac')).toBe('marker');
  });

  it('shows nothing for a tile that was never hand-set', () => {
    expect(handSetDot(true, ['ac'], 'speed')).toBe('none');
    expect(handSetDot(false, undefined, 'ac')).toBe('none');
  });
});
