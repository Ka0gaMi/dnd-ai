// The living-world briefing block: the portents near the party, the clocks they know, the news they
// have heard, how the world regards them, and what changed while they were away.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTime } from '../src/core/calendar.js';
import { campaignSnapshot, createCampaign, saveCheckpoint } from '../src/core/campaign.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { addAttitude, lastVisit } from '../src/core/world-memory.js';
import { emitPacket } from '../src/core/world-news.js';
import { ensureWorld } from '../src/core/world-seed.js';
import {
  currentGameDay,
  getWorldState,
  insertAgenda,
  insertEvent,
  listAgendas,
  listFactions,
  updateAgenda,
} from '../src/core/world-store.js';
import { onPartyMoved, worldBriefing } from '../src/core/world-briefing.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

const HEADER = 'World (DM only; weave these in, never read them out):';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(): number {
  return createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
}

function safeCampaign(): number {
  const campaignId = newCampaign();
  importRegion(db, campaignId, safe, { source: 'generated' });
  return campaignId;
}

function worldCampaign(): number {
  const campaignId = safeCampaign();
  ensureWorld(db, campaignId);
  return campaignId;
}

function placeId(campaignId: number, name: string): number {
  return findPlace(db, campaignId, name)!.id;
}

/** Row counts across every world table and the rumour table, to prove a read wrote nothing. */
function counts(): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'world_%' OR name = 'rumour')")
    .all() as Array<{ name: string }>;
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    out[name] = (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
  }
  return out;
}

describe('worldBriefing without a world', () => {
  it('is empty and never reaches the player snapshot', () => {
    const campaignId = newCampaign();

    expect(worldBriefing(db, campaignId, null)).toBe('');
    expect(campaignSnapshot(db, campaignId, { forPlayer: true }).world_briefing).toBe('');
  });
});

describe('worldBriefing with a world', () => {
  it('opens with the DM header and hides the block from the player', () => {
    const campaignId = worldCampaign();

    expect(campaignSnapshot(db, campaignId).world_briefing.startsWith(HEADER)).toBe(true);
    expect(campaignSnapshot(db, campaignId, { forPlayer: true }).world_briefing).toBe('');
  });

  it('lists a known agenda under Known clocks', () => {
    const campaignId = worldCampaign();
    const agenda = listAgendas(db, campaignId)[0]!;
    const faction = listFactions(db, campaignId).find((entry) => entry.id === agenda.faction_id)!;
    updateAgenda(db, campaignId, agenda.id, { known_to_party: true });

    const text = worldBriefing(db, campaignId, null);
    expect(text).toContain('Known clocks:');
    expect(text).toContain(
      `- ${faction.name}: ${agenda.template} -> ${agenda.target_name} [${agenda.clock_filled}/${agenda.clock_size}]`,
    );
  });

  it('lists a fired portent near the party, and skips the section when the location is unmapped', () => {
    const campaignId = worldCampaign();
    const faction = listFactions(db, campaignId)[0]!;
    const redham = placeId(campaignId, 'Redham');
    const today = currentGameDay(db, campaignId);
    insertAgenda(db, campaignId, {
      faction_id: faction.id,
      template: 'settlement_scheme',
      target_kind: 'settlement',
      target_id: redham,
      target_name: 'Redham',
      clock_size: 6,
      clock_filled: 1,
      portents: [{ text: 'A red sail was seen.', fired_day: today, heard: false }],
      status: 'active',
      started_day: today,
    });

    const text = worldBriefing(db, campaignId, 'Redham');
    expect(text).toContain('Portents near the party:');
    expect(text).toContain(`- A red sail was seen. (${faction.name}, 0 hexes away)`);

    expect(worldBriefing(db, campaignId, 'A cave nobody mapped')).not.toContain('Portents near the party:');
  });

  it('shows how a faction regards the party after an attitude', () => {
    const campaignId = worldCampaign();
    const faction = listFactions(db, campaignId)[0]!;
    const today = currentGameDay(db, campaignId);
    addAttitude(
      db,
      campaignId,
      { kind: 'faction', id: faction.id },
      { value: 3, reason: 'Saved their caravan', day: today },
    );

    const text = worldBriefing(db, campaignId, null);
    expect(text).toContain('How they regard the party:');
    expect(text).toContain(`- ${faction.name}: 3 (Saved their caravan)`);
  });

  it('shows what changed at a settlement while the party was away', () => {
    const campaignId = worldCampaign();
    const redham = placeId(campaignId, 'Redham');

    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'Arrived at Redham.', scene_location: 'Redham' });
    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'Rode to Hotfield.', scene_location: 'Hotfield' });
    const leftDay = currentGameDay(db, campaignId);
    advanceTime(db, campaignId, { days: 5 });
    const today = currentGameDay(db, campaignId);

    insertEvent(db, campaignId, {
      day: today - 2,
      kind: 'disaster',
      text: 'A granary burned.',
      severity: 2,
      place_id: redham,
      faction_id: null,
      agenda_id: null,
      causes: [],
      effects: {},
      visibility: 'public',
    });
    insertEvent(db, campaignId, {
      day: today,
      kind: 'disaster',
      text: 'A new reeve was named.',
      severity: 1,
      place_id: redham,
      faction_id: null,
      agenda_id: null,
      causes: [],
      effects: {},
      visibility: 'public',
    });

    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'Returned to Redham.', scene_location: 'Redham' });

    const text = worldBriefing(db, campaignId, 'Redham');
    expect(text).toContain('While you were away from Redham:');
    expect(text).toContain(`- day +${today - 2 - leftDay}: A granary burned.`);
    expect(text).toContain(`- day +${today - leftDay}: A new reeve was named.`);
    expect(text.indexOf('A granary burned.')).toBeLessThan(text.indexOf('A new reeve was named.'));
  });

  it('reads without writing anything', () => {
    const campaignId = worldCampaign();
    const faction = listFactions(db, campaignId)[0]!;
    const agenda = listAgendas(db, campaignId)[0]!;
    updateAgenda(db, campaignId, agenda.id, { known_to_party: true });
    addAttitude(
      db,
      campaignId,
      { kind: 'faction', id: faction.id },
      { value: -2, reason: 'Ran them out of town', day: currentGameDay(db, campaignId) },
    );

    const before = counts();
    worldBriefing(db, campaignId, 'Redham');
    expect(counts()).toEqual(before);
  });
});

