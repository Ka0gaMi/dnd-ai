import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { reply } from './result.js';

export const GUIDE_SECTIONS = ['story', 'rolls', 'combat', 'combat-effects', 'class-features', 'codex', 'progression', 'homebrew', 'items', 'region', 'world'] as const;
export type GuideSection = (typeof GUIDE_SECTIONS)[number];

/** Pages answered with their card and topic list; the others still come back whole until they are split. */
const TOPIC_PAGES: ReadonlySet<GuideSection> = new Set<GuideSection>(['combat', 'class-features']);

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

/** A topic's name: its `##` heading in lower case with hyphens, so "Turn loop" is `turn-loop`. */
export const topicName = (heading: string): string =>
  heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Splits a page at its `##` headings; the card is everything above the first one. */
export function guideTopics(text: string): { card: string; topics: Array<{ name: string; text: string }> } {
  const [card = '', ...parts] = text.replace(/\r\n/g, '\n').split(/^(?=## )/m);
  return {
    card: card.trim(),
    topics: parts.map((part) => ({ name: topicName(part.split('\n', 1)[0]!.slice(3)), text: part.trim() })),
  };
}

export function registerGuideTools(server: McpServer, db: Db): void {
  server.registerTool(
    'read_guide',
    {
      title: 'Read the DM guide',
      description:
        'Returns the detailed procedure for one area of play: story (acts, chapters, threads, clues, rumours, time, secrets, the journal), rolls (who rolls what and how the player rolls their own dice), combat (the turn loop and reactions), combat-effects (the rolls the player makes in a fight, conditions, ongoing effects and ending one), class-features (how every class feature is taken in play and what the engine leaves to you), codex (people, places and NPC voices), progression (levelling, homebrew and house rules), homebrew (how to write a mechanic the engine can run), items (magic items, attunement, charges, containers, coins and selling), region (the region map, travel distances and revealing places) or world (factions, agendas, portents, known clocks and recording what the party did to them). Call it before you run an area for the first time in a chat, and whenever you are unsure which tool comes next - it is longer and more exact than the tool descriptions. combat and class-features answer with a short card and their topic list; pass topic to read one. It reads a bundled page and changes nothing.',
      inputSchema: z.object({
        section: z.enum(GUIDE_SECTIONS),
        topic: z.string().optional().describe('One topic of the page, as its topic list names it (e.g. "turn-loop"). Leave it out for the card and the list.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ section, topic }) => {
      const guide = readGuide(section);
      if (!guide.found || (topic === undefined && !TOPIC_PAGES.has(section))) {
        return reply(db, null, guide as unknown as Record<string, unknown>, guide.text);
      }
      // Card and topic replies keep the text in content alone; structuredContent says only where it came from.
      const { card, topics } = guideTopics(guide.text);
      if (topic === undefined) {
        const list = topics.map((entry) => `- ${entry.name}`).join('\n');
        return reply(db, null, { section, found: true }, `${card}\n\nTopics - read_guide {section: "${section}", topic: "<name>"}:\n${list}`);
      }
      const match = topics.find((entry) => entry.name === topicName(topic));
      if (!match) {
        const names = topics.map((entry) => entry.name).join(', ');
        return { isError: true, content: [{ type: 'text', text: `No topic "${topic}" in the ${section} guide. Its topics: ${names}.` }] };
      }
      return reply(db, null, { section, topic: match.name, found: true }, match.text);
    },
  );
}
