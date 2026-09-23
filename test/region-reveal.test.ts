import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { getEntity, upsertEntity } from '../src/core/codex.js';
import { importRegion } from '../src/core/region.js';
import { revealPlace } from '../src/core/region-reveal.js';
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

function withSafeRegion(): number {
  const campaignId = newCampaign();
  importRegion(db, campaignId, safe, { source: 'generated' });
  return campaignId;
}

const placeRow = (campaignId: number, name: string): { known_to_party: number; entity_id: number | null } =>
  db
    .prepare('SELECT known_to_party, entity_id FROM world_place WHERE campaign_id = ? AND name = ?')
    .get(campaignId, name) as { known_to_party: number; entity_id: number | null };

const entityCount = (campaignId: number, name: string): number =>
  (db
    .prepare('SELECT COUNT(*) AS n FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
    .get(campaignId, name) as { n: number }).n;

describe('revealPlace refusals', () => {
  it('throws when the campaign has no region map', () => {
    expect(() => revealPlace(db, newCampaign(), 'Redham')).toThrow(/has no region map/);
  });

  it('throws when the place is not on the map', () => {
    const campaignId = withSafeRegion();
    expect(() => revealPlace(db, campaignId, 'Nowhere')).toThrow(/No place "Nowhere"/);
  });
});

describe('revealPlace on a settlement', () => {
  it('marks Redham known and writes the codex summary and hidden link', () => {
    const campaignId = withSafeRegion();
    const result = revealPlace(db, campaignId, 'Redham');

    expect(result.created).toBe(true);
    expect(result.warning).toBeUndefined();

    const entity = getEntity(db, campaignId, 'Redham', { include_hidden: true });
    expect(entity.kind).toBe('place');
    expect(entity.name).toBe('Redham');
    expect(entity.summary).toBe('Town, walled, on the coast. A walled port town of abundant privacy.');
    expect(entity.hidden_notes ?? '').toContain('city-generator');

    const row = placeRow(campaignId, 'Redham');
    expect(row.known_to_party).toBe(1);
    expect(row.entity_id).toBe(entity.id);
    expect(result.entity_id).toBe(entity.id);
    expect(result.place.known_to_party).toBe(true);
  });

  it('returns created false the second time and adds no second entity', () => {
    const campaignId = withSafeRegion();
    revealPlace(db, campaignId, 'Redham');
    const again = revealPlace(db, campaignId, 'Redham');

    expect(again.created).toBe(false);
    expect(entityCount(campaignId, 'Redham')).toBe(1);
  });
});

describe('revealPlace on areas and dangers', () => {
  it('names the terrain of an area', () => {
    const campaignId = withSafeRegion();
    revealPlace(db, campaignId, 'Raven Marshes');
    revealPlace(db, campaignId, 'Coldwood');

    expect(getEntity(db, campaignId, 'Raven Marshes').summary).toBe('An area of swamp.');
    expect(getEntity(db, campaignId, 'Coldwood').summary).toBe('An area of dark forest.');
  });

  it('leaves a danger summary empty and keeps its dungeon link hidden', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'uploaded' });
    const result = revealPlace(db, campaignId, 'Hidden Keep');

    expect(result.created).toBe(true);
    const entity = getEntity(db, campaignId, 'Hidden Keep', { include_hidden: true });
    expect(entity.summary).toBe('');
    expect(entity.hidden_notes ?? '').toContain('one-page-dungeon');
  });
});

describe('revealPlace against the codex', () => {
  it('warns and leaves an existing non-place entity untouched', () => {
    const campaignId = withSafeRegion();
    const npc = upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Redham', summary: 'The smith.' });

    const result = revealPlace(db, campaignId, 'Redham');
    expect(result.entity_id).toBeNull();
    expect(result.created).toBe(false);
    expect(result.warning ?? '').toContain('already has a npc named "Redham"');

    const entity = getEntity(db, campaignId, 'Redham');
    expect(entity.id).toBe(npc.entity.id);
    expect(entity.kind).toBe('npc');
    expect(entity.summary).toBe('The smith.');

    const row = placeRow(campaignId, 'Redham');
    expect(row.known_to_party).toBe(1);
    expect(row.entity_id).toBeNull();
  });

  it('merges into a place entity the DM already wrote and links the place to it', () => {
    const campaignId = withSafeRegion();
    const dmPlace = upsertEntity(db, {
      campaign_id: campaignId,
      kind: 'place',
      name: 'Redham',
      summary: "The DM's own note on the Redham.",
    });

    const result = revealPlace(db, campaignId, 'Redham');
    expect(result.created).toBe(false);
    expect(entityCount(campaignId, 'Redham')).toBe(1);
    expect(result.entity_id).toBe(dmPlace.entity.id);
    expect(getEntity(db, campaignId, 'Redham').kind).toBe('place');
    expect(placeRow(campaignId, 'Redham').entity_id).toBe(dmPlace.entity.id);
  });
});

describe('revealPlace protects the story', () => {
  it('makes the region un-replaceable once a place is revealed', () => {
    const campaignId = withSafeRegion();
    revealPlace(db, campaignId, 'Redham');
    expect(() => importRegion(db, campaignId, dangerous, { source: 'generated', replace: true })).toThrow(
      /already knows places/,
    );
  });
});
