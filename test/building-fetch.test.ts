import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BuildingFetchError, fetchBuildingPlan, isDwellingsUrl } from '../src/core/building-fetch.js';

const TAVERN_URL = 'https://watabou.github.io/dwellings/?seed=777&tags=large&rooms=tavern';

describe('isDwellingsUrl', () => {
  it('recognises a Watabou Dwellings link', () => {
    expect(isDwellingsUrl('https://watabou.github.io/dwellings/?seed=1')).toBe(true);
  });

  it('returns false for the city generator, another host and text that is not a URL', () => {
    expect(isDwellingsUrl('https://watabou.github.io/city-generator/?seed=1')).toBe(false);
    expect(isDwellingsUrl('https://example.com/dwellings/')).toBe(false);
    expect(isDwellingsUrl('nope')).toBe(false);
  });
});

describe('fetchBuildingPlan', () => {
  it('rejects a link that is not a Watabou Dwellings link before launching a browser', async () => {
    await expect(fetchBuildingPlan('https://example.com/')).rejects.toBeInstanceOf(BuildingFetchError);
  });
});

describe.skipIf(!process.env.REGION_LIVE)('live building fetch', () => {
  it(
    'fetches the tavern floor plan export and matches the saved fixture',
    async () => {
      const result = await fetchBuildingPlan(TAVERN_URL);
      const fixture = JSON.parse(
        readFileSync(new URL('./fixtures/plan-tavern.json', import.meta.url), 'utf8'),
      );
      expect(result.raw).toEqual(fixture);
      expect(result.url).toContain('/dwellings/');
    },
    120_000,
  );
});
