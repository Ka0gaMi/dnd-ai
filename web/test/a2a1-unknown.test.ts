import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CharacterSheet from '../src/components/CharacterSheet.svelte';
import CombatantCard from '../src/components/CombatantCard.svelte';
import Companions from '../src/components/Companions.svelte';
import { splitHint } from '../src/lib/combat.svelte';
import { tokenTooltip } from '../src/lib/mapkey';
import type { Combatant, PartyMember, Pc } from '../src/lib/types';

const pc = (over: Partial<Pc> = {}): Pc => ({
  id: 1,
  name: 'Borg',
  class: 'Fighter',
  level: 1,
  hp_current: 13,
  hp_max: 13,
  ac: 18,
  ac_breakdown: { total: 18, armor: 'Chain Mail', shield: true, feature_bonus: 0, magic_bonus: 0, notes: [] },
  ...over,
});

/** The PC on the battle map, as the player's battle state sends it. */
const borg = (over: Partial<Combatant> = {}): Combatant => ({
  id: 1,
  kind: 'pc',
  character_id: 1,
  name: 'Borg',
  team: 'party',
  initiative: 12,
  initiative_order: 0,
  x: 3,
  y: 5,
  size: 'M',
  hp_current: 13,
  hp_max: 13,
  temp_hp: 0,
  ac: 18,
  ac_unknown: true,
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
  hp_fraction: 1,
  distance_ft: null,
  marker: 'B',
  known: null,
  inspiration: 0,
  exhaustion: 0,
  portrait_path: null,
  ...over,
});

const rook = (over: Partial<PartyMember> = {}): PartyMember => ({
  id: 6,
  name: 'Rook',
  role: 'companion',
  class: 'Fighter',
  creature: null,
  level: 1,
  hp_current: 12,
  hp_max: 12,
  temp_hp: 0,
  ac: 17,
  ac_unknown: true,
  status: 'active',
  conditions: [],
  inspiration: 0,
  portrait_path: null,
  ...over,
});

/** The AC vital's own cell, so a stray "+?" elsewhere on the sheet cannot pass for it. */
const acCell = (body: string): string => />AC<\/button>[\s\S]*?<dd class="num[^"]*">([\s\S]*?)<\/dd>/.exec(body)?.[1] ?? '';

describe('an unidentified bonus on the sheet', () => {
  it('shows the AC the server sent with "+?" beside it, and the masked breakdown line', () => {
    const { body } = render(CharacterSheet, {
      props: {
        pc: pc({
          ac_unknown: true,
          ac_breakdown: {
            total: 18,
            armor: 'Chain Mail',
            shield: true,
            feature_bonus: 0,
            magic_bonus: 0,
            notes: ['Unidentified shield: +? AC'],
          },
        }),
      },
    });
    expect(acCell(body)).toContain('18 +?');
    expect(body).toContain('Unidentified shield: +? AC');
  });

  it('shows a plain AC when nothing is unknown', () => {
    const { body } = render(CharacterSheet, { props: { pc: pc({ ac: 19 }) } });
    expect(acCell(body)).toContain('19');
    expect(acCell(body)).not.toContain('+?');
  });
});

describe('an unidentified bonus on an attack hint', () => {
  it('keeps "+5 +? to hit" and "1d8+3 +?" whole when the caveat is split off', () => {
    const said = splitHint('+5 +? to hit, 1d8+3 +? slashing, reach 5 ft. Not proficient: no proficiency bonus.');
    expect(said.hint).toBe('+5 +? to hit, 1d8+3 +? slashing, reach 5 ft.');
    expect(said.caveat).toBe('Not proficient: no proficiency bonus.');
  });
});

describe('an unidentified bonus on the battle screen and the party list', () => {
  it('shows "18 +?" on the combatant card and in the token tooltip', () => {
    const { body } = render(CombatantCard, { props: { combatant: borg(), visibility: 'full', campaignId: 1 } });
    expect(acCell(body)).toBe('18 +?');
    expect(tokenTooltip(borg(), { visibility: 'full' })).toContain('AC 18 +?');
  });

  it('shows a plain AC on the card and the tooltip when nothing is unknown', () => {
    const plain = borg({ ac: 19, ac_unknown: undefined });
    const { body } = render(CombatantCard, { props: { combatant: plain, visibility: 'full', campaignId: 1 } });
    expect(acCell(body)).toBe('19');
    expect(tokenTooltip(plain, { visibility: 'full' })).toContain('AC 19');
    expect(tokenTooltip(plain, { visibility: 'full' }).join(' ')).not.toContain('+?');
  });

  it('shows "AC 17 +?" on a companion row, and a plain AC once nothing is unknown', () => {
    expect(render(Companions, { props: { companions: [rook()] } }).body).toMatch(/AC\s*<span class="num[^"]*">17 \+\?<\/span>/);
    const plain = render(Companions, { props: { companions: [rook({ ac: 18, ac_unknown: undefined })] } }).body;
    expect(plain).toMatch(/AC\s*<span class="num[^"]*">18<\/span>/);
  });
});
