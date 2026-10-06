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
  'revolt',
];

describe('the faction agenda templates', () => {
  it('holds exactly the thirteen known templates, each id once', () => {
    expect(AGENDA_TEMPLATES).toHaveLength(13);
    expect(AGENDA_TEMPLATES.map((t) => t.id)).toEqual(IDS);
    expect(new Set(AGENDA_TEMPLATES.map((t) => t.id)).size).toBe(13);
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
      expect.arrayContaining([
        'expand_territory',
        'build',
        'crusade',
        'persecute',
        'raise_cathedral',
        'seize_church_lands',
      ]),
    );
  });

  it('gives the faith templates their runners, target rules and clocks', () => {
    const byId = new Map(AGENDA_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get('crusade')).toMatchObject({ runners: ['church', 'realm'], target: 'danger', clock_size: 6 });
    expect(byId.get('persecute')).toMatchObject({
      runners: ['church', 'realm'],
      target: 'heresy',
      clock_size: 6,
    });
    expect(byId.get('raise_cathedral')).toMatchObject({
      runners: ['church', 'realm'],
      target: 'own_seat',
      clock_size: 8,
    });
    expect(byId.get('seize_church_lands')).toMatchObject({
      runners: ['realm'],
      target: 'church_in_realm',
      clock_size: 6,
    });
  });

  it('lets only realms expand, while a house or vassal realm may revolt against its liege', () => {
    const byId = new Map(AGENDA_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get('expand_territory')).toMatchObject({ runners: ['realm'], target: 'neighbour_county' });
    expect(byId.get('revolt')).toMatchObject({ label: 'Revolt', runners: ['house', 'realm'], target: 'liege', clock_size: 8 });
    expect(templatesFor('house').map((t) => t.id)).not.toContain('expand_territory');
    expect(templatesFor('house').map((t) => t.id)).toContain('revolt');
  });

  it('uses only the faction, target and place placeholders', () => {
    for (const t of AGENDA_TEMPLATES) {
      for (const text of [...t.portents, t.on_win.text, ...Object.values(t.on_win.variants ?? {})]) {
        for (const match of text.matchAll(/\{(\w+)\}/g)) {
          expect(['faction', 'target', 'place']).toContain(match[1]);
        }
      }
    }
  });

  it('words a win with no map state so it claims no change to the map', () => {
    const byId = new Map(AGENDA_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get('build')!.on_win.text).toBe('{faction} pours its coin into works in {target}');
    expect(byId.get('trade_monopoly')!.on_win.text).toBe('{faction} undercuts {target} in every market');
    expect(byId.get('raise_cathedral')!.on_win.text).toBe("Pilgrims flock to {faction}'s cathedral works in {target}");
    expect(byId.get('crusade')!.on_win.text).toBe('{faction} crusaders strike at {target}');
    expect(byId.get('persecute')!.on_win.text).toBe('{faction} hounds the followers of {target}');
    // The stronger claims are kept for the outcomes that write them.
    expect(byId.get('expand_territory')!.on_win.variants).toHaveProperty('border_victory');
    expect(byId.get('monsters_grow')!.on_win.variants).toEqual({ ruined: '{faction} overruns {target}' });
    expect(byId.get('revolt')!.on_win.variants).toEqual({ concessions: '{faction} wrings concessions from {target}' });
    const claims = /completes|consecrates|forces .* out of|takes control|overruns|purge|underground|turns to the faith/;
    const plain = ['build', 'trade_monopoly', 'raise_cathedral', 'feud', 'hunt_monster', 'crusade', 'persecute', 'monsters_grow'];
    for (const id of plain) expect(byId.get(id)!.on_win.text, id).not.toMatch(claims);
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
