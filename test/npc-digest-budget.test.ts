import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { codexBriefing, upsertEntity, type VoiceCard } from '../src/core/codex.js';
import { openDb, type Db } from '../src/db/connection.js';
import {
  estimateTokens,
  NPC_DIGEST,
  QUARTER_COUNCIL,
  REGION_BRIEFING,
  WORLD_BRIEFING,
  WORLD_GET,
} from '../src/core/token-budget.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Digest Budget', story_shape: 'sandbox' }).campaign_id;
});

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

describe('estimateTokens', () => {
  it('is a quarter of the character count, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('DM token budgets', () => {
  it('carries the ceilings decided for this milestone', () => {
    expect(WORLD_BRIEFING).toBe(1500);
    expect(REGION_BRIEFING).toBe(1200);
    expect(QUARTER_COUNCIL).toBe(800);
    expect(NPC_DIGEST).toBe(250);
    expect(WORLD_GET).toBe(2500);
  });
});

describe('present NPC digest', () => {
  const maximal: VoiceCard = {
    speech_pattern: words(200, 'speech'),
    catchphrase: words(200, 'catch'),
    goal: words(200, 'goal'),
    fear: words(200, 'fear'),
    attitude: words(200, 'attitude'),
  };

  it('caps a maximal voice card at the per-NPC budget, most important field first', () => {
    upsertEntity(db, {
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Verbose',
      summary: words(60, 'summary'),
      voice: maximal,
    });
    const [digest = ''] = presentDigests(codexBriefing(db, campaignId, { present: ['Verbose'] }));
    expect(estimateTokens(digest)).toBeLessThanOrEqual(NPC_DIGEST);
    expect(digest).toContain('…');
    expect(digest).toContain('speech0');
    expect(digest).not.toContain('attitude0');
  });

  it('holds every present NPC to its own budget', () => {
    for (const name of ['Verbose', 'Windbag']) {
      upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name, summary: words(60, 'summary'), voice: maximal });
    }
    const digests = presentDigests(codexBriefing(db, campaignId, { present: ['Verbose', 'Windbag'] }));
    expect(digests).toHaveLength(2);
    for (const digest of digests) expect(estimateTokens(digest)).toBeLessThanOrEqual(NPC_DIGEST);
  });

  it('leaves a short voice card exactly as written', () => {
    upsertEntity(db, {
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Mira',
      summary: 'The innkeeper of Ashfall.',
      voice: { speech_pattern: 'Short sentences.', catchphrase: 'Coin first.', goal: 'buy back the deed' },
    });
    expect(presentDigests(codexBriefing(db, campaignId, { present: ['Mira'] }))).toEqual([
      [
        '- Mira (npc, alive) - The innkeeper of Ashfall.',
        '  voice: Short sentences. | "Coin first." | wants buy back the deed',
      ].join('\n'),
    ]);
  });
});
