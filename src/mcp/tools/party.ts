import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { createCompanion, promoteCompanion, retireCompanion } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { ABILITY_SCORES, WRITES } from './character-shared.js';

export function registerPartyTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'party', {
    title: 'Companions and the party',
    description:
      'A solo party is fragile; offer one early: companions are ally NPCs the DM plays, not player-controlled; they fight, take damage and can take over if the player dies. op=add builds one from source {class, species, background}: a level 1 character like create_character, defaults filled, an SRD or custom background\'s origin feat (level 1 only); or source {creature}, an SRD stat block by exact name (srd_lookup kind "creature"), no class or level, traits and attacks as "stat_block" features. op=retire writes one out for good: the sheet is kept, but they leave the party, briefing and death options; only when player and story agree, not while unconscious. op=promote hands the player a companion after their character dies: it becomes the player character keeping its sheet, the dead stay dead, once the player is gone. The briefing lists every party member with ids, and op=add returns the party.',
    fields: {
      campaign_id: z.number().int(),
      character_id: z
        .number()
        .int()
        .optional()
        .describe("(op=retire, op=promote) The companion, by id from the briefing or from op=add's reply."),
      name: z.string().optional().describe('(op=add) What the party calls them.'),
      source: z
        .union([
          z.object({
            class: z.string(),
            species: z.string(),
            lineage: z.string().optional().describe('Which lineage, for the species that have one; the error lists them.'),
            background: z.string(),
            level: z.number().int().optional(),
            abilities: ABILITY_SCORES.optional().describe('Leave out for the standard array assigned for the class.'),
            ability_bonuses: ABILITY_SCORES.partial().optional(),
            skill_choices: z.array(z.string()).optional(),
            equipment_choice: z.union([z.string(), z.number().int()]).optional(),
            cantrips: z.array(z.string()).optional(),
            spells: z.array(z.string()).optional(),
          }),
          z.object({ creature: z.string().describe('An exact SRD creature name, e.g. "Wolf".') }),
        ])
        .optional()
        .describe('(op=add) How the companion is built: a class-and-species character, or an SRD creature stat block.'),
      personality: z.string().optional().describe('(op=add) A line or two on how they behave; stored as a canon fact.'),
      backstory: z.string().optional().describe('(op=add) Their history before they joined; stored as a canon fact too.'),
    },
    ops: {
      add: {
        summary: 'Create a companion from a class or an SRD stat block',
        requires: ['name', 'source'],
        uses: ['personality', 'backstory'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, createCompanion(db, { ...input, name: input.name!, source: input.source! }));
        },
      },
      retire: {
        summary: 'Write a companion out of the party',
        requires: ['character_id'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, retireCompanion(db, { ...input, character_id: input.character_id! }));
        },
      },
      promote: {
        summary: 'Hand a companion to the player after the player character dies',
        requires: ['character_id'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, promoteCompanion(db, { ...input, character_id: input.character_id! }));
        },
      },
    },
    annotations: { ...WRITES },
  });
}
