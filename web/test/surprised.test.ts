// Surprise only costs Disadvantage on initiative, so the tag lasts until the combatant's first turn ends.
import { describe, expect, it } from 'vitest';
import { surprisedIds } from '../src/lib/combat.svelte';
import type { CombatLogEntry } from '../src/lib/types';

let nextId = 1;
const entry = (kind: string, actor_id: number, payload: Record<string, unknown> = {}): CombatLogEntry => ({
  id: nextId++,
  round: 1,
  actor_id,
  target_id: null,
  kind,
  payload,
  text: '',
  ts: '2026-10-30T00:00:00.000Z',
});

// The window holds its log newest-first.
const window = (...chronological: CombatLogEntry[]): CombatLogEntry[] => [...chronological].reverse();

describe('surprisedIds', () => {
  it('tags a combatant after initiative and through its own first turn', () => {
    const log = window(entry('initiative', 1, { surprised: true }), entry('initiative', 2), entry('turn_start', 1));
    expect([...surprisedIds(log)]).toEqual([1]);
  });

  it('clears the tag once its turn has ended', () => {
    const log = window(entry('initiative', 1, { surprised: true }), entry('turn_start', 1), entry('turn_end', 1));
    expect(surprisedIds(log).size).toBe(0);
  });

  it('keeps the tag of a surprised creature whose turn has not come yet', () => {
    const log = window(
      entry('initiative', 1, { surprised: true }),
      entry('initiative', 2, { surprised: true }),
      entry('turn_end', 1),
    );
    expect([...surprisedIds(log)]).toEqual([2]);
  });

  it('tags a late joiner from its own initiative entry', () => {
    const log = window(entry('initiative', 1), entry('turn_end', 1), entry('initiative', 3, { surprised: true }));
    expect([...surprisedIds(log)]).toEqual([3]);
  });

  it('starts clean for a later encounter, whose log the window holds on its own', () => {
    expect(surprisedIds(window(entry('initiative', 5), entry('turn_start', 5))).size).toBe(0);
  });
});
