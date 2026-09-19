import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { createCompanion, listParty, promoteCompanion, retireCompanion } from '../../core/character.js';
import { reply } from './result.js';
import { ABILITY_SCORES, CHARACTER_ID, READS, WRITES } from './character-shared.js';

export function registerPartyTools(server: McpServer, db: Db): void {
  server.registerTool(
    'create_companion',
    {
      title: 'Add a companion to the party',
      description:
        'Builds a full sheet for a companion who travels with the player - an ally NPC the player does not control, but who fights, takes damage and can later take over if the player character dies. A party of one is fragile, so offer a companion early in a solo game. Two ways to build one: source {class, species, background} makes a level 1 character the same way create_character does, filling in anything you leave out (standard array assigned for the class, the background\'s +2/+1, the first equipment bundle, legal skill and spell picks); source {creature} copies an SRD stat block by exact name, e.g. "Wolf" or "Guard" - look the name up with srd_lookup kind "creature" first. A stat-block companion has no class or level: its traits and attacks arrive as features with source "stat_block", each carrying the attack bonus, reach or range and damage dice. Companions above level 1 are not supported yet.',
      inputSchema: {
        campaign_id: z.number().int(),
        name: z.string().describe('What the party calls them.'),
        source: z.union([
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
        ]),
        personality: z.string().optional().describe('A line or two on how they behave; stored as a canon fact.'),
        backstory: z.string().optional(),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, createCompanion(db, input)),
  );

  server.registerTool(
    'list_party',
    {
      title: 'List the party',
      description:
        'Lists everyone travelling with the player: the player character and every companion still in the party, each with their class or creature, level, HP, AC, conditions and Heroic Inspiration. Use it to get the character_id the other tools need, and to check who is still standing before you narrate a fight. It changes nothing.',
      inputSchema: { campaign_id: z.number().int() },
      annotations: { ...READS },
    },
    (input) => reply(db, input.campaign_id, listParty(db, input)),
  );

  server.registerTool(
    'retire_companion',
    {
      title: 'Retire a companion',
      description:
        'Takes a companion out of the party for good - they stay behind, part ways or are written out of the story. Their sheet is kept but they stop appearing in the party, the briefing and the death options. Use it only when the player and the story agree they are gone, not when they are merely unconscious.',
      inputSchema: { campaign_id: z.number().int(), character_id: z.number().int() },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, retireCompanion(db, input)),
  );

  server.registerTool(
    'promote_companion',
    {
      title: 'Promote a companion to player character',
      description:
        "Hands the player a companion to play after their character has died: the companion becomes the player character, keeping their own sheet, while the dead character stays dead in the record. This is the promote_companion option in death_options, and it only works once the player character is dead or retired. Returns the new sheet - read back its HP, AC and what it can do, then continue the scene from the survivor's point of view.",
      inputSchema: { campaign_id: z.number().int(), character_id: z.number().int() },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, promoteCompanion(db, input)),
  );
}
