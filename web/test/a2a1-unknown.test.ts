import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CharacterSheet from '../src/components/CharacterSheet.svelte';
import { splitHint } from '../src/lib/combat.svelte';
import type { Pc } from '../src/lib/types';

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
