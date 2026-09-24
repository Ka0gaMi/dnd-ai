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
  'crusade',
  'persecute',
  'raise_cathedral',
  'seize_church_lands',
];

describe('the faction agenda templates', () => {
  it('holds exactly the twelve known templates, each id once', () => {
    expect(AGENDA_TEMPLATES).toHaveLength(12);
    expect(AGENDA_TEMPLATES.map((t) => t.id)).toEqual(IDS);
    expect(new Set(AGENDA_TEMPLATES.map((t) => t.id)).size).toBe(12);
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
      expect.arrayContaining(['conversion', 'hunt_monster', 'build', 'crusade', 'persecute', 'raise_cathedral']),
    );
    expect(templatesFor('realm').map((t) => t.id)).toEqual(
      expect.arrayContaining(['expand_territory', 'build', 'seize_church_lands']),
    );
  });

  it('gives the faith templates their runners, target rules and clocks', () => {
    const byId = new Map(AGENDA_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get('crusade')).toMatchObject({ runners: ['church'], target: 'danger', clock_size: 6 });
    expect(byId.get('persecute')).toMatchObject({ runners: ['church'], target: 'heresy', clock_size: 6 });
    expect(byId.get('raise_cathedral')).toMatchObject({
      runners: ['church'],
      target: 'own_seat',
      clock_size: 8,
    });
    expect(byId.get('seize_church_lands')).toMatchObject({
      runners: ['realm'],
      target: 'church_in_realm',
      clock_size: 6,
    });
  });

  it('uses only the faction, target and place placeholders', () => {
    for (const t of AGENDA_TEMPLATES) {
      for (const text of [...t.portents, t.on_win.text]) {
        for (const match of text.matchAll(/\{(\w+)\}/g)) {
          expect(['faction', 'target', 'place']).toContain(match[1]);
        }
      }
    }
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
