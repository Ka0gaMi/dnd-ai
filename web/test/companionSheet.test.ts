import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import CompanionSheet from '../src/components/CompanionSheet.svelte';
import {
  closeCompanionSheet,
  companionSheet,
  loadCompanionSheet,
  openCompanionSheet,
  syncCompanionSheet,
} from '../src/lib/companionSheet.svelte';
import type { Pc, Snapshot } from '../src/lib/types';

const sheet = (over: Partial<Pc> = {}): Pc => ({
  id: 6,
  name: 'Bramble',
  class: 'Fighter',
  level: 3,
  hp_current: 18,
  hp_max: 24,
  ac: 16,
  ...over,
});

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  campaign: { id: 1, name: 'Ashfall', story_shape: 'sandbox', premise: null },
  session: { id: 1, number: 1, started_at: '2026-09-10T10:00:00.000Z' },
  last_recap: null,
  current_scene: null,
  previous_scene: null,
  pc: null,
  open_quests: [],
  canon_facts: [],
  recent_events: [],
  glossary_terms: [],
  events_since_checkpoint: 0,
  ...over,
});

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(closeCompanionSheet);
afterEach(() => {
  closeCompanionSheet();
  vi.unstubAllGlobals();
});

describe('CompanionSheet', () => {
  it('renders the companion name and its sheet once loaded', async () => {
    mockFetch(200, sheet());
    openCompanionSheet(6);
    await loadCompanionSheet();

    const { body } = render(CompanionSheet, { props: {} });
    expect(body).toContain('Bramble');
    expect(body).toContain('18 / 24');
    expect(body).toContain('Close');
    // Exactly one character sheet is rendered inside the dialog.
    expect(body.match(/aria-label="Hit points"/g)).toHaveLength(1);
    // Read-only: no hand-set pencils or clear button, and the player's own level-up never shows here.
    expect(body).not.toMatch(/aria-label="Hand-set/);
    expect(body).not.toContain('Level up available');
    expect(body).not.toContain('ask the DM to prepare');
  });

  it('ignores a response for a companion that is no longer the open one', async () => {
    openCompanionSheet(6);
    const pending = loadCompanionSheet();
    closeCompanionSheet();
    mockFetch(200, sheet());
    await pending;
    expect(companionSheet.sheet).toBeNull();
  });

  it('closing resets the store', async () => {
    mockFetch(200, sheet());
    openCompanionSheet(6);
    await loadCompanionSheet();
    expect(companionSheet.sheet?.name).toBe('Bramble');

    closeCompanionSheet();
    expect(companionSheet.id).toBeNull();
    expect(companionSheet.sheet).toBeNull();
    expect(companionSheet.error).toBeNull();
  });

  it('shows the error line when the fetch fails', async () => {
    mockFetch(404, { error: 'no such character' });
    openCompanionSheet(6);
    await loadCompanionSheet();

    const { body } = render(CompanionSheet, { props: {} });
    expect(body).toContain('/api/characters/6/sheet -> 404');
  });

  it('refetches when a fresh snapshot arrives while the sheet is open', async () => {
    const fetch = mockFetch(200, sheet());
    openCompanionSheet(6);

    const first = snapshot();
    await syncCompanionSheet(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/characters/6/sheet');

    // The same snapshot object is not a change.
    await syncCompanionSheet(first);
    expect(fetch).toHaveBeenCalledTimes(1);

    await syncCompanionSheet(snapshot({ pc: sheet() }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
