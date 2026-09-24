import { describe, expect, it } from 'vitest';
import { AGENDA_TEMPLATES, fillText, templatesFor } from '../src/core/agenda-templates.js';

const IDS = [
  'expand_territory',
  'raid',
  'trade_monopoly',
  'conversion',
  'hunt_monster',
  'build',
  'feud',
  'monsters_grow',
];

describe('the faction agenda templates', () => {
  it('holds exactly the eight known templates, each id once', () => {
    expect(AGENDA_TEMPLATES).toHaveLength(8);
    expect(AGENDA_TEMPLATES.map((t) => t.id)).toEqual(IDS);
    expect(new Set(AGENDA_TEMPLATES.map((t) => t.id)).size).toBe(8);
  });

  it('gives every template 3-5 short portents that fit its clock', () => {
    for (const t of AGENDA_TEMPLATES) {
      expect(t.portents.length).toBeGreaterThanOrEqual(3);
      expect(t.portents.length).toBeLessThanOrEqual(5);
      expect(t.portents.length).toBeLessThanOrEqual(t.clock_size);
      expect([4, 6, 8]).toContain(t.clock_size);
      for (const portent of t.portents) expect(portent.length).toBeLessThanOrEqual(90);
    }
  });

  it('picks the templates a faction type may run, in catalogue order', () => {
    expect(templatesFor('monsters').map((t) => t.id)).toEqual(['raid', 'monsters_grow']);
    expect(templatesFor('off_map')).toEqual([]);
    expect(templatesFor('church').map((t) => t.id)).toEqual(
      expect.arrayContaining(['conversion', 'hunt_monster', 'build']),
    );
  });

  it('marks only monsters_grow as irreversible', () => {
    const irreversible = AGENDA_TEMPLATES.filter((t) => t.on_win.irreversible).map((t) => t.id);
    expect(irreversible).toEqual(['monsters_grow']);
  });

  it('fills every placeholder and falls back place to target', () => {
    expect(fillText('{faction} raids {target}', { faction: 'Red Claw', target: 'Millford' })).toBe(
      'Red Claw raids Millford',
    );
    expect(fillText('{place} and {target}', { faction: 'X', target: 'Millford' })).toBe(
      'Millford and Millford',
    );
    expect(fillText('{place}', { faction: 'X', target: 'Millford', place: 'the ford' })).toBe('the ford');
    for (const t of AGENDA_TEMPLATES) {
      for (const portent of t.portents) {
        expect(fillText(portent, { faction: 'Red Claw', target: 'Millford' })).not.toContain('{');
      }
    }
  });
});
