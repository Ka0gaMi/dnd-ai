import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { createCompanion, promoteCompanion, retireCompanion } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { ABILITY_SCORES, WRITES } from './character-shared.js';
import { CAMPAIGN_ID } from './fields.js';

export function registerPartyTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'party', {
    title: 'Companions and the party',
    description:
      'Companions are ally NPCs the DM plays: they fight, take damage and can take over if the player dies, so offer one early - a solo party is fragile. op=add builds one from source {class, species, background}, a level 1 character like create_character with defaults filled, or {creature}, an SRD stat block by exact name with no class or level and its traits and attacks as "stat_block" features. op=retire writes one out for good: the sheet is kept, but they leave the party, the briefing and the death options; only when player and story agree, never while unconscious. op=promote makes a companion the player character once the player character has died; the dead stay dead. The briefing lists the party with ids.',
    fields: {
      campaign_id: CAMPAIGN_ID,
      character_id: z
        .number()
        .int()
        .optional()
        .describe("(op=retire, op=promote) The companion's id, from the briefing or op=add."),
      name: z.string().optional().describe('(op=add) What the party calls them.'),
      source: z
        .union([
          z.object({
            class: z.string(),
            species: z.string(),
            lineage: z.string().optional().describe('For the species that have one; the error lists them.'),
            background: z.string(),
            level: z.number().int().optional(),
            abilities: ABILITY_SCORES.optional().describe('Leave out for the class standard array.'),
            ability_bonuses: ABILITY_SCORES.partial().optional(),
            skill_choices: z.array(z.string()).optional(),
            equipment_choice: z.union([z.string(), z.number().int()]).optional(),
            cantrips: z.array(z.string()).optional(),
            spells: z.array(z.string()).optional(),
          }),
          z.object({ creature: z.string().describe('An exact SRD creature name, e.g. "Wolf".') }),
        ])
        .optional()
        .describe('(op=add) A class-and-species build, or an SRD creature stat block.'),
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
