import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CombatantCard from '../src/components/CombatantCard.svelte';
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
  hp_current: 0,
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
  alive: false,
  footprint: 1,
  armor_penalty: false,
  hp_fraction: 0,
  distance_ft: 10,
  marker: 'g',
  known: null,
  inspiration: null,
  exhaustion: null,
  portrait_path: null,
  ...over,
});

describe('the combatant card', () => {
  it('calls a combatant that is not alive Dead, never Down', () => {
    const body = render(CombatantCard, {
      props: { combatant: combatant(), visibility: 'full', campaignId: 1 },
    }).body;
    expect(body).toContain('Dead');
    expect(body).not.toContain('Down');
  });
});