describe('onPartyMoved', () => {
  it('records the departure and marks news heard on arrival', () => {
    const campaignId = worldCampaign();
    const redham = placeId(campaignId, 'Redham');
    const today = currentGameDay(db, campaignId);
    emitPacket(
      db,
      campaignId,
      insertEvent(db, campaignId, {
        day: today,
        kind: 'disaster',
        text: 'The docks are on fire.',
        severity: 1,
        place_id: redham,
        faction_id: null,
        agenda_id: null,
        causes: [],
        effects: {},
        visibility: 'public',
      }),
    );

    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'Rode out.', scene_location: 'Hotfield' });
    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'Reached Redham.', scene_location: 'Redham' });

    const rumour = db
      .prepare("SELECT heard_at, source_kind FROM rumour WHERE campaign_id = ? AND text = 'The docks are on fire.'")
      .get(campaignId) as { heard_at: string | null; source_kind: string } | undefined;
    expect(rumour?.heard_at).not.toBeNull();
    expect(rumour?.source_kind).toBe('world');

    const arrival = db
      .prepare('SELECT heard FROM world_packet_arrival WHERE place_id = ?')
      .get(redham) as { heard: number };
    expect(arrival.heard).toBe(1);

    const visit = db
      .prepare('SELECT last_seen_day FROM world_visit WHERE campaign_id = ? AND place_id = ?')
      .get(campaignId, placeId(campaignId, 'Hotfield')) as { last_seen_day: number } | undefined;
    expect(visit?.last_seen_day).toBe(today);
  });

  it('does nothing without a region', () => {
    const campaignId = newCampaign();
    const before = counts();

    onPartyMoved(db, campaignId, 'Redham', 'Hotfield');

    expect(counts()).toEqual(before);
  });

  it('seeds the world on the opening checkpoints, before any day has passed', () => {
    const campaignId = safeCampaign();

    saveCheckpoint(db, { campaign_id: campaignId, scene_location: 'Stormcourtby', scene_summary: 'Arrive.' });
    saveCheckpoint(db, { campaign_id: campaignId, scene_location: 'Redham', scene_summary: 'Move on.' });

    expect(getWorldState(db, campaignId)).not.toBeNull();
    expect(lastVisit(db, campaignId, placeId(campaignId, 'Stormcourtby'))).toBe(currentGameDay(db, campaignId));
  });
});
