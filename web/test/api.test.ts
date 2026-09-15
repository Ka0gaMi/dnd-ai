import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, rewindCampaign, undoCombat } from '../src/lib/api';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
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
