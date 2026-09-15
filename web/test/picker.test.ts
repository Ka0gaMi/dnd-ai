import { describe, expect, it } from 'vitest';
import { autoPickId } from '../src/lib/picker';
import type { CampaignListItem } from '../src/lib/types';

const campaign = (id: number): CampaignListItem => ({
  id,
  name: `Story ${id}`,
  story_shape: 'sandbox',
  created_at: '2026-09-10T10:00:00.000Z',
  last_recap_snippet: null,
  pc: null,
});

describe('autoPickId', () => {
  it('opens the story when the first one appears', () => {
    expect(autoPickId([], [campaign(7)])).toBe(7);
  });

  it('keeps the picker up when two appear at once', () => {
    expect(autoPickId([], [campaign(7), campaign(8)])).toBeNull();
  });

  it('keeps the picker up when a second story is added', () => {
    expect(autoPickId([campaign(7)], [campaign(7), campaign(8)])).toBeNull();
  });
});
