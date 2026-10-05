// Matching a free-text party location to a known place: exact name first, then the longest whole-word
// name in the text, and the world layer's use of it for news and visits.
import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTime } from '../src/core/calendar.js';
import { createCampaign, saveCheckpoint } from '../src/core/campaign.js';
import { matchPlace } from '../src/core/place-match.js';
import { findPlace, importRegion, type PlaceKind } from '../src/core/region.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { currentGameDay, insertEvent } from '../src/core/world-store.js';
import { emitPacket } from '../src/core/world-news.js';
import { lastVisit } from '../src/core/world-memory.js';
import { onPartyMoved, worldBriefing } from '../src/core/world-briefing.js';
import { onDayChange } from '../src/core/world-hooks.js';
import { openDb, type Db } from '../src/db/connection.js';

const STAMP = '2024-01-01T00:00:00.000Z';
const REDHAM_HEX = 'q0_r0';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(): number {
  return createCampaign(db, { name: 'Place Match', story_shape: 'structured' }).campaign_id;
}

/** A bare region header, so getRegion can answer without a full realm import. */
function seedRegion(campaignId: number): void {
  db.prepare(
    `INSERT INTO world_region (campaign_id, name, source, seed, tags_json, origin_url, raw_json, imported_at)
     VALUES (?, 'Matchland', 'generated', 1, '[]', '', '{}', ?)`,
  ).run(campaignId, STAMP);
}

function addPlace(campaignId: number, kind: PlaceKind, name: string): number {
  const info = db
    .prepare(
      `INSERT INTO world_place
         (campaign_id, kind, name, q, r, hexes_json, tags_json, info, link, seed, known_to_party, created_at)
       VALUES (?, ?, ?, 0, 0, ?, '{}', '', NULL, NULL, 0, ?)`,
    )
    .run(campaignId, kind, name, JSON.stringify([REDHAM_HEX]), STAMP);
  return Number(info.lastInsertRowid);
}

/** A hand-built realm with two road-linked towns named Redham and Hotfield. */
function handBuiltRealm(): unknown {
  const town = (name: string) => ({
    name,
    type: 'town',
    walled: true,
    info: `${name} stands.`,
    link: 'https://watabou.github.io/perilous-shores/?size=2000',
    seed: 1,
  });
  return {
    name: 'Matchland',
    origin: 'https://watabou.github.io/perilous-shores/?seed=99',
    bp: { width: 100, height: 100, tags: ['safe'], seed: 99 },
    layout: 'even-r',
    hexes: {
      q0_r0: { q: 0, r: 0, terrain: 'plains', town: town('Redham') },
      q1_r0: { q: 1, r: 0, terrain: 'plains', town: town('Hotfield') },
      q2_r0: { q: 2, r: 0, terrain: 'plains' },
    },
    roads: { 'q0_r0-q1_r0': ['q0_r0', 'q1_r0'] },
    features: [],
  };
}

function worldCampaign(): number {
  const campaignId = newCampaign();
  importRegion(db, campaignId, handBuiltRealm(), { source: 'generated' });
  ensureWorld(db, campaignId);
  return campaignId;
}

/** The news packet's arrival row at a settlement, or undefined when it never reached. */
function arrival(packetId: number | null, placeId: number): { heard: number } | undefined {
  return db
    .prepare('SELECT heard FROM world_packet_arrival WHERE packet_id = ? AND place_id = ?')
    .get(packetId, placeId) as { heard: number } | undefined;
}

