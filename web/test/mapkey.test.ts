import { describe, expect, it } from 'vitest';
import {
  LEGEND_ITEMS,
  distanceFt,
  featureNotes,
  terrainWord,
  tokenTooltip,
  woundWord,
} from '../src/lib/mapkey';
import type { Combatant, MapFeature } from '../src/lib/types';

const feature = (over: Partial<MapFeature> = {}): MapFeature => ({
  x: 2,
  y: 3,
  w: 2,
  h: 2,
  kind: 'pillars',
  label: 'Pillars (full cover)',
  ...over,
});

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
  hp_max: 8,
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
  hp_fraction: 0.5,
  distance_ft: 10,
  marker: 'g',
  known: null,
  inspiration: null,
  exhaustion: null,
  portrait_path: null,
  ...over,
});

describe('featureNotes', () => {
  it('numbers the features and words them from the kind', () => {
    const notes = featureNotes([feature(), feature({ kind: 'rubble', label: 'Rubble (difficult terrain)' })]);
    expect(notes).toEqual([
      { index: 1, name: 'Pillars', text: 'blocks movement and sight (full cover)' },
      { index: 2, name: 'Rubble', text: 'difficult terrain (double cost)' },
    ]);
  });

  it('matches a compound or singular kind on its last word', () => {
    expect(featureNotes([feature({ kind: 'stone_pillar' })])[0]).toEqual({
      index: 1,
      name: 'Stone pillar',
      text: 'blocks movement and sight (full cover)',
    });
  });

  it('words fire and water the way the fight needs them', () => {
    expect(featureNotes([feature({ kind: 'fire' })])[0]?.text).toBe(
      'burning, ongoing fire damage if entered',
    );
    expect(featureNotes([feature({ kind: 'river' })])[0]?.text).toBe('difficult, may need a swim');
  });

  it('falls back to the label for a kind it does not know', () => {
    expect(featureNotes([feature({ kind: 'shrine', label: 'Old shrine (difficult terrain)' })])[0]).toEqual({
      index: 1,
      name: 'Shrine',
      text: 'Old shrine (difficult terrain)',
    });
  });

  it('still says something when neither kind nor label helps', () => {
    expect(featureNotes([feature({ kind: '', label: '' })])[0]).toEqual({
      index: 1,
      name: 'Feature',
      text: 'feature on the map',
    });
  });
});

describe('LEGEND_ITEMS', () => {
  it('lists every fill and token state the map draws, in drawing order', () => {
    expect(LEGEND_ITEMS.map((item) => item.key)).toEqual([
      'open',
      'difficult',
      'blocked',
      'reach',
      'party',
      'enemy',
      'active',
      'down',
      'attack',
    ]);
    expect(LEGEND_ITEMS.map((item) => item.text)).toEqual([
      'Open',
      'Difficult (dotted)',
      'Blocked (hatched)',
      'Reachable this turn',
      'Party (circle)',
      'Enemy (square)',
      'Active (brass ring)',
      'Down (struck marker)',
      'Last attack (line)',
    ]);
  });
});

describe('terrainWord', () => {
  it('names the three cell kinds', () => {
    expect(terrainWord('.')).toBe('Open ground');
    expect(terrainWord('~')).toBe('Difficult ground, double cost');
    expect(terrainWord('#')).toBe('Blocked, full cover');
  });
});

describe('woundWord', () => {
  it('grades a fraction the way the HP bar tones do', () => {
    expect(woundWord(1)).toBe('Unhurt');
    expect(woundWord(0.6)).toBe('Lightly wounded');
    expect(woundWord(0.5)).toBe('Lightly wounded');
    expect(woundWord(0.3)).toBe('Bloodied');
    expect(woundWord(0.1)).toBe('Near death');
    expect(woundWord(0)).toBe('Down');
  });
});

describe('distanceFt', () => {
  it('measures between footprints, diagonals counting as one step', () => {
    expect(distanceFt(combatant({ x: 1, y: 1 }), combatant({ id: 2, x: 4, y: 3 }))).toBe(15);
    expect(distanceFt(combatant({ x: 1, y: 1 }), combatant({ id: 2, x: 2, y: 2 }))).toBe(5);
    expect(distanceFt(combatant({ x: 1, y: 1, footprint: 2 }), combatant({ id: 2, x: 3, y: 1 }))).toBe(5);
  });
});

describe('tokenTooltip', () => {
  const pc = combatant({ id: 9, kind: 'pc', name: 'Rowan', team: 'party', x: 1, y: 1 });

  it('shows numbers, AC and distances for the party', () => {
    const lines = tokenTooltip(combatant({ id: 3, name: 'Wolf', team: 'party', x: 3, y: 1 }), {
      visibility: 'hidden',
      pc,
      active: pc,
    });
    expect(lines).toEqual(['4 / 8 HP', 'AC 15', 'Speed 30 ft · 30 ft left', '10 ft from Rowan']);
  });

  it('words an enemy wound at bars and hides its AC and speed', () => {
    const lines = tokenTooltip(combatant({ x: 4, y: 1, hp_fraction: 0.3 }), {
      visibility: 'bars',
      pc,
      active: combatant({ id: 3, name: 'Wolf', team: 'party', x: 2, y: 1 }),
    });
    expect(lines).toEqual(['Bloodied', '15 ft from Rowan', '10 ft from Wolf']);
  });

  it('says only Bloodied at hidden, and Down once it is over', () => {
    expect(tokenTooltip(combatant({ hp_fraction: 0.3 }), { visibility: 'hidden' })).toEqual(['Bloodied']);
    expect(tokenTooltip(combatant({ alive: false, hp_fraction: 0 }), { visibility: 'full' })).toEqual([
      'Down',
      'AC 15',
      'Speed 30 ft · 30 ft left',
    ]);
  });

  it('adds conditions and concentration', () => {
    const lines = tokenTooltip(
      combatant({ conditions: ['Prone'], concentration: { name: 'Bless' }, hp_fraction: 0.3 }),
      { visibility: 'hidden' },
    );
    expect(lines).toEqual(['Bloodied', 'Prone', 'Concentrating: Bless']);
  });

  it('appends the cover and range line the tactics endpoint answers with', () => {
    const lines = tokenTooltip(combatant({ hp_fraction: 0.3 }), {
      visibility: 'hidden',
      tactics: {
        distance_ft: 20,
        line_of_sight: true,
        cover: 'half',
        in_reach: false,
        in_range: { normal: false, long: false },
        path_cost_ft: 20,
      },
    });
    expect(lines).toEqual(['Bloodied', '20 ft · line of sight · half cover · out of range']);
  });
});
