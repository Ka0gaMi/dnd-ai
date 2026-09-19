import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { awardXp, grantFeature, grantLevel, levelUp } from '../../core/character.js';
import { reply } from './result.js';
import { ABILITY_SCORES, CHARACTER_ID, WRITES } from './character-shared.js';

export function registerXpTools(server: McpServer, db: Db): void {
  server.registerTool(
    'award_xp',
    {
      title: 'Award experience points',
      description:
        "Adds experience points and checks the SRD advancement table. Use it after a fight, a solved problem or a completed quest step. When the total reaches the next level the result says level_up_available and includes level_up_options: the hit point choice, the new features, and any subclass, feat or spell decisions. Call propose_level_up_options next, so the player sees those options and your suggestions in their window, and then level_up applies what they chose - XP alone does not change the sheet. Levels 2 to 20 are supported, all the way to the 355,000 XP the table ends at. Every award is logged as an xp event. If the campaign runs on milestones (xp_mode 'milestone') this counts nothing and tells you to call grant_level instead.",
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID, amount: z.number().int() },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, awardXp(db, input)),
  );

  server.registerTool(
    'grant_level',
    {
      title: 'Grant the next level (milestone)',
      description:
        "Milestone advancement: say the character has earned the next level and the server makes it available, no experience points involved. Use it at the story beat the level belongs to - the villain falls, the chapter closes - in a campaign whose xp_mode is 'milestone'; in an XP campaign it refuses and points you at award_xp. It returns the same level_up_options as award_xp does and is logged as an xp event; call propose_level_up_options next, then level_up with the player's choices.",
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantLevel(db, input)),
  );

  server.registerTool(
    'level_up',
    {
      title: 'Level up the character',
      description:
        "Applies the next level once the character has earned it and the player has told you their choices: average or rolled hit points, the subclass at level 3, an ability score increase or feat at every Ability Score Improvement level, an Epic Boon at level 19, any new cantrips or spells, and homebrew_ids for anything they picked from your suggestions or the personal library. Call award_xp (or grant_level in a milestone campaign) first to see the legal options. Anything missing or illegal comes back as an error naming what is still needed. Levels 2 to 20 are supported; 20 is the highest.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: z
          .number()
          .int()
          .optional()
          .describe('Pass character_id to level a class-built companion.'),
        choices: z
          .object({
            hp: z.enum(['average', 'roll']).optional(),
            subclass: z.string().optional(),
            subclass_homebrew_id: z
              .number()
              .int()
              .optional()
              .describe('A subclass you wrote instead of the rulebook one: the homebrew id from level_up_options.'),
            ability_increases: ABILITY_SCORES.partial().optional().describe('+2 to one ability or +1 to two, to a maximum of 20.'),
            feat: z.string().optional().describe('A general feat, instead of the ability increases.'),
            feat_choices: z
              .object({
                ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
                ability_increases: ABILITY_SCORES.partial().optional(),
                skills: z.array(z.string()).optional(),
                tools: z.array(z.string()).optional(),
                languages: z.array(z.string()).optional(),
                spell_list: z.string().optional(),
                spellcasting_ability: z.enum(['int', 'wis', 'cha']).optional(),
                cantrips: z.array(z.string()).optional(),
                spell: z.string().optional(),
              })
              .optional()
              .describe('What the feat itself asks for; level_up_options lists it under the feat as "choices".'),
            feature_options: z
              .record(z.string(), z.array(z.string()))
              .optional()
              .describe('Picks for the features that are a choice, keyed by name: Expertise, Fighting Style, Metamagic, Eldritch Invocations.'),
            cantrips: z.array(z.string()).optional(),
            spells: z.array(z.string()).optional(),
            replace_cantrip: z
              .object({ old: z.string(), new: z.string() })
              .optional()
              .describe('The 2024 cantrip swap every caster may make when they gain a level.'),
            replace_spell: z
              .object({ old: z.string(), new: z.string() })
              .optional()
              .describe('The spell swap a Bard, Ranger, Sorcerer or Warlock may make when they gain a level.'),
            spellbook: z
              .array(z.string())
              .optional()
              .describe('Wizards only: the two spells copied into the spellbook at this level.'),
            homebrew_ids: z
              .array(z.number().int())
              .optional()
              .describe('Homebrew or library entries the player chose; they go on the sheet as features.'),
          })
          .optional(),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, levelUp(db, input)),
  );

  server.registerTool(
    'grant_feature',
    {
      title: 'Grant a feature or boon',
      description:
        'Adds a named feature with its rules text to the character sheet. Use it for things the SRD does not cover: a boon you invented for this campaign, a blessing from an NPC, or a feat the player earned in the story. Write the text as a rule the player can read back to you later, because the server stores it verbatim and does not interpret it.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string(),
        text: z.string(),
        source: z.enum(['homebrew', 'feat']),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantFeature(db, input)),
  );
}
