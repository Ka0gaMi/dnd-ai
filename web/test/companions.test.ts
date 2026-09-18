import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Companions from '../src/components/Companions.svelte';
import { closeCompanionSheet, companionSheet, openCompanionSheet } from '../src/lib/companionSheet.svelte';
import type { PartyMember } from '../src/lib/types';

const member = (over: Partial<PartyMember> = {}): PartyMember => ({
  id: 6,
  name: 'Bramble',
  role: 'companion',
  class: 'Fighter',
  creature: null,
  level: 3,
  hp_current: 18,
  hp_max: 24,
  temp_hp: 0,
  ac: 16,
  status: 'active',
  conditions: null,
  inspiration: 0,
  portrait_path: null,
  ...over,
});

beforeEach(closeCompanionSheet);
afterEach(closeCompanionSheet);

describe('Companions', () => {
  it('renders each row as a button that opens the sheet dialog', () => {
    const { body } = render(Companions, { props: { companions: [member()] } });
    expect(body).toMatch(/<button[^>]*aria-haspopup="dialog"/);
    // The row keeps its look: the name, the HP and the bar are all inside the button.
    expect(body).toContain('Bramble');
    expect(body).toContain('18 / 24');
  });

  it('opening a companion stores its id for the overlay', () => {
    expect(companionSheet.id).toBeNull();
    openCompanionSheet(6);
    expect(companionSheet.id).toBe(6);
  });
});
