import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addLanguage, grantLanguage } from '../../core/character.js';
import { reply } from './result.js';
import { CHARACTER_ID, WRITES } from './character-shared.js';

export function registerLanguageTools(server: McpServer, db: Db): void {
  server.registerTool(
    'add_language',
    {
      title: 'Add a language to the campaign',
      description:
        'Invents a language for this world: who speaks it and what it is written in. It joins the SRD languages wherever one is chosen or granted, and appears in the glossary so the rest of the story can use it. Use it for a tongue the setting needs; grant_language then gives it to a character.',
      inputSchema: {
        campaign_id: z.number().int(),
        name: z.string().describe('What it is called, e.g. "Old Ashfallen".'),
        speakers: z.string().describe('Who speaks it, e.g. "the drowned court and its servants".'),
        script: z.string().optional().describe('What it is written in, if anything.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, addLanguage(db, input)),
  );

  server.registerTool(
    'grant_language',
    {
      title: 'Teach a character a language',
      description:
        'Adds a language to the character sheet: a season with a tutor, a year in a foreign city, a spell or a boon. Use it when the story earns it, not to paper over a failed conversation - a character who does not know a language gets no roll at all.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string().describe('An SRD language or one added with add_language.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantLanguage(db, input)),
  );
}
