import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, boostRoll, getTownMap, rewindCampaign, undoCombat } from '../src/lib/api';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('undoCombat', () => {
  it('surfaces the server message instead of the raw URL', async () => {
    mockFetch(409, { error: 'Nothing to undo yet.' });
    await expect(undoCombat(1)).rejects.toThrow('Nothing to undo yet.');
  });

  it('resolves with the server payload on success', async () => {
    mockFetch(200, { undone: 'attack', state: {}, log: [] });
    await expect(undoCombat(1)).resolves.toMatchObject({ undone: 'attack' });
  });
});

describe('rewindCampaign', () => {
  it('surfaces the server message instead of the raw URL', async () => {
    mockFetch(409, { error: 'The story has no checkpoint to rewind to.' });
    const failure = await rewindCampaign(1).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.message).toBe('The story has no checkpoint to rewind to.');
  });

  it('resolves with the server payload on success', async () => {
    mockFetch(200, { reverted_events: 3, cancelled_rolls: 1, checkpoint_at: '2026-09-10T10:00:00.000Z' });
    await expect(rewindCampaign(1)).resolves.toMatchObject({ reverted_events: 3 });
  });
});

describe('getTownMap', () => {
  it('returns the parsed map on success', async () => {
    mockFetch(200, { name: 'Bryn Shander', kind: 'city', geojson: { type: 'FeatureCollection' } });
    await expect(getTownMap(1, 7)).resolves.toMatchObject({ name: 'Bryn Shander', kind: 'city' });
  });

  it('resolves to null when the server has no map', async () => {
    mockFetch(404, { error: 'no town map' });
    await expect(getTownMap(1, 7)).resolves.toBeNull();
  });

  it('rejects with the path and status on any other failure', async () => {
    mockFetch(500, { error: 'boom' });
    await expect(getTownMap(1, 7)).rejects.toThrow('/api/campaigns/1/entities/7/town-map -> 500');
  });
});

describe('boostRoll', () => {
  it('posts the selected boost and returns the refreshed pending-roll card', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 7, expr: '1d20+5', boosts_available: [], boosts_chosen: ['homebrew:lucky'] }),
    });
    vi.stubGlobal('fetch', fetch);

    await expect(boostRoll(7, 'homebrew:lucky')).resolves.toMatchObject({
      expr: '1d20+5',
      boosts_chosen: ['homebrew:lucky'],
    });
    expect(fetch).toHaveBeenCalledWith('/api/rolls/7/boost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boost_id: 'homebrew:lucky' }),
    });
  });
});
