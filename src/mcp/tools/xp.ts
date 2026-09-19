import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { awardXp, grantFeature, grantLevel, levelUp } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { ABILITY_SCORES, CHARACTER_ID, WRITES } from './character-shared.js';

export function registerXpTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'xp', {
    title: 'Experience and milestones',
    description:
      "Experience and milestone advancement. award adds XP, checks the SRD table (levels 2 to 20, to 355,000 XP) and logs an xp event; use it when the story earns it - the engine only suggests encounter XP, it never awards it. In a milestone campaign award counts nothing and says to call milestone. milestone declares the story earned the next level at its beat - the villain falls, the chapter closes - with no XP, and works only when xp_mode is 'milestone'; in an XP campaign it is refused and points at award. Both return level_up_available with level_up_options: call propose_level_up_options next, then level_up applies the player's choices; XP alone does not change the sheet.",
    fields: {
      campaign_id: z.number().int(),
      character_id: CHARACTER_ID,
      amount: z.number().int().optional().describe('(op=award) Experience points to add.'),
    },
    shared: ['character_id'],
    ops: {
      award: {
        summary: 'Give experience points; the reply says when a level-up is available',
        requires: ['amount'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, awardXp(db, { ...input, amount: input.amount! }));
        },
      },
      milestone: {
        summary: 'Grant the next level in a campaign that levels by milestone',
        requires: [],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, grantLevel(db, input));
        },
      },
    },
    annotations: { ...WRITES },
  });

  server.registerTool(
    'level_up',
    {
      title: 'Level up the character',
      description:
        "Applies the next level once the character has earned it and the player has told you their choices: average or rolled hit points, the subclass at level 3, an ability score increase or feat at every Ability Score Improvement level, an Epic Boon at level 19, any new cantrips or spells, and homebrew_ids for anything they picked from your suggestions or the personal library. Call xp {op: award} (or xp {op: milestone} in a milestone campaign) first to see the legal options. Anything missing or illegal comes back as an error naming what is still needed. Levels 2 to 20 are supported; 20 is the highest.",
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
