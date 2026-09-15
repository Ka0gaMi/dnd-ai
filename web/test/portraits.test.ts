import { describe, expect, it } from 'vitest';
import { portraitFor } from '../src/lib/portraits.svelte';
import type { Combatant } from '../src/lib/types';

const combatant = (over: Partial<Combatant> = {}): Combatant => ({
  id: 1,
  kind: 'monster',
  character_id: null,
  name: 'Goblin',
  team: 'enemy',
  initiative: 12,
  initiative_order: 1,
  x: 1,
  y: 1,
  size: 'S',
  hp_current: 4,
  hp_max: 7,
  temp_hp: 0,
  ac: 15,
  speed: 30,
  conditions: [],
  flags: {},
  concentration: null,
  death_saves: { successes: 0, failures: 0 },
  movement_left: 30,
  action_used: false,
  bonus_used: false,
  reaction_used: false,
  visible: true,
  alive: true,
  footprint: 1,
  armor_penalty: false,
  hp_fraction: 4 / 7,
  distance_ft: 10,
  marker: 'g',
  known: null,
  inspiration: null,
  exhaustion: null,
  portrait_path: null,
  ...over,
});

describe('portraitFor', () => {
  it('prefers the combatant\'s own portrait_path', () => {
    const c = combatant({ portrait_path: '/portraits/goblin-2.png' });
    expect(portraitFor(c, () => '/portraits/fallback.png')).toBe('/portraits/goblin-2.png');
  });

  it('falls back to the lookup when portrait_path is null', () => {
    const c = combatant({ portrait_path: null });
    expect(portraitFor(c, () => '/portraits/fallback.png')).toBe('/portraits/fallback.png');
  });

  it('passes the combatant through to the lookup', () => {
    const c = combatant({ portrait_path: null, name: 'Goblin Boss' });
    expect(portraitFor(c, (found) => found.name)).toBe('Goblin Boss');
  });

  it('stays null when neither the path nor the lookup has one', () => {
    const c = combatant({ portrait_path: null });
    expect(portraitFor(c, () => null)).toBeNull();
  });
});
