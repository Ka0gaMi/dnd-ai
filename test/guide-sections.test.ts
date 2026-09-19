import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function readGuideSection(client: Client, section: string): Promise<{ text: string; found: boolean }> {
  const result = await client.callTool({ name: 'read_guide', arguments: { section } });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as { text: string; found: boolean };
}

const GUIDE_DIR = fileURLToPath(new URL('../docs/guide', import.meta.url));
const DM_INSTRUCTIONS = fileURLToPath(new URL('../docs/dm-instructions.md', import.meta.url));
const README = fileURLToPath(new URL('../README.md', import.meta.url));

describe('the split combat guide', () => {
  it('keeps the fight loop in combat and moves the effects sections into combat-effects', async () => {
    const client = await connect();
    const effects = await readGuideSection(client, 'combat-effects');
    expect(effects.found).toBe(true);
    expect(effects.text).toContain('Conditions and ongoing effects');

    const combat = await readGuideSection(client, 'combat');
    expect(combat.found).toBe(true);
    expect(combat.text).not.toContain('Conditions and ongoing effects');
    expect(combat.text).toContain('When to start an encounter');
    expect(combat.text).toContain('The turn loop');
  });
});

describe('the documents the DM reads', () => {
  /** The 60 names the op-merge retired; any one of them in a DM-facing doc is a stale call. */
  const OLD_NAMES = [
    'apply_damage',
    'heal',
    'set_temp_hp',
    'set_condition',
    'set_combat_condition',
    'death_save',
    'stabilize',
    'set_exhaustion',
    'prepare_spells',
    'learn_spell',
    'grant_spell',
    'use_spell_slot',
    'add_language',
    'grant_language',
    'create_companion',
    'retire_companion',
    'promote_companion',
    'list_party',
    'grant_inspiration',
    'spend_inspiration',
    'adjust_gold',
    'add_item',
    'remove_item',
    'equip_item',
    'list_inventory',
    'use_item',
    'sell_item',
    'award_xp',
    'grant_level',
    'apply_effect',
    'end_effect',
    'set_story_outline',
    'add_act',
    'open_chapter',
    'advance_chapter',
    'add_plot_thread',
    'update_plot_thread',
    'plant_clue',
    'find_clue',
    'add_rumour',
    'get_rumours',
    'advance_time',
    'set_calendar',
    'upsert_entity',
    'link_entities',
    'get_entity',
    'set_voice_card',
    'entity_tree',
    'propose_feature',
    'propose_subclass',
    'propose_spell',
    'create_background',
    'get_play_profile',
    'save_to_library',
    'list_library',
    'add_canon_fact',
    'add_glossary_entry',
    'save_checkpoint',
    'end_session',
    'list_campaigns',
  ];

  /**
   * Lines whose old-looking token is a JSON field or a Homebrew schema value, never a tool call.
   * Each pattern is the surrounding value shape, so a real stale call still fails the scan.
   */
  const VALUE_CONTEXTS: RegExp[] = [
    /advance_time:/, // rest's advance_time field
    /promote_companion/, // a death_options value
    /end_session'/, // a death_options value
    /`heal`, `death_save`/, // homebrew if.kind values
    /hp_max\/heal\//, // homebrew bonus target
    /attack\/save\/auto\/heal\/utility/, // homebrew effect kind values
    /`grant_inspiration` \| Heroic Inspiration/, // homebrew do kind value
    /`auto`, `heal` or `utility`/, // progression effect kind values
  ];

  /** A retired name that is really a live op (`{op: heal}`) or a merged-button (`{a|heal}`) is fine. */
  function isOpValue(line: string, name: string, index: number): boolean {
    const before = line.slice(0, index);
    return /\{op: ['"]?$/.test(before) || /\|$/.test(before);
  }

  function staleNames(file: string, text: string): string[] {
    const found: string[] = [];
    text.replace(/\r\n/g, '\n')
      .split('\n')
      .forEach((line, index) => {
        if (VALUE_CONTEXTS.some((pattern) => pattern.test(line))) return;
        for (const name of OLD_NAMES) {
          const pattern = new RegExp(`\\b${name}\\b`, 'g');
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(line)) !== null) {
            if (isOpValue(line, name, match.index)) continue;
            found.push(`${file}:${index + 1}: ${name}`);
          }
        }
      });
    return found;
  }

  it('names no retired tool anywhere the DM reads', () => {
    const guideFiles = readdirSync(GUIDE_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(GUIDE_DIR, name));
    const hits = guideFiles.flatMap((file) => staleNames(file, readFileSync(file, 'utf8')));
    const readme = readFileSync(README, 'utf8').replace(/\r\n/g, '\n');
    const toolsStart = readme.indexOf('## Tools');
    const toolsSection = readme.slice(toolsStart, readme.indexOf('\n## ', toolsStart + 1));
    hits.push(...staleNames('README.md (Tools)', toolsSection));
    hits.push(...staleNames('docs/dm-instructions.md', readFileSync(DM_INSTRUCTIONS, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('keeps dm-instructions under the ChatGPT character cap', () => {
    const text = readFileSync(DM_INSTRUCTIONS, 'utf8').replace(/\r\n/g, '\n');
    expect(text.length).toBeLessThanOrEqual(4500);
  });
});
