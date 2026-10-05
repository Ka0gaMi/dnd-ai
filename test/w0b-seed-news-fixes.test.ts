// The W0b review fixes: a brood or band seeded in a county's claimed wilderness belongs to that county's
// realm, and world news heard on arrival logs the same public event a handed-out rumour does.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
const fixtures = {
  medium: fixture('realm-medium.json'),
  large: fixture('realm-large.json'),
  dangerous: fixture('realm-dangerous.json'),
};

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let bus: (typeof import('../src/core/bus.js'))['bus'];
let region: typeof import('../src/core/region.js');
let getPolitics: (typeof import('../src/core/politics-store.js'))['getPolitics'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let store: typeof import('../src/core/world-store.js');
let news: typeof import('../src/core/world-news.js');
let addRumour: (typeof import('../src/core/story.js'))['addRumour'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ bus } = await import('../src/core/bus.js'));
  region = await import('../src/core/region.js');
  ({ getPolitics } = await import('../src/core/politics-store.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  store = await import('../src/core/world-store.js');
  news = await import('../src/core/world-news.js');
  ({ addRumour } = await import('../src/core/story.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

function withRegion(realm: unknown): number {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  region.importRegion(db, campaignId, realm, { source: 'generated' });
  return campaignId;
}

/** The same world every run: the world seed comes from Math.random, held still while it is drawn. */
function seeded(realm: unknown): number {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(0.4242);
  try {
    const campaignId = withRegion(realm);
    ensureWorld(db, campaignId);
    return campaignId;
  } finally {
    spy.mockRestore();
  }
}

describe('seeded broods and bands in claimed wilderness', () => {
  it('belong to the county whose claim holds their site, on every bounded fixture', () => {
    const outsideHeld: Record<string, number> = {};
    for (const [name, realm] of Object.entries(fixtures)) {
      db = openDb(':memory:');
      const campaignId = seeded(realm);
      const politics = getPolitics(db, campaignId)!;
      outsideHeld[name] = 0;
      const places = region.getRegion(db, campaignId)!.places;
      const wild = store
        .listFactions(db, campaignId)
        .filter((faction) => faction.type === 'monsters' || faction.type === 'bandits');
      for (const faction of wild) {
        const site = places.find((place) => place.id === faction.place_id)!;
        const anchor = site.hexes[0];
        const claimant = politics.counties.find((county) => (county.claim_hexes ?? county.hexes).includes(anchor));
        if (!claimant) continue;
        if (!claimant.hexes.includes(anchor)) outsideHeld[name] += 1;
        const where = `${name}: ${faction.name}`;
        expect({ where, realm_id: faction.realm_id, county_id: faction.county_id }).toEqual({
          where,
          realm_id: claimant.realm_id,
          county_id: claimant.id,
        });
      }
    }
    // Each pinned world puts a camp or lair in claimed land no county holds, or the test would prove nothing.
    for (const count of Object.values(outsideHeld)) expect(count).toBeGreaterThan(0);
  });
});

describe('world news heard on arrival', () => {
  function publicHeardEvents(campaignId: number): Array<{ kind: string; text: string }> {
    return db
      .prepare("SELECT kind, text FROM event WHERE campaign_id = ? AND text LIKE 'Rumour heard:%' ORDER BY id")
      .all(campaignId) as Array<{ kind: string; text: string }>;
  }

  it('logs exactly one public Rumour heard story event per delivered packet', () => {
    const campaignId = withRegion(fixtures.medium);
    const town = region.getRegion(db, campaignId)!.places.find((place) => place.kind === 'settlement')!;
    const event = store.insertEvent(db, campaignId, {
      day: 100,
      kind: 'disaster',
      text: 'A fire in the market.',
      severity: 1,
      place_id: town.id,
      faction_id: null,
      agenda_id: null,
      causes: [],
      effects: {},
      visibility: 'public',
    });
    news.emitPacket(db, campaignId, event);

    const seen: Array<{ kind: string; text: string }> = [];
    const off = bus.subscribe((published) => seen.push({ kind: published.kind, text: published.text }));
    try {
      const delivered = news.deliverNews(db, campaignId, town.id, 100);
      expect(delivered).toHaveLength(1);
      expect(news.deliverNews(db, campaignId, town.id, 101)).toEqual([]);
    } finally {
      off();
    }

    const heard = [{ kind: 'story', text: 'Rumour heard: A fire in the market.' }];
    expect(publicHeardEvents(campaignId)).toEqual(heard);
    expect(seen.filter((published) => published.text.startsWith('Rumour heard:'))).toEqual(heard);
    expect(seen.map((published) => published.kind)).not.toContain('rumour_planted');
  });

  it('logs nothing public when an unheard rumour is stored', () => {
    const campaignId = withRegion(fixtures.medium);
    const before = (db.prepare('SELECT MAX(id) AS id FROM event WHERE campaign_id = ?').get(campaignId) as {
      id: number | null;
    }).id ?? 0;

    const seen: string[] = [];
    const off = bus.subscribe((published) => seen.push(published.kind));
    try {
      addRumour(db, { campaign_id: campaignId, text: 'The duke is dead.', truth: 'false' });
    } finally {
      off();
    }

    const logged = db
      .prepare('SELECT kind FROM event WHERE campaign_id = ? AND id > ? ORDER BY id')
      .all(campaignId, before) as Array<{ kind: string }>;
    expect(logged.map((row) => row.kind)).toEqual(['rumour_planted']);
    expect(seen).toEqual([]);
    expect(publicHeardEvents(campaignId)).toEqual([]);
  });
});
