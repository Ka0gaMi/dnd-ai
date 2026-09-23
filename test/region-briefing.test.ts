import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, campaignSnapshot, loadCampaign } from '../src/core/campaign.js';
import { importRegion } from '../src/core/region.js';
import { regionBriefing } from '../src/core/region-briefing.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';
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

function safeCampaign(): number {
  const campaignId = newCampaign();
  importRegion(db, campaignId, safe, { source: 'generated' });
  return campaignId;
}

describe('regionBriefing without a region', () => {
  it('is empty, and the snapshot carries nothing for the player or the DM', () => {
    const campaignId = newCampaign();

    expect(regionBriefing(db, campaignId, null)).toBe('');
    expect(campaignSnapshot(db, campaignId).region_briefing).toBe('');
  });
});

describe('regionBriefing on the safe realm', () => {
  it('opens with the region line and lists the settlements, areas and routes', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, null);

    expect(text.startsWith('## Region: Realm Of Poss (fjord, civilized, lawful, safe; 1 hex = 6 miles)')).toBe(true);
    expect(text).toContain('- Redham (town, walled, coast; plains) - A walled port town of abundant privacy.');
    expect(text).toContain('Areas: Coldwood (forest-dark), Raven Marshes (swamp), Ironfall Fens (swamp)');

    const routesLine = text.split('\n').find((line) => line.startsWith('Routes: '))!;
    expect(routesLine.startsWith('Routes: Stormcourtby-Redham 4 hexes')).toBe(true);
    expect(routesLine).toContain('; sea: Southern Landing-Redham 16 hexes');

    expect(text).not.toContain('Dangers');
    expect(text).not.toContain('Party is at');
  });

  it('places the party inside a known settlement and lists what is nearby', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, 'The Gilded Goose in Redham');

    expect(text).toContain(
      'Party is around: Redham (settlement), from the scene location "The Gilded Goose in Redham"',
    );
    expect(text).toContain('Near the party:');
    expect(text).toContain('Ironfall Fens (area, 1 hexes)');
  });

  it('says the party is at the place on an exact name match', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, 'redham');

    expect(text).toContain('Party is at: Redham (settlement)');
  });

  it('caps roads and sea routes independently', () => {
    const campaignId = safeCampaign();
    db.prepare('DELETE FROM world_route WHERE campaign_id = ?').run(campaignId);
    const insert = db.prepare(
      'INSERT INTO world_route (campaign_id, kind, from_hex, to_hex, hexes_json) VALUES (?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 12; i += 1) {
      insert.run(campaignId, 'road', 'q9_r5', `q${i}_r0`, JSON.stringify(['q9_r5', `q${i}_r0`]));
    }
    for (let i = 0; i < 7; i += 1) {
      insert.run(campaignId, 'searoute', 'q11_r14', `q${i}_r0`, JSON.stringify(['q11_r14', `q${i}_r0`]));
    }

    const text = regionBriefing(db, campaignId, null);
    const routesLine = text.split('\n').find((line) => line.startsWith('Routes: '))!;
    const [roadsPart, seasPart] = routesLine.split('; sea: ');

    expect(roadsPart.match(/Stormcourtby-the map edge 1 hexes/g)).toHaveLength(10);
    expect(roadsPart.endsWith(', … and 2 more')).toBe(true);
    expect(seasPart.match(/Southern Landing-the map edge 1 hexes/g)).toHaveLength(5);
    expect(seasPart.endsWith(', … and 2 more')).toBe(true);
  });

  it('says so when the location is not on the map', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, 'A cave nobody mapped');

    expect(text).toContain('Party is at "A cave nobody mapped", which is not on the region map.');
    expect(text).not.toContain('Near the party:');
  });

  it('marks a place the party knows', () => {
    const campaignId = safeCampaign();
    db.prepare("UPDATE world_place SET known_to_party = 1 WHERE campaign_id = ? AND name = 'Redham'").run(
      campaignId,
    );

    expect(regionBriefing(db, campaignId, null)).toContain(
      'A walled port town of abundant privacy. [known]',
    );
  });
});

describe('regionBriefing on the dangerous realm', () => {
  it('names the dangers with their nearest settlement, and never leaks them to the player', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'uploaded' });
    const text = regionBriefing(db, campaignId, null);

    expect(text).toContain('Dangers (DM only):');
    expect(text).toContain('- Hidden Keep (dungeon, ');
    expect(text).toContain('- Ziggurat Of The Vampire Queen (dungeon, ');
    expect(text).toMatch(/- Hidden Keep \(dungeon, \d+ hexes from (Frostcot|Crimson Wharf)\)/);
    expect(text).toMatch(/- Ziggurat Of The Vampire Queen \(dungeon, \d+ hexes from (Frostcot|Crimson Wharf)\)/);

    const dm = campaignSnapshot(db, campaignId).region_briefing;
    const player = campaignSnapshot(db, campaignId, { forPlayer: true }).region_briefing;
    expect(dm).not.toBe('');
    expect(dm).toContain('Hidden Keep');
    expect(player).toBe('');
  });
});

describe('renderBriefing', () => {
  it('puts the region block above the recap', () => {
    const campaignId = safeCampaign();
    const rendered = renderBriefing(loadCampaign(db, campaignId));

    const regionAt = rendered.indexOf('## Region:');
    const recapAt = rendered.indexOf('## Recap');
    expect(regionAt).toBeGreaterThan(-1);
    expect(recapAt).toBeGreaterThan(-1);
    expect(regionAt).toBeLessThan(recapAt);
  });
});
