import { afterEach, describe, expect, it, vi } from 'vitest';
import { agoLabel, getTimeline } from '../src/lib/timeline';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agoLabel', () => {
  it('names the recent days in words', () => {
    expect(agoLabel(0)).toBe('today');
    expect(agoLabel(1)).toBe('yesterday');
    expect(agoLabel(2)).toBe('2 days ago');
    expect(agoLabel(29)).toBe('29 days ago');
  });

  it('switches to months at thirty days', () => {
    expect(agoLabel(30)).toBe('about a month ago');
    expect(agoLabel(75)).toBe('about 3 months ago');
  });
});

describe('getTimeline', () => {
  it('parses the timeline array from the route', async () => {
    mockFetch(200, { timeline: [{ id: 4, day: 12, days_ago: 3, text: 'The mill burned.' }] });
    await expect(getTimeline(1, 7)).resolves.toEqual([{ id: 4, day: 12, days_ago: 3, text: 'The mill burned.' }]);
  });

  it('rejects with the path and status on a non-ok response', async () => {
    mockFetch(404, { error: 'hidden' });
    await expect(getTimeline(1, 7)).rejects.toThrow('/api/campaigns/1/entities/7/timeline -> 404');
  });
});
