import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { assertReplaceable, findPlace, getRegion, importRegion, playerRegionSummary } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Ashfall Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

describe('importRegion on a safe realm', () => {
  it('stores the region, its places and its routes', () => {
    const campaignId = newCampaign();
    const view = importRegion(db, campaignId, safe, { source: 'generated' });

    expect(view.name).toBe('Realm Of Poss');
    expect(view.seed).toBe(4242);
    expect(view.tags).toHaveLength(4);
    expect(view.source).toBe('generated');
    expect(view.origin_url).toContain('seed=4242');
    expect(view.places.filter((p) => p.kind === 'settlement')).toHaveLength(5);
    expect(view.places.filter((p) => p.kind === 'area')).toHaveLength(3);
    expect(view.places.filter((p) => p.kind === 'danger')).toHaveLength(0);
    expect(view.routes).toHaveLength(9);

    expect(view.places.find((p) => p.name === 'Redham')?.tags).toEqual({
      size: 'town',
      walled: true,
      coast: true,
      terrain: 'plains',
    });

    const coldwood = view.places.find((p) => p.name === 'Coldwood')!;
    expect(coldwood.kind).toBe('area');
    expect(coldwood.q).toBe(8);
    expect(coldwood.r).toBe(5);
    expect(coldwood.hexes).toHaveLength(27);

    const event = db
      .prepare("SELECT kind, text FROM event WHERE campaign_id = ? AND text LIKE '%Realm Of Poss%'")
      .get(campaignId) as { kind: string; text: string };
    expect(event.kind).toBe('system');
    expect(event.text).toContain('Realm Of Poss');
  });

  it('round-trips through getRegion', () => {
    const campaignId = newCampaign();
    const imported = importRegion(db, campaignId, safe, { source: 'generated' });
    expect(getRegion(db, campaignId)).toEqual(imported);
  });

  it('returns null before anything is imported', () => {
    expect(getRegion(db, newCampaign())).toBeNull();
  });
});

describe('importRegion on a dangerous realm', () => {
  it('stores dangers with their links and kind tag', () => {
    const campaignId = newCampaign();
    const view = importRegion(db, campaignId, dangerous, { source: 'uploaded' });

    const dangers = view.places.filter((p) => p.kind === 'danger');
    expect(dangers).toHaveLength(2);
    for (const danger of dangers) {
      expect(String(danger.link)).toContain('one-page-dungeon');
      expect(danger.tags.kind).toBe('dungeon');
    }
  });
});

describe('replace rules', () => {
  it('refuses a second import without replace', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    expect(() => importRegion(db, campaignId, dangerous, { source: 'generated' })).toThrow(
      /already has a region/,
    );
  });

  it('swaps the region when replace is passed', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    const swapped = importRegion(db, campaignId, dangerous, { source: 'generated', replace: true });

    expect(swapped.name).toBe('Ta Isle');
    const view = getRegion(db, campaignId)!;
    expect(view.name).toBe('Ta Isle');
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_place WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: view.places.length,
    });
  });

  it('refuses to replace once the party knows a place', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'generated' });
    db.prepare("UPDATE world_place SET known_to_party = 1 WHERE campaign_id = ? AND kind = 'danger'").run(
      campaignId,
    );

    expect(() => importRegion(db, campaignId, safe, { source: 'generated', replace: true })).toThrow(
      /already knows places/,
    );
    const view = getRegion(db, campaignId)!;
    expect(view.name).toBe('Ta Isle');
    expect(view.places.some((p) => p.known_to_party)).toBe(true);
  });
});

describe('assertReplaceable', () => {
  it('does nothing when there is no region', () => {
    const campaignId = newCampaign();
    expect(() => assertReplaceable(db, campaignId, undefined)).not.toThrow();
  });

  it('refuses a second region without replace', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    expect(() => assertReplaceable(db, campaignId, undefined)).toThrow(/already has a region/);
  });

  it('refuses to replace once the party knows a place', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'generated' });
    db.prepare("UPDATE world_place SET known_to_party = 1 WHERE campaign_id = ? AND kind = 'danger'").run(
      campaignId,
    );
    expect(() => assertReplaceable(db, campaignId, true)).toThrow(/already knows places/);
  });

  it('allows a replace when nothing is known', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    expect(() => assertReplaceable(db, campaignId, true)).not.toThrow();
  });
});

describe('refusals write nothing', () => {
  it('rejects a malformed realm', () => {
    const campaignId = newCampaign();
    expect(() => importRegion(db, campaignId, {}, { source: 'generated' })).toThrow(
      /Not a Perilous Shores region/,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_region WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: 0,
    });
  });

  it('rejects an unknown campaign id', () => {
    expect(() => importRegion(db, 999, safe, { source: 'generated' })).toThrow(/No campaign with id 999/);
  });
});

describe('findPlace', () => {
  it('looks a place up by id or by name in any case', () => {
    const campaignId = newCampaign();
    const view = importRegion(db, campaignId, safe, { source: 'generated' });
    const redham = view.places.find((p) => p.name === 'Redham')!;

    expect(findPlace(db, campaignId, redham.id)).toMatchObject({ name: 'Redham', kind: 'settlement' });
    expect(findPlace(db, campaignId, 'REDHAM')).toMatchObject({ id: redham.id });
    expect(findPlace(db, campaignId, '  Redham  ')).toMatchObject({ id: redham.id });
    expect(findPlace(db, campaignId, 'Nowhere')).toBeUndefined();
  });
});

describe('playerRegionSummary', () => {
  it('counts the dangerous region without leaking danger names or links', () => {
    const campaignId = newCampaign();
    const view = importRegion(db, campaignId, dangerous, { source: 'generated' });
    const summary = playerRegionSummary(view);

    expect(summary.dangers).toBe(2);
    const text = JSON.stringify(summary);
    expect(text).not.toContain('Hidden Keep');
    expect(text).not.toContain('one-page-dungeon');
  });

  it('lists settlements with their size', () => {
    const campaignId = newCampaign();
    const view = importRegion(db, campaignId, safe, { source: 'generated' });
    const summary = playerRegionSummary(view);

    expect(summary.settlements).toContainEqual({ name: 'Redham', size: 'town' });
    expect(summary.areas).toBe(3);
    expect(summary.dangers).toBe(0);
  });
});

describe('two campaigns', () => {
  it('hold independent regions', () => {
    const first = newCampaign('First');
    const second = newCampaign('Second');
    importRegion(db, first, safe, { source: 'generated' });
    importRegion(db, second, dangerous, { source: 'generated' });

    expect(getRegion(db, first)!.name).toBe('Realm Of Poss');
    expect(getRegion(db, second)!.name).toBe('Ta Isle');
    expect(findPlace(db, first, 'Hidden Keep')).toBeUndefined();
    expect(findPlace(db, second, 'Hidden Keep')?.kind).toBe('danger');
  });
});
