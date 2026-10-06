// One umbrella guard for the DM token budgets: a maximal campaign (large map, a seeded year, deeds and a
// loud NPC), then each briefing block measured against its own ceiling. A failure here means a block grew.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldFaction } from '../src/core/world-store.js';

const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;

const PARTY = 'Dione';
const NPC = 'Verbose Vex';
const SETUP_TIMEOUT = 300_000;

let db: Db;
let campaignId: number;
let client: Client;

let campaign: typeof import('../src/core/campaign.js');
let store: typeof import('../src/core/world-store.js');
let codex: typeof import('../src/core/codex.js');
let budget: typeof import('../src/core/token-budget.js');
let worldBriefing: (typeof import('../src/core/world-briefing.js'))['worldBriefing'];
let regionBriefing: (typeof import('../src/core/region-briefing.js'))['regionBriefing'];

function words(count: number, base: string): string {
  return Array.from({ length: count }, (_, i) => `${base}${i}`).join(' ');
}

/** The `Present:` lines only - the per-NPC digests, without the index below them. */
function presentDigests(block: string): string[] {
  const lines = block.split('\n');
  const rest = lines.slice(lines.indexOf('Present:') + 1);
  const end = rest.findIndex((line) => line.startsWith('Known '));
  const presentLines = end === -1 ? rest : rest.slice(0, end);
  const digests: string[] = [];
  for (const line of presentLines) {
    if (line.startsWith('- ')) digests.push(line);
    else if (digests.length > 0) digests[digests.length - 1] += `\n${line}`;
  }
  return digests;
}

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  const { openDb } = await import('../src/db/connection.js');
  const region = await import('../src/core/region.js');
  const seed = await import('../src/core/world-seed.js');
  const calendar = await import('../src/core/calendar.js');
  const { createGameServer } = await import('../src/mcp/server.js');
  campaign = await import('../src/core/campaign.js');
  store = await import('../src/core/world-store.js');
  codex = await import('../src/core/codex.js');
  budget = await import('../src/core/token-budget.js');
  ({ worldBriefing } = await import('../src/core/world-briefing.js'));
  ({ regionBriefing } = await import('../src/core/region-briefing.js'));

  db = openDb(':memory:');

  // Pin the world's seed and its year of ticks so every run builds and advances the same realm.
  let state = 42;
  const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  try {
    campaignId = campaign.createCampaign(db, { name: 'The Budget Year', story_shape: 'sandbox' }).campaign_id;
    region.importRegion(db, campaignId, large, { source: 'generated' });
    seed.ensureWorld(db, campaignId);
    campaign.saveCheckpoint(db, {
      campaign_id: campaignId,
      scene_summary: 'They settle in for the year.',
      scene_location: PARTY,
    });
    calendar.advanceTime(db, campaignId, { days: 360 });
  } finally {
    spy.mockRestore();
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'dm-token-budget', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);

  // A few deeds through the world tool, so attitudes and events crowd the briefings.
  const factions: WorldFaction[] = store.listFactions(db, campaignId);
  const deeds: Array<{ target: string; value: number; reason: string }> = [
    { target: factions[0]!.name, value: 4, reason: 'broke the long siege' },
    { target: factions[1]!.name, value: -3, reason: 'burned their granary' },
    { target: factions[2]!.name, value: 2, reason: 'cleared the toll road' },
  ];
  for (const deed of deeds) {
    const result = await client.callTool({ name: 'world', arguments: { campaign_id: campaignId, op: 'deed', ...deed } });
    expect(result.isError, `deed: ${deed.reason}`).toBeFalsy();
  }

  // An NPC in the scene with a deliberately maximal voice card.
  codex.upsertEntity(db, {
    campaign_id: campaignId,
    kind: 'npc',
    name: NPC,
    summary: words(60, 'summary'),
    voice: {
      speech_pattern: words(200, 'speech'),
      catchphrase: words(200, 'catch'),
      goal: words(200, 'goal'),
      fear: words(200, 'fear'),
      attitude: words(200, 'attitude'),
    },
  });
  // Close on a scene that names the NPC, so the codex block lists them as present.
  campaign.saveCheckpoint(db, {
    campaign_id: campaignId,
    scene_summary: `${NPC} holds court at ${PARTY} while the year turns.`,
    scene_location: PARTY,
  });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await client.close();
});

describe('the DM token budgets on a maximal campaign', () => {
  it('holds every briefing block within the ceiling the owner set', async () => {
    const world = worldBriefing(db, campaignId, PARTY);
    const region = regionBriefing(db, campaignId, PARTY);
    const codexBlock = campaign.campaignSnapshot(db, campaignId).codex_briefing;
    const npcDigests = presentDigests(codexBlock);

    const result = await client.callTool({ name: 'world', arguments: { campaign_id: campaignId, op: 'get' } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    const json = JSON.stringify(result.structuredContent ?? {});
    const worldGet = budget.estimateTokens(text) + budget.estimateTokens(json);

    const sizes = {
      world: budget.estimateTokens(world),
      region: budget.estimateTokens(region),
      world_get: worldGet,
      npcs: npcDigests.map((digest) => budget.estimateTokens(digest)),
    };
    console.log(`[dm-token-budget] ${JSON.stringify(sizes)}`);

    expect(budget.estimateTokens(world), `world block (${sizes.world} tokens)`).toBeLessThanOrEqual(
      budget.WORLD_BRIEFING,
    );
    expect(budget.estimateTokens(region), `region block (${sizes.region} tokens)`).toBeLessThanOrEqual(
      budget.REGION_BRIEFING,
    );
    expect(result.isError).toBeFalsy();
    expect(worldGet, `world get text + JSON (${worldGet} tokens)`).toBeLessThanOrEqual(budget.WORLD_GET);

    expect(npcDigests.length, 'no present NPC digest was found').toBeGreaterThan(0);
    expect(
      npcDigests.some((digest) => digest.includes(`- ${NPC} (npc, alive)`)),
      'the maximal NPC should be present in the scene',
    ).toBe(true);
    for (const digest of npcDigests) {
      expect(budget.estimateTokens(digest), `an NPC digest (${budget.estimateTokens(digest)} tokens): ${digest}`)
        .toBeLessThanOrEqual(budget.NPC_DIGEST);
    }

    expect(budget.QUARTER_COUNCIL).toBe(800);
  }, 120_000);
});
