// Held clocks in the world block are capped at the most urgent few with a "+N more" tail, so 50 of them stay within budget.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldPlace } from '../src/core/region.js';

const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;
const CAP = 10;

let store: typeof import('../src/core/world-store.js');
let tokens: typeof import('../src/core/token-budget.js');
let worldBriefing: (typeof import('../src/core/world-briefing.js'))['worldBriefing'];
let db: Db;
let campaignId: number;
let dione: WorldPlace;
let factionId: number;

beforeAll(async () => {
  vi.resetModules();
  const { openDb } = await import('../src/db/connection.js');
  const campaign = await import('../src/core/campaign.js');
  store = await import('../src/core/world-store.js');
  tokens = await import('../src/core/token-budget.js');
  ({ worldBriefing } = await import('../src/core/world-briefing.js'));
  const region = await import('../src/core/region.js');
  const seed = await import('../src/core/world-seed.js');

  db = openDb(':memory:');
  campaignId = campaign.createCampaign(db, { name: 'Held', story_shape: 'sandbox' }).campaign_id;
  region.importRegion(db, campaignId, large, { source: 'generated' });
  seed.ensureWorld(db, campaignId);
  dione = region.findPlace(db, campaignId, 'Dione')!;
  factionId = store.listFactions(db, campaignId)[0]!.id;
}, 60_000);

/** Held clocks whose signs fired on days 1..count, so agenda `i` lands before agenda `i + 1`. */
function holdClocks(count: number): void {
  db.prepare('DELETE FROM world_agenda WHERE campaign_id = ?').run(campaignId);
  for (let i = 1; i <= count; i += 1) {
    store.insertAgenda(db, campaignId, {
      faction_id: factionId,
      template: 'raid',
      target_kind: 'settlement',
      target_id: dione.id,
      target_name: 'Dione',
      clock_size: 4,
      clock_filled: 4,
      portents: [{ text: `Sign ${i}: riders without banners water their horses at the ford.`, fired_day: i, heard: false }],
      status: 'held',
      started_day: 0,
    });
  }
}

const heldLines = (text: string): string[] => text.split('\n').filter((line) => line.includes(', agenda '));

describe('held clocks in the world block', () => {
  it('caps 50 held clocks at the most urgent, in order, with a tail, within budget', () => {
    holdClocks(50);
    const text = worldBriefing(db, campaignId, 'Dione');
    const lines = heldLines(text);

    expect(tokens.estimateTokens(text)).toBeLessThanOrEqual(tokens.WORLD_BRIEFING);
    expect(lines).toHaveLength(CAP);
    lines.forEach((line, index) => expect(line).toContain(`next sign: Sign ${index + 1}:`));
    const tail = text.split('\n').indexOf(`- +${50 - CAP} more (world get)`);
    expect(tail).toBeGreaterThan(0);
    expect(text.split('\n')[tail - 1]).toBe(lines.at(-1));
    expect(text).not.toContain('trimmed to fit');
  });

  it('adds no tail at or below the cap', () => {
    for (const count of [CAP, 3]) {
      holdClocks(count);
      const text = worldBriefing(db, campaignId, 'Dione');
      expect(heldLines(text)).toHaveLength(count);
      expect(text).not.toContain('more (world get)');
    }
  });

  it('counts one extra clock in the tail', () => {
    holdClocks(CAP + 1);
    expect(worldBriefing(db, campaignId, 'Dione')).toContain('- +1 more (world get)');
  });
});
