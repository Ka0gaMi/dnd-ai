import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { findBuilding, listBuildings, revealBuilding, saveBuilding } from '../src/core/building.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const safe = fixture('realm-safe.json');
const dangerous = fixture('realm-dangerous.json');
const planTavern = fixture('plan-tavern.json');

const TAVERN_URL = 'https://watabou.github.io/dwellings/?seed=777';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Ashfall Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

function importSafe(campaignId: number): { redham: number; stormcourtby: number; coldwood: number } {
  importRegion(db, campaignId, safe, { source: 'generated' });
  return {
    redham: findPlace(db, campaignId, 'Redham')!.id,
    stormcourtby: findPlace(db, campaignId, 'Stormcourtby')!.id,
    coldwood: findPlace(db, campaignId, 'Coldwood')!.id,
  };
}

describe('saveBuilding and findBuilding', () => {
  it('stores a building known to nobody and finds it by case-insensitive name', () => {
    const campaignId = newCampaign();
    const { redham } = importSafe(campaignId);

    const stored = saveBuilding(db, campaignId, redham, {
      name: 'The Gilded Goose',
      kind: 'tavern',
      seed: 777,
      url: TAVERN_URL,
      raw: planTavern,
    });
    expect(stored.name).toBe('The Gilded Goose');
    expect(stored.place_id).toBe(redham);
    expect(stored.kind).toBe('tavern');
    expect(stored.seed).toBe(777);
    expect(stored.url).toBe(TAVERN_URL);
    expect(stored.known_to_party).toBe(false);
    expect(stored.created_at).toBeTruthy();
    expect((stored.raw as { floors: unknown[] }).floors).toHaveLength(2);

    expect(findBuilding(db, campaignId, redham, 'the gilded goose')?.id).toBe(stored.id);
    expect(findBuilding(db, campaignId, redham, '  The Gilded Goose  ')?.id).toBe(stored.id);
    expect(findBuilding(db, campaignId, redham, 'The Rusty Anchor')).toBeUndefined();
  });

  it('refuses a name already used there but allows it in another settlement', () => {
    const campaignId = newCampaign();
    const { redham, stormcourtby } = importSafe(campaignId);
    const tavern = { name: 'The Gilded Goose', kind: 'tavern', seed: 777, url: TAVERN_URL, raw: planTavern };

    saveBuilding(db, campaignId, redham, tavern);
    expect(() => saveBuilding(db, campaignId, redham, tavern)).toThrow('already has a building');

    const elsewhere = saveBuilding(db, campaignId, stormcourtby, tavern);
    expect(elsewhere.name).toBe('The Gilded Goose');
    expect(elsewhere.place_id).toBe(stormcourtby);
  });

  it('refuses an area and an unknown place', () => {
    const campaignId = newCampaign();
    const { coldwood } = importSafe(campaignId);
    const tavern = { name: 'The Gilded Goose', kind: 'tavern', seed: 777, url: TAVERN_URL, raw: planTavern };

    expect(() => saveBuilding(db, campaignId, coldwood, tavern)).toThrow('belong to settlements');
    expect(() => saveBuilding(db, campaignId, 999999, tavern)).toThrow('belong to settlements');
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_building').get()).toEqual({ n: 0 });
  });
});

describe('listBuildings and revealBuilding', () => {
  it('lists in id order, filters to known, and reveals idempotently', () => {
    const campaignId = newCampaign();
    const { redham } = importSafe(campaignId);
    const first = saveBuilding(db, campaignId, redham, {
      name: 'The Gilded Goose',
      kind: 'tavern',
      seed: 777,
      url: TAVERN_URL,
      raw: planTavern,
    });
    saveBuilding(db, campaignId, redham, {
      name: 'The Broken Wheel',
      kind: 'smithy',
      seed: 778,
      url: TAVERN_URL,
      raw: planTavern,
    });

    expect(listBuildings(db, campaignId, redham).map((b) => b.id)).toEqual([first.id, first.id + 1]);
    expect(listBuildings(db, campaignId, redham, { knownOnly: true })).toHaveLength(0);

    const revealed = revealBuilding(db, campaignId, first.id);
    expect(revealed.known_to_party).toBe(true);
    expect(listBuildings(db, campaignId, redham, { knownOnly: true }).map((b) => b.id)).toEqual([first.id]);

    const again = revealBuilding(db, campaignId, first.id);
    expect(again.known_to_party).toBe(true);
    expect(() => revealBuilding(db, campaignId, 9999)).toThrow('No building');
  });

  it('logs one region event on the first reveal and none on a repeat', () => {
    const campaignId = newCampaign();
    const { redham } = importSafe(campaignId);
    const stored = saveBuilding(db, campaignId, redham, {
      name: 'The Gilded Goose',
      kind: 'tavern',
      seed: 777,
      url: TAVERN_URL,
      raw: planTavern,
    });

    revealBuilding(db, campaignId, stored.id);
    const rows = db
      .prepare("SELECT text, payload_json FROM event WHERE campaign_id = ? AND kind = 'region'")
      .all(campaignId) as Array<{ text: string; payload_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('The Gilded Goose in Redham is now known.');
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({ building_id: stored.id, place_id: redham });

    revealBuilding(db, campaignId, stored.id);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM event WHERE campaign_id = ? AND kind = 'region'").get(campaignId),
    ).toEqual({ n: 1 });
  });

  it('does not reveal or list another campaign\'s building', () => {
    const campaignId = newCampaign();
    const other = newCampaign('Other');
    const { redham } = importSafe(campaignId);
    const stored = saveBuilding(db, campaignId, redham, {
      name: 'The Gilded Goose',
      kind: 'tavern',
      seed: 777,
      url: TAVERN_URL,
      raw: planTavern,
    });

    expect(listBuildings(db, other, redham)).toHaveLength(0);
    expect(() => revealBuilding(db, other, stored.id)).toThrow('No building');
  });
});

describe('importRegion replace', () => {
  it('clears stored buildings so the swap is not blocked and leaves none behind', () => {
    const campaignId = newCampaign();
    const { redham } = importSafe(campaignId);
    saveBuilding(db, campaignId, redham, {
      name: 'The Gilded Goose',
      kind: 'tavern',
      seed: 777,
      url: TAVERN_URL,
      raw: planTavern,
    });

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_building WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: 0,
    });
  });
});
