// The fight-log chips read whatever AC or DC the server sent: with the table's DCs hidden there is none,
// and the chip shows just the roll instead of "undefined".
import { describe, expect, it } from 'vitest';
import { fightLogChips } from '../src/lib/combat.svelte';
import type { CombatLogEntry } from '../src/lib/types';

const entry = (kind: string, payload: Record<string, unknown>): CombatLogEntry => ({
  id: 1,
  round: 1,
  actor_id: 1,
  target_id: 2,
  kind,
  payload,
  text: '',
  ts: '2026-10-30T00:00:00.000Z',
});

const labels = (kind: string, payload: Record<string, unknown>): string[] =>
  fightLogChips(entry(kind, payload)).map((chip) => chip.label);

describe('fight-log chips under dc_disclosure', () => {
  it('names the AC an attack was made against when the server sends it, and only the roll when it does not', () => {
    const swing = { roll: { total: 17, natural: 12 }, hit: true };
    expect(labels('attack', { ...swing, effective_ac: 15 })).toEqual(['17 vs AC 15', 'Hit']);
    expect(labels('attack', swing)).toEqual(['17', 'Hit']);
  });

  it('names the DC of a save, a grapple and a shove only when the server sends it', () => {
    const shown = { total: 12, dc: 13, ability: 'dex', success: false };
    const { dc, ...hidden } = shown;
    void dc;
    expect(labels('save', { save: shown })).toEqual(['12 vs DC 13 DEX', 'Failed']);
    expect(labels('save', { save: hidden })).toEqual(['12 DEX', 'Failed']);
    expect(labels('concentration', { save: hidden })).toEqual(['12 DEX', 'Failed']);
    expect(labels('shove', { save: hidden, applied: true, prone: true })).toEqual(['12 DEX', 'Knocked prone']);

    expect(labels('grapple', { save: { ...shown, ability: 'str' }, applied: true, escape_dc: 13 })).toEqual([
      '12 vs DC 13 STR',
      'Grappled',
      'Escape DC 13',
    ]);
    expect(labels('grapple', { save: { ...hidden, ability: 'str' }, applied: true })).toEqual(['12 STR', 'Grappled']);
  });

  it('never renders "undefined" for an entry with its AC and DC taken out', () => {
    const stripped = [
      entry('attack', { roll: { total: 9, natural: 9 }, hit: false, cover: 'none' }),
      entry('save', { save: { total: 4, ability: 'con', success: false } }),
      entry('grapple', { save: { total: 4, ability: 'dex', success: false }, applied: true }),
      entry('shove', { save: { total: 4, ability: 'str', success: true }, applied: false }),
    ];
    const all = stripped.flatMap((e) => fightLogChips(e).map((chip) => chip.label)).join(' | ');
    expect(all).not.toMatch(/undefined|vs AC|vs DC|DC \d/);
  });
});
