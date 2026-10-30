import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { getCharacterSheet } from '../../core/campaign.js';
import { createCharacter, listCharacterOptions } from '../../core/character.js';
import { srdSearch } from '../../srd/lookup.js';
import { reply } from './result.js';
import { ABILITY_SCORES, READS, WRITES } from './character-shared.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';

export function registerCharacterTools(server: McpServer, db: Db): void {
  server.registerTool(
    'get_character_sheet',
    {
      title: 'Get character sheet',
      description:
        'Returns a character\'s full sheet - level, HP, AC, abilities, saves, skills, features, spells, inventory, conditions, inspiration, hit dice, proficiency, initiative, passive Perception - plus speed with speed_reason, stealth_disadvantage, concentration and the last long rest. Read exact numbers here rather than from memory. A companion built from a stat block has no class and carries its traits and attacks as "stat_block" features. Null means there is no character yet: character creation still has to happen.',
      inputSchema: z.object({ campaign_id: CAMPAIGN_ID, character_id: CHARACTER_ID }),
      annotations: { ...READS },
    },
    ({ campaign_id, character_id }) =>
      reply(db, campaign_id, { character: getCharacterSheet(db, campaign_id, character_id) }),
  );

  server.registerTool(
    'list_character_options',
    {
      title: 'List character creation options',
      description:
        "Lists the SRD choices for a level 1 character: classes, species, backgrounds, languages and the ability-score methods. Name a class, species or background to get it in detail: proficiency choices and counts, equipment bundles, level 1 features and which are choices, species traits, the background feat, and a caster's cantrip and spell counts with the legal picks. Interview the player one question at a time from this, never from memory.",
      inputSchema: z.object({
        class: z.string().optional().describe('e.g. "Rogue": that class in detail.'),
        species: z.string().optional().describe('e.g. "Elf"'),
        background: z.string().optional().describe('e.g. "Sage"'),
        campaign_id: CAMPAIGN_ID.optional().describe('Also lists the custom backgrounds saved in that campaign.'),
      }),
      annotations: { ...READS },
    },
    (input) => reply(db, input.campaign_id ?? null, listCharacterOptions(input, db)),
  );

  server.registerTool(
    'srd_lookup',
    {
      title: 'Look up an SRD rule',
      description:
        'Searches the bundled SRD 5.2.1 by name (substring) and returns the real rules text, so your narration matches what the server enforces. A query naming one creature returns its full stat block; several matches return a compact list (pass exact true or limit 1 for the block). Run a fight from the stat block: roll its attack_bonus as "1d20+<bonus>" with roll_type "attack", and its damage as a separate roll.',
      inputSchema: z.object({
        kind: z.enum(['spell', 'class', 'species', 'background', 'feat', 'condition', 'rule', 'weapon', 'armor', 'item', 'creature']),
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional(),
        exact: z.boolean().optional().describe('Only the entry whose name matches exactly; for creatures this returns the stat block.'),
      }),
      annotations: { ...READS },
    },
    ({ kind, query, limit, exact }) =>
      reply(db, null, { kind, query, ...srdSearch(kind, query, limit ?? 5, exact ?? false) }),
  );

  server.registerTool(
    'create_character',
    {
      title: 'Create the player character',
      description:
        'Builds a level 1 character from the player\'s answers and computes every number. Call list_character_options first and ask one question at a time; pass picks exactly as the SRD names them, including languages, tool choices and level 1 features that are a choice. Anything left out is filled from the species and class and named in the result: read that out. A background from propose {op: "background"} or the library goes by name. Invalid picks are refused with the valid options: read them out and ask again. A living character already in the campaign is retired, which is the path after a death.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        name: z.string(),
        species: z.string(),
        lineage: z
          .string()
          .optional()
          .describe('Required for Dragonborn, Elf, Gnome, Goliath and Tiefling; the error and list_character_options name the choices.'),
        class: z.string(),
        background: z.string(),
        ability_method: z.enum(['standard_array', 'point_buy', 'manual']),
        abilities: ABILITY_SCORES.describe('The scores as assigned, before any background bonus.'),
        ability_bonuses: ABILITY_SCORES.partial().describe(
          'Required 2024 background increases: +2 and +1, or +1 to each of its three abilities.',
        ),
        skill_choices: z.array(z.string()).optional().describe('The skills the class and species let the player choose.'),
        languages: z
          .array(z.string())
          .optional()
          .describe('The two languages beyond Common; left out, they are picked from the species and named back.'),
        tools: z.array(z.string()).optional().describe("The class's tool choices, e.g. a Bard's three instruments."),
        feature_options: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('Picks for level 1 features that are a choice, by name: {"Expertise": ["stealth", "perception"]}, Fighting Style, Eldritch Invocations, Weapon Mastery.'),
        feat_choices: z
          .object({
            ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
            skills: z.array(z.string()).optional(),
            tools: z.array(z.string()).optional(),
            languages: z.array(z.string()).optional(),
            spell_list: z.string().optional(),
            spellcasting_ability: z.enum(['int', 'wis', 'cha']).optional(),
            cantrips: z.array(z.string()).optional(),
            spell: z.string().optional(),
          })
          .optional()
          .describe("What the background's origin feat asks for, e.g. Magic Initiate's list, cantrips and spell."),
        equipment_choice: z.union([z.string(), z.number().int()]).optional().describe('Which class equipment bundle: "a", "b", "c" or 1, 2, 3.'),
        background_equipment_choice: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('The background\'s kit ("a") or its gold ("b").'),
        equipment_picks: z
          .array(z.string())
          .optional()
          .describe('One name per "choose from this category" line in the chosen bundles, e.g. ["Dice"].'),
        cantrips: z.array(z.string()).optional(),
        spells: z.array(z.string()).optional(),
        spellbook: z
          .array(z.string())
          .optional()
          .describe("A Wizard's six level 1 spellbook spells, including the four in spells; left out, the extra two are picked and named back."),
        alignment: z.string().optional(),
        backstory: z.string().optional(),
        is_pc: z.boolean().optional(),
      }),
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, createCharacter(db, input)),
  );
}
