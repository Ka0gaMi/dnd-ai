import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { getCharacterSheet } from '../../core/campaign.js';
import { createCharacter, listCharacterOptions } from '../../core/character.js';
import { srdSearch } from '../../srd/lookup.js';
import { reply } from './result.js';
import { ABILITY_SCORES, CHARACTER_ID, READS, WRITES } from './character-shared.js';

export function registerCharacterTools(server: McpServer, db: Db): void {
  server.registerTool(
    'get_character_sheet',
    {
      title: 'Get character sheet',
      description:
        "Returns the player character's full sheet: level, HP, AC, ability scores, saves, skills, features, spells, inventory, conditions, Heroic Inspiration, hit dice, proficiency bonus, initiative bonus and passive Perception, plus the rules that are not columns on the row: the speed their armour and their pack leave them (speed_reason says why), stealth_disadvantage for loud armour, what they are concentrating on and when their last long rest ended. Use it when you need an exact number for a check or when the player asks about their character, instead of trusting your memory of the sheet. Pass character_id (from the briefing) for a companion instead; a companion built from a creature stat block has no class and carries its traits and attacks as features with source \"stat_block\". Returns null while the campaign has no character yet, which means character creation still has to happen. It never changes anything.",
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
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
        'Lists the SRD choices for building a level 1 character: the 12 classes, 9 species, the backgrounds, the languages (Common plus two) and the three ways to set ability scores. Pass a class, species or background name to also get that pick in detail - which skill and tool proficiencies to choose and how many, the starting equipment bundles with any "choose one from this category" line, the level 1 features and which of them are a choice, the species traits, the background feat, and for spellcasters the exact number of cantrips and spells plus the full list of legal choices. Use it to interview a new player one question at a time, and always read the options from here rather than from memory. It changes nothing.',
      inputSchema: {
        class: z.string().optional().describe('e.g. "Rogue" - returns that class in detail'),
        species: z.string().optional().describe('e.g. "Elf"'),
        background: z.string().optional().describe('e.g. "Sage"'),
        campaign_id: z
          .number()
          .int()
          .optional()
          .describe('Pass it to also list the custom backgrounds saved in that campaign with create_background.'),
      },
      annotations: { ...READS },
    },
    (input) => reply(db, input.campaign_id ?? null, listCharacterOptions(input, db)),
  );

  server.registerTool(
    'srd_lookup',
    {
      title: 'Look up an SRD rule',
      description:
        'Searches the bundled SRD 5.2.1 by name and returns the real rules text: spells, classes, species, backgrounds, feats, conditions, glossary rules, weapons, armor, other items and creatures. Use it before you narrate how a spell, condition or monster works, so the numbers in your description match the ones the server will enforce. Matching is by substring, so "fire" finds several spells; raise limit if you want more of them. Creatures answer with the full stat block - abilities, saves, skills, senses, traits, actions with attack bonus, reach or range and damage dice, reactions and legendary actions - when the query names one creature, and with a compact list of names, CR, type and size when it matches several; pass exact true or limit 1 to force the stat block. Run a fight from that stat block: pass its attack_bonus to roll as "1d20+<bonus>" with roll_type "attack" and the damage dice as its own roll. It changes nothing.',
      inputSchema: {
        kind: z.enum(['spell', 'class', 'species', 'background', 'feat', 'condition', 'rule', 'weapon', 'armor', 'item', 'creature']),
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional(),
        exact: z.boolean().optional().describe('Only the entry whose name matches exactly; for creatures this returns the stat block.'),
      },
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
        'Builds a level 1 character from the answers the player gave you and computes every number: HP, AC, saves, skills, proficiencies, languages, features, spells, spell slots, starting gear and gold. Call list_character_options first and ask the player one question at a time; pass their picks here exactly as named in the SRD - including the two languages, the tool choices the class offers, and the level 1 features that are themselves a choice (Expertise, a Fighting Style, an Eldritch Invocation). Anything you leave out is filled in from the species and the class and named back to you in the result, so read that out rather than letting it pass. The background may also be one written with create_background for this campaign or kept in the personal library - pass it by name like any other. Invalid picks are rejected with a message listing the valid options, so read that message out and ask again rather than guessing. If the campaign already has a living character this retires it, which is the path to take after a death.',
      inputSchema: {
        campaign_id: z.number().int(),
        name: z.string(),
        species: z.string(),
        lineage: z
          .string()
          .optional()
          .describe(
            'Required for the species that have one - Dragonborn (Draconic Ancestor), Elf (Elven Lineage), Gnome (Gnomish Lineage), Goliath (Giant Ancestry), Tiefling (Fiendish Legacy) - and ignored by the rest. Leave it out and the error lists the choices for that species; list_character_options has them as lineages.',
          ),
        class: z.string(),
        background: z.string(),
        ability_method: z.enum(['standard_array', 'point_buy', 'manual']),
        abilities: ABILITY_SCORES.describe('The scores as assigned, before any background bonus.'),
        ability_bonuses: ABILITY_SCORES.partial().describe(
          'Required 2024 background increases: +2 and +1, or +1 to each of the background\'s three abilities.',
        ),
        skill_choices: z.array(z.string()).optional().describe('The skill proficiencies the class and species let the player choose.'),
        languages: z
          .array(z.string())
          .optional()
          .describe('The two languages beyond Common, from list_character_options. Left out, they are picked from the species and the answer says which.'),
        tools: z.array(z.string()).optional().describe("The class's tool choices, e.g. a Bard's three instruments."),
        feature_options: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('Picks for the level 1 features that are a choice: {"Expertise": ["stealth", "perception"]}, {"Fighting Style": ["Archery"]}, {"Eldritch Invocations": ["Agonizing Blast"]}, {"Weapon Mastery": ["Longsword", "Greataxe", "Longbow"]}.'),
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
          .describe('Which background equipment bundle: the kit ("a") or the gold ("b").'),
        equipment_picks: z
          .array(z.string())
          .optional()
          .describe('One name per "choose from this category" line in the chosen bundles, e.g. ["Dice"] for a Soldier\'s gaming set.'),
        cantrips: z.array(z.string()).optional(),
        spells: z.array(z.string()).optional(),
        spellbook: z
          .array(z.string())
          .optional()
          .describe(
            "A Wizard's opening spellbook: six level 1 Wizard spells including the four in spells. Left out, the extra two are picked from the class list and the answer says which.",
          ),
        alignment: z.string().optional(),
        backstory: z.string().optional(),
        is_pc: z.boolean().optional(),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, createCharacter(db, input)),
  );
}
