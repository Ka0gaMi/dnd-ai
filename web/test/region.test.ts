import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import RegionPanel from '../src/components/RegionPanel.svelte';
import {
  DEFAULT_REGION_SIZE,
  DEFAULT_TAG_CHOICE,
  REGION_SIZE_HINT,
  REGION_SIZE_OPTIONS,
  TAG_GROUPS,
  generateRequest,
  parseSeed,
  summaryLine,
  tagsFor,
  type PlayerRegionSummary,
} from '../src/lib/region';

/** A player-safe summary; each case overrides what it is about. */
const summary = (over: Partial<PlayerRegionSummary> = {}): PlayerRegionSummary => ({
  name: 'Realm Of Poss',
  tags: ['dangerous'],
  seed: 42,
  settlements: [{ name: 'Port Vell', size: 'town' }],
  areas: 3,
  dangers: 2,
  locked: false,
  ...over,
});

describe('tagsFor', () => {
  it('keeps only the chosen options, in group order', () => {
    expect(tagsFor(DEFAULT_TAG_CHOICE)).toEqual(['dangerous']);
    expect(tagsFor({ land: 'island', people: null, law: 'chaotic', danger: 'safe' })).toEqual([
      'island',
      'chaotic',
      'safe',
    ]);
  });
});

describe('parseSeed', () => {
  it('treats blank as server-chosen, a whole number as itself and anything else as invalid', () => {
    expect(parseSeed('')).toBeUndefined();
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed('-1')).toBeNull();
    expect(parseSeed('4.5')).toBeNull();
    expect(parseSeed('abc')).toBeNull();
  });
});

describe('generateRequest', () => {
  it('sends the seed, tags, size and replace flag', () => {
    expect(generateRequest(42, ['dangerous'], 'large', true)).toEqual({
      mode: 'generate',
      seed: 42,
      tags: ['dangerous'],
      size: 'large',
      replace: true,
    });
  });

  it('defaults the size to medium and replace to false', () => {
    expect(DEFAULT_REGION_SIZE).toBe('medium');
    expect(generateRequest(undefined, [])).toEqual({
      mode: 'generate',
      seed: undefined,
      tags: [],
      size: 'medium',
      replace: false,
    });
  });
});

describe('summaryLine', () => {
  it('pluralises and drops the dangers clause when there are none', () => {
    const many = summary({
      settlements: [1, 2, 3, 4, 5].map((n) => ({ name: `Village ${n}`, size: 'village' })),
      areas: 3,
      dangers: 2,
    });
    expect(summaryLine(many)).toBe(
      'Realm Of Poss: 5 settlements, 3 areas, 2 dangers the DM keeps to themselves',
    );
    const one = summary({ name: 'Tiny', settlements: [{ name: 'One', size: 'hamlet' }], areas: 1, dangers: 0 });
    expect(summaryLine(one)).toBe('Tiny: 1 settlement, 1 area');
  });
});

describe('RegionPanel', () => {
  it('shows the current region, its settlements and the hint', () => {
    const { body } = render(RegionPanel, { props: { campaignId: 1, initial: summary() } });
    expect(body).toContain('Realm Of Poss');
    expect(body).toContain('Port Vell');
    expect(body).toContain(
      'The DM sets the story in this region. Dangers stay hidden from you until the story reveals them.',
    );
  });

  it('offers a replacement only while the story has not used the map', () => {
    expect(render(RegionPanel, { props: { campaignId: 1, initial: summary() } }).body).toContain('Generate another');
    const locked = render(RegionPanel, { props: { campaignId: 1, initial: summary({ locked: true }) } }).body;
    expect(locked).not.toContain('Generate another');
    expect(locked).toContain('The story already uses this map, so it can no longer be replaced.');
  });

  it('offers the generate form and every tag group when there is no region', () => {
    const { body } = render(RegionPanel, { props: { campaignId: 1, initial: null } });
    expect(body).toContain('Generate');
    for (const group of TAG_GROUPS) expect(body).toContain(group.label);
  });

  it('offers every size with its hint', () => {
    const { body } = render(RegionPanel, { props: { campaignId: 1, initial: null } });
    for (const option of REGION_SIZE_OPTIONS) expect(body).toContain(option.label);
    expect(body).toContain(REGION_SIZE_HINT);
  });

  it('keeps every tag option id to the server rule', () => {
    for (const group of TAG_GROUPS) {
      for (const option of group.options) expect(option.id).toMatch(/^[a-z]+$/);
    }
  });
});
