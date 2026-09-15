import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { dealCreatureVariants, generateCombatantPortrait } from '../../core/auto-portraits.js';
import { generatePortrait, portraitsEnabled, PORTRAITS_DISABLED_MESSAGE } from '../../core/portraits.js';
import { reply } from './result.js';

export function registerPortraitTools(server: McpServer, db: Db): void {
  server.registerTool(
    'generate_portrait',
    {
      title: 'Generate portrait',
      description:
        'Portraits happen by themselves: the party gets one on creation, and a fight gets one per creature type plus one for anyone with a name of their own. Call this only to go beyond that - creature with variant true adds another face for that type, so its goblins stop looking alike (up to 4 per type), and combatant_id with a description redraws one fighter the way you describe them. character_id still redraws a party member. Portraits may be unavailable on this machine; then the tool says so and you simply carry on narrating (the player can drop in their own image). One portrait per subject per minute.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: z.number().int().optional().describe('The PC, companion or NPC to redraw, from list_party.'),
        creature: z
          .string()
          .optional()
          .describe('The creature type to draw, e.g. "Goblin Warrior". Its portrait is shared by every one of them.'),
        variant: z
          .boolean()
          .optional()
          .describe('With creature: add another portrait for that type instead of replacing the one it has.'),
        combatant_id: z
          .number()
          .int()
          .optional()
          .describe('A fighter in the active encounter, from get_battle_state: draws that one alone.'),
        description: z
          .string()
          .min(1)
          .describe('What they look like: face, hair, build, armour or clothing, mood. One or two sentences.'),
        style: z.enum(['painterly', 'ink', 'realistic']).optional().describe('Defaults to painterly.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ campaign_id, character_id, creature, variant, combatant_id, description, style }) => {
      if (!portraitsEnabled()) {
        return reply(db, campaign_id, { generated: false, enabled: false, message: PORTRAITS_DISABLED_MESSAGE });
      }
      const chosen = [character_id, creature, combatant_id].filter((value) => value !== undefined);
      if (chosen.length !== 1) {
        throw new Error('Pass exactly one of character_id (a party member), creature (a type) or combatant_id (one fighter).');
      }
      if (combatant_id !== undefined) {
        const drawn = await generateCombatantPortrait({ db, campaign_id, combatant_id, description, style });
        return reply(db, campaign_id, { generated: true, enabled: true, ...drawn });
      }
      const subject = character_id === undefined ? { creature: creature!, variant } : { character_id };
      const portrait = await generatePortrait({ db, campaign_id, subject, description, style });
      if (creature !== undefined) dealCreatureVariants(db, campaign_id, creature);
      return reply(db, campaign_id, { generated: true, enabled: true, ...portrait });
    },
  );
}
