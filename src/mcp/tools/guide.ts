import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { reply } from './result.js';

export const GUIDE_SECTIONS = ['story', 'rolls', 'combat', 'combat-effects', 'codex', 'progression', 'homebrew', 'items', 'region'] as const;
export type GuideSection = (typeof GUIDE_SECTIONS)[number];

const GUIDE_DIR = new URL('../../../docs/guide/', import.meta.url);

/** The written procedure for one area of play, or a clear message when that page is not bundled. */
export function readGuide(section: GuideSection): { section: GuideSection; text: string; found: boolean } {
  try {
    return { section, text: readFileSync(fileURLToPath(new URL(`${section}.md`, GUIDE_DIR)), 'utf8'), found: true };
  } catch {
    return {
      section,
      text: `No guide page for "${section}" is bundled with this server. Run the area from the tool descriptions instead.`,
      found: false,
    };
  }
}

export function registerGuideTools(server: McpServer, db: Db): void {
  server.registerTool(
    'read_guide',
    {
      title: 'Read the DM guide',
      description:
        'Returns the detailed procedure for one area of play: story (acts, chapters, threads, clues, rumours, time, secrets, the journal), rolls (who rolls what and how the player rolls their own dice), combat (the turn loop and reactions), combat-effects (the rolls the player makes in a fight, conditions, ongoing effects and ending one), codex (people, places and NPC voices), progression (levelling, homebrew and house rules), homebrew (how to write a mechanic the engine can run), items (magic items, attunement, charges, containers, coins and selling) or region (the region map, travel distances and revealing places). Call it before you run an area for the first time in a chat, and whenever you are unsure which tool comes next - it is longer and more exact than the tool descriptions. It reads a bundled page and changes nothing.',
      inputSchema: { section: z.enum(GUIDE_SECTIONS) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ section }) => {
      const guide = readGuide(section);
      return reply(db, null, guide as unknown as Record<string, unknown>, guide.text);
    },
  );
}
