import { afterEach, describe, expect, it, vi } from 'vitest';
import { namesToFetch, spellDetail, wantSpellDetails } from '../src/lib/spellDetails.svelte';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('namesToFetch', () => {
  it('keeps only the names not already asked for, in order and without repeats', () => {
    const asked = new Set(['Fire Bolt']);
    expect(namesToFetch(['Fire Bolt', 'Shield', 'Shield', 'Light'], asked)).toEqual(['Shield', 'Light']);
  });

  it('drops blank names and returns nothing once every name has been asked for', () => {
    expect(namesToFetch(['', 'Shield'], new Set(['Shield']))).toEqual([]);
  });
});

describe('wantSpellDetails', () => {
  it('fetches only the names not already cached, and caches what comes back', async () => {
    mockFetch(200, { details: { Shield: { name: 'Shield', level: 1, short_text: 'Blocks a hit.' } } });
    await wantSpellDetails(['Shield']);
    expect(spellDetail('Shield')).toEqual({ name: 'Shield', level: 1, short_text: 'Blocks a hit.' });
    expect(fetch).toHaveBeenCalledTimes(1);

    await wantSpellDetails(['Shield']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caches a name the server did not know about as null, not as a retry', async () => {
    mockFetch(200, { details: {} });
    await wantSpellDetails(['Made Up Spell']);
    expect(spellDetail('Made Up Spell')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    await wantSpellDetails(['Made Up Spell']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('forgets having asked when the request fails, so the next snapshot retries', async () => {
    mockFetch(500, {});
    await wantSpellDetails(['Fireball']);
    expect(spellDetail('Fireball')).toBeNull();

    mockFetch(200, { details: { Fireball: { name: 'Fireball', level: 3, short_text: 'A ball of fire.' } } });
    await wantSpellDetails(['Fireball']);
    expect(spellDetail('Fireball')?.level).toBe(3);
  });
});
