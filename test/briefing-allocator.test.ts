// The briefing's one envelope: sections fill by tier under a total, must-act is never trimmed, and a trimmed
// section keeps its heading and ends with "+N more". The second half squeezes a busy campaign through load_campaign.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  allocateBriefing,
  BACKGROUND,
  MUST_ACT,
  NEAR_PARTY,
  type BriefingSection,
} from '../src/core/briefing-allocator.js';
import { BRIEFING_ENVELOPE, estimateTokens, RUMOURS } from '../src/core/token-budget.js';
import type { Db } from '../src/db/connection.js';
import { replyText } from './helpers/reply.js';

const lines = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `- ${prefix} ${i} ${'x'.repeat(36)}`);

/** The lines from `heading` up to the next blank line. */
const block = (text: string, heading: string): string[] => {
  const all = text.split('\n');
  const start = all.indexOf(heading);
  if (start === -1) return [];
  const end = all.indexOf('', start);
  return all.slice(start, end === -1 ? undefined : end);
};

describe('allocateBriefing', () => {
  const must: BriefingSection = { tier: MUST_ACT, head: ['# Must', ...lines('must', 10)] };
  const near: BriefingSection = { tier: NEAR_PARTY, head: ['', '## Near'], items: lines('near', 10), more: 'near {op: get}' };
  const far: BriefingSection = { tier: BACKGROUND, head: ['', '## Far'], items: lines('far', 10), more: 'far {op: get}' };

  it('renders every line in display order when the budget allows', () => {
    const text = allocateBriefing([must, far, near], 10_000);
    expect(text).toBe([...must.head, ...far.head, ...far.items!, ...near.head, ...near.items!].join('\n'));
    expect(text).not.toContain('more');
  });

  it('fills the near tier before the background, trimming with a "+N more" pointer', () => {
    const full = estimateTokens(allocateBriefing([must, near], 10_000));
    const text = allocateBriefing([must, far, near], full + 40);
    expect(block(text, '## Near')).toEqual(['## Near', ...near.items!]);
    const farBlock = block(text, '## Far');
    expect(farBlock[0]).toBe('## Far');
    expect(farBlock.length).toBeLessThan(far.items!.length + 1);
    const shown = farBlock.length - 2;
    expect(farBlock.slice(1, -1)).toEqual(far.items!.slice(0, shown));
    expect(farBlock.at(-1)).toBe(`+${far.items!.length - shown} more — far {op: get}`);
  });

  it('never trims must-act, and keeps every heading when nothing else fits', () => {
    const text = allocateBriefing([must, near, far], 10);
    expect(text).toBe([...must.head, '', '## Near', '+10 more — near {op: get}', '', '## Far', '+10 more — far {op: get}'].join('\n'));
  });

  it('stays within the budget at every size the must-act part leaves room for', () => {
    const floor = estimateTokens(allocateBriefing([must, near, far], 0));
    for (let budget = floor; budget <= floor + 400; budget += 7) {
      const text = allocateBriefing([must, near, far], budget);
      expect(estimateTokens(text), `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(text).toContain(must.head.join('\n'));
    }
  });

  it('drops the oldest first from an oldest-first list, and holds a section to its own cap', () => {
    const list: BriefingSection = { tier: BACKGROUND, head: ['', '## Heard'], items: lines('rumour', 20), oldestFirst: true, cap: 60 };
    const text = allocateBriefing([list], 10_000);
    expect(estimateTokens(text)).toBeLessThanOrEqual(60);
    const shown = block(text, '## Heard');
    expect(shown.at(-2)).toBe(list.items!.at(-1));
    expect(shown.at(-1)).toMatch(/^\+\d+ more$/);
  });

  it('joins an inline section onto one line, counting the items it cut', () => {
    const items = ['Alderwood', 'Brackenmoor', 'Cindervale', 'Duskwater', 'Emberfall', 'Frostmere'];
    const terms: BriefingSection = { tier: BACKGROUND, head: ['## Terms'], items, inline: ', ' };
    expect(allocateBriefing([terms], 10_000)).toBe(`## Terms\n${items.join(', ')}`);
    const [heading, shown, more] = allocateBriefing([terms], 12).split('\n');
    expect(heading).toBe('## Terms');
    const kept = shown!.split(', ');
    expect(kept).toEqual(items.slice(0, kept.length));
    expect(more).toBe(`+${items.length - kept.length} more`);
  });
});

describe('load_campaign on a busy campaign', () => {
  const medium = JSON.parse(readFileSync(new URL('./fixtures/realm-medium.json', import.meta.url), 'utf8')) as unknown;
  const REMINDER = 'Next: checkpoint {op: save}';
  let db: Db;
  let id: number;
  let client: Client;
  let stopClicking: () => void;
  let campaign: typeof import('../src/core/campaign.js');
  let renderBriefing: (typeof import('../src/mcp/tools/campaign.js'))['renderBriefing'];
  let getSettings: (typeof import('../src/core/settings.js'))['getSettings'];

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${replyText(result)}`);
    return replyText(result);
  };
  const load = (): Promise<string> => call('load_campaign', { campaign_id: id });
  /** The whole briefing with room for everything, so the squeeze can be measured. */
  const unsqueezed = (): string => renderBriefing(campaign.campaignSnapshot(db, id), getSettings(db, id), 1e9);

  beforeAll(async () => {
    // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
    vi.resetModules();
    const { openDb } = await import('../src/db/connection.js');
    const region = await import('../src/core/region.js');
    const seed = await import('../src/core/world-seed.js');
    const calendar = await import('../src/core/calendar.js');
    const story = await import('../src/core/story.js');
    const codex = await import('../src/core/codex.js');
    const { createGameServer } = await import('../src/mcp/server.js');
    const { resolvePendingRollsImmediately } = await import('./helpers.js');
    campaign = await import('../src/core/campaign.js');
    ({ renderBriefing } = await import('../src/mcp/tools/campaign.js'));
    ({ getSettings } = await import('../src/core/settings.js'));

    db = openDb(':memory:');
    stopClicking = resolvePendingRollsImmediately(db);
    let state = 42;
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    });
    try {
      id = campaign.createCampaign(db, {
        name: 'The Crowded Year',
        story_shape: 'structured',
        premise: 'A river kingdom frays at its edges while old houses scheme for the crown.',
        settings: { setting_preset: 'classic-fantasy', lines: 'no harm to children', veils: 'torture' },
      }).campaign_id;
      region.importRegion(db, id, medium, { source: 'generated' });
      seed.ensureWorld(db, id);
      const place = (
        db.prepare("SELECT name FROM world_place WHERE campaign_id = ? AND kind = 'settlement' ORDER BY id LIMIT 1").get(id) as {
          name: string;
        }
      ).name;
      campaign.saveCheckpoint(db, { campaign_id: id, scene_summary: 'They arrive.', scene_location: place });
      calendar.advanceTime(db, id, { days: 360 });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: 'briefing-allocator', version: '0.0.0' });
      await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
      await call('create_character', {
        campaign_id: id,
        name: 'Borg',
        species: 'Dwarf',
        class: 'Fighter',
        background: 'Soldier',
        ability_method: 'standard_array',
        abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
        ability_bonuses: { str: 2, con: 1 },
        skill_choices: ['athletics', 'perception'],
      });

      story.setStoryOutline(db, { campaign_id: id, ending: 'The crown passes to whoever holds the fords.', secret_notes: 'The regent poisons the wells.' });
      story.openChapter(db, { campaign_id: id, title: 'Ashes at the Ford', goal: 'Find who burned the toll house' });
      for (let c = 0; c < 4; c++) {
        story.advanceChapter(db, {
          campaign_id: id,
          title: `Chapter ${c + 2}`,
          summary: `The party chased smugglers across three villages, lost a friend at mill ${c}, and learned the regent's seal was forged.`,
        });
      }
      for (let i = 0; i < 12; i++) {
        const thread = story.addPlotThread(db, {
          campaign_id: id,
          title: `Who paid ferryman ${i}`,
          summary: `The ferryman at crossing ${i} was paid in old crowns stamped with a broken tower, the sign of the exiled house.`,
        });
        if (i < 8) story.plantClue(db, { campaign_id: id, text: `A broken-tower crown under the floor of hut ${i}.`, thread_id: thread.id });
      }
      await call('update_objectives', {
        campaign_id: id,
        quests: Array.from({ length: 6 }, (_, i) => ({
          title: `The river toll ${i}`,
          kind: i === 0 ? 'main' : 'side',
          summary: `Recover toll ledger ${i} before the regent's men burn it, and bring it to the abbess.`,
          steps: [{ text: `Reach toll house ${i}` }, { text: `Find ledger ${i}` }, { text: 'Bring it to the abbess' }],
        })),
      });
      for (let i = 0; i < 40; i++) {
        campaign.addCanonFact(db, {
          campaign_id: id,
          subject: `Hollow ${i}`,
          fact: `The miller's daughter at Hollow ${i} owes the river guild ${i + 10} crowns, keeps the ferry ledgers, and has sworn before the abbess to see the regent hanged.`,
        });
      }
      for (let i = 0; i < 12; i++) {
        story.addRumour(db, {
          campaign_id: id,
          scope: 'region',
          truth: i % 3 ? 'false' : 'twisted',
          text: `Rumour ${i}: the old abbess walks the walls at night with a lantern that burns green, and whoever follows her down into the crypt comes back speaking a tongue nobody in the valley has heard for a hundred years.`,
        });
      }
      story.getRumours(db, id, { limit: 12, mark_heard: true });
      for (let i = 0; i < 5; i++) {
        story.addJournalEntry(db, {
          campaign_id: id,
          text: `Day ${i}: I think the abbess lies about the crypt. Mira says the lantern is green from copper salts, but I saw it move by itself. Ask the ferryman again.`,
        });
      }
      for (let i = 0; i < 60; i++) {
        codex.upsertEntity(db, { campaign_id: id, kind: i % 3 ? 'npc' : 'place', name: `Codex Name ${i}`, summary: `Someone or somewhere of note, number ${i}.` });
      }
      for (const name of ['Codex Name 1', 'Codex Name 2']) {
        const voice = 'clipped, wary, always counting coins under the table while they talk';
        codex.upsertEntity(db, { campaign_id: id, kind: 'npc', name, voice: { speech_pattern: voice, catchphrase: voice, goal: voice, fear: voice } });
      }
      for (let i = 0; i < 40; i++) campaign.addGlossaryEntry(db, { campaign_id: id, term: `Valley word ${i}`, definition: 'Slang of the valley.' });
      // Deeds through the world tool, so attitudes crowd the world block.
      const factions = (await import('../src/core/world-store.js')).listFactions(db, id);
      for (const [index, value] of [4, -3, 2].entries()) {
        await call('world', { campaign_id: id, op: 'deed', target: factions[index]!.name, value, reason: `deed number ${index}` });
      }
      campaign.saveCheckpoint(db, { campaign_id: id, scene_summary: `Codex Name 1 and Codex Name 2 meet the party at ${place}.`, scene_location: place });
      // Past the reply's nag threshold, so the checkpoint reminder rides on the briefing too.
      for (let i = 0; i < 30; i++) {
        campaign.logEvent(db, { campaign_id: id, kind: 'note', text: `Event ${i}: the party bargained with the toll keeper for passage over the swollen river.` });
      }
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

  afterAll(async () => {
    stopClicking();
    await client.close();
  });

  it('fits the envelope, with the rumours under their cap, though the whole briefing would not', async () => {
    const full = unsqueezed();
    const text = await load();
    console.log(`[briefing-allocator] unsqueezed ${estimateTokens(full)} tokens, load_campaign ${estimateTokens(text)}`);
    expect(estimateTokens(full)).toBeGreaterThan(BRIEFING_ENVELOPE);
    expect(estimateTokens(text)).toBeLessThanOrEqual(BRIEFING_ENVELOPE);
    expect(text).toContain(REMINDER);

    const heard = block(text, '## Heard (rumours the player already has)');
    expect(estimateTokens(heard.join('\n'))).toBeLessThanOrEqual(RUMOURS);
    // No pointer: rumour {op: get} would hand out new rumours, not re-list heard ones.
    expect(heard.at(-1)).toMatch(/^\+\d+ more$/);
    const newest = campaign.campaignSnapshot(db, id).rumours.at(-1)!;
    expect(heard).toContain(`- [region] ${newest.text} (${newest.truth}, id ${newest.id})`);

    // No heading is lost: every one in the whole briefing is still there.
    const headings = full.split('\n').filter((line) => line.startsWith('## ') || line.startsWith('World (DM only'));
    expect(headings.length).toBeGreaterThan(15);
    for (const heading of headings) expect(text).toContain(`\n${heading}\n`);
  });

  it('keeps the must-act sections whole through the squeeze', async () => {
    await call('start_encounter', {
      campaign_id: id,
      seed: 7,
      terrain: 'road',
      size: 'small',
      features: ['road'],
      enemies: [{ creature: 'Goblin Warrior', count: 3 }],
    });
    const full = unsqueezed();
    const text = await load();
    expect(estimateTokens(text)).toBeLessThanOrEqual(BRIEFING_ENVELOPE);
    for (const heading of ['## Combat in progress', '## Open quests', '## How this table runs', '## Setting']) {
      expect(block(text, heading), heading).toEqual(block(full, heading));
    }
    expect(block(text, '## Combat in progress')).toHaveLength(2 + 4);
    expect(block(text, '## Open quests')).toHaveLength(1 + 6 * 4);

    // A hard squeeze leaves must-act whole (canon facts included, since no read shows them again) and trims the rest.
    const tight = renderBriefing(campaign.campaignSnapshot(db, id), getSettings(db, id), 1_000);
    expect(block(tight, '## Open quests')).toEqual(block(full, '## Open quests'));
    expect(block(tight, '## Combat in progress')).toEqual(block(full, '## Combat in progress'));
    const facts = '## Canon facts (established, do not contradict)';
    expect(block(tight, facts)).toEqual(block(full, facts));
    expect(block(tight, '## Last events').at(-1)).toMatch(/^\+\d+ more$/);
  });
});
