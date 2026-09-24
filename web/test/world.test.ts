import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorld, regardLabel, type PlayerWorld } from '../src/lib/world';

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

describe('regardLabel', () => {
  it('maps each threshold to its word', () => {
    expect(regardLabel(-10)).toBe('hostile');
    expect(regardLabel(-6)).toBe('hostile');
    expect(regardLabel(-5)).toBe('wary');
    expect(regardLabel(-2)).toBe('wary');
    expect(regardLabel(-1)).toBe('neutral');
    expect(regardLabel(1)).toBe('neutral');
    expect(regardLabel(2)).toBe('friendly');
    expect(regardLabel(5)).toBe('friendly');
    expect(regardLabel(6)).toBe('devoted');
    expect(regardLabel(10)).toBe('devoted');
  });
});

describe('getWorld', () => {
  it('returns null when the DM has not started a living world', async () => {
    mockFetch(200, { world: null });
    await expect(getWorld(1)).resolves.toBeNull();
  });

  it('returns the world object when one exists', async () => {
    const world: PlayerWorld = {
      news: [{ id: 1, text: 'A red comet rose over the pass.', local: true }],
      clocks: [
        {
          id: 2,
          faction: 'The Iron Circle',
          goal: 'take the pass',
          filled: 2,
          size: 6,
          signs: ['their patrols grow'],
        },
      ],
      regard: [{ faction: 'The Iron Circle', value: -4, reasons: [{ reason: 'you broke their toll', value: -4 }] }],
    };
    mockFetch(200, { world });
    await expect(getWorld(7)).resolves.toEqual(world);
  });

  it('rejects with the path and status when the route fails', async () => {
    mockFetch(500, { error: 'boom' });
    await expect(getWorld(7)).rejects.toThrow('/api/campaigns/7/world -> 500');
  });
});