describe('matchPlace', () => {
  it('matches a known place name inside the location text, case-insensitively', () => {
    const campaignId = newCampaign();
    seedRegion(campaignId);
    const redham = addPlace(campaignId, 'settlement', 'Redham');

    expect(matchPlace(db, campaignId, 'Redham docks')?.id).toBe(redham);
    expect(matchPlace(db, campaignId, 'moored at the redham quay')?.id).toBe(redham);
  });

  it('lets the longest matching name win', () => {
    const campaignId = newCampaign();
    seedRegion(campaignId);
    const redham = addPlace(campaignId, 'settlement', 'Redham');
    const reach = addPlace(campaignId, 'area', 'Redham Reach');

    expect(matchPlace(db, campaignId, 'moored at Redham Reach')?.id).toBe(reach);
    expect(matchPlace(db, campaignId, 'back in Redham')?.id).toBe(redham);
  });

  it('breaks a length tie by kind: settlement over area over danger', () => {
    const campaignId = newCampaign();
    seedRegion(campaignId);
    const settlement = addPlace(campaignId, 'settlement', 'Mistwood');
    addPlace(campaignId, 'area', 'Mistwood');
    const area = addPlace(campaignId, 'area', 'Wolf Fen');
    addPlace(campaignId, 'danger', 'Wolf Fen');

    expect(matchPlace(db, campaignId, 'the Mistwood at dusk')?.id).toBe(settlement);
    expect(matchPlace(db, campaignId, 'near Wolf Fen tonight')?.id).toBe(area);
  });

  it('never matches part of a word', () => {
    const campaignId = newCampaign();
    seedRegion(campaignId);
    const ash = addPlace(campaignId, 'settlement', 'Ash');

    expect(matchPlace(db, campaignId, 'the Ashford road')).toBeUndefined();

    const ashford = addPlace(campaignId, 'settlement', 'Ashford');
    expect(matchPlace(db, campaignId, 'the Ashford road')?.id).toBe(ashford);
    expect(matchPlace(db, campaignId, 'ash and embers')?.id).toBe(ash);
  });

  it('resolves an exact name through findPlace first', () => {
    const campaignId = newCampaign();
    seedRegion(campaignId);
    const settlement = addPlace(campaignId, 'settlement', 'Redham');
    addPlace(campaignId, 'area', 'Redham');

    expect(matchPlace(db, campaignId, 'Redham')?.id).toBe(settlement);
    expect(matchPlace(db, campaignId, '  Redham  ')?.id).toBe(settlement);
  });
});

describe('the world layer at a described location', () => {
  it('delivers a packet and records a visit for "Redham docks"', () => {
    const campaignId = worldCampaign();
    const redham = findPlace(db, campaignId, 'Redham')!;
    const today = currentGameDay(db, campaignId);
    const packet = emitPacket(
      db,
      campaignId,
      insertEvent(db, campaignId, {
        day: today,
        kind: 'disaster',
        text: 'The docks are on fire.',
        severity: 1,
        place_id: redham.id,
        faction_id: null,
        agenda_id: null,
        causes: [],
        effects: {},
        visibility: 'public',
      }),
    );

    onPartyMoved(db, campaignId, 'Redham docks', 'Hotfield');
    onPartyMoved(db, campaignId, 'Hotfield', 'Redham docks');

    expect(arrival(packet.packet_id, redham.id)?.heard).toBe(1);
    expect(lastVisit(db, campaignId, redham.id)).toBe(today);
  });

  it('delivers a packet through onDayChange when the scene sits at "Redham docks"', () => {
    const campaignId = worldCampaign();
    const redham = findPlace(db, campaignId, 'Redham')!;
    saveCheckpoint(db, {
      campaign_id: campaignId,
      scene_summary: 'Down at the water.',
      scene_location: 'Redham docks',
    });
    const today = currentGameDay(db, campaignId);
    const packet = emitPacket(
      db,
      campaignId,
      insertEvent(db, campaignId, {
        day: today,
        kind: 'disaster',
        text: 'A warehouse collapsed.',
        severity: 1,
        place_id: redham.id,
        faction_id: null,
        agenda_id: null,
        causes: [],
        effects: {},
        visibility: 'public',
      }),
    );

    onDayChange(db, campaignId);

    expect(arrival(packet.packet_id, redham.id)?.heard).toBe(1);
  });

  it('briefs on the matched settlement for a described location', () => {
    const campaignId = worldCampaign();
    const redham = findPlace(db, campaignId, 'Redham')!;
    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'At Redham.', scene_location: 'Redham' });
    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'Rode out.', scene_location: 'Hotfield' });
    advanceTime(db, campaignId, { days: 5 });
    const today = currentGameDay(db, campaignId);
    insertEvent(db, campaignId, {
      day: today,
      kind: 'disaster',
      text: 'A bell tower fell.',
      severity: 1,
      place_id: redham.id,
      faction_id: null,
      agenda_id: null,
      causes: [],
      effects: {},
      visibility: 'public',
    });

    const text = worldBriefing(db, campaignId, 'Redham docks');
    expect(text).toContain('While you were away from Redham:');
    expect(text).toContain('A bell tower fell.');
  });
});
