import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteCampaign } from '../src/lib/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deleteCampaign', () => {
  it('DELETEs the campaign and returns how many rows went', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ deleted: true, deleted_rows: 42 }),
    });
    vi.stubGlobal('fetch', fetch);

    await expect(deleteCampaign(5)).resolves.toEqual({ deleted: true, deleted_rows: 42 });
    expect(fetch).toHaveBeenCalledWith('/api/campaigns/5', { method: 'DELETE' });
  });

  it('rejects with an ApiError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const failure = await deleteCampaign(999).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(404);
  });
});
