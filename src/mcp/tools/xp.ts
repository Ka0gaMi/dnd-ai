import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { awardXp, grantFeature, grantLevel, levelUp } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { ABILITY_SCORES, WRITES } from './character-shared.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';

export function registerXpTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'xp', {
    title: 'Experience and milestones',
    description:
      "Experience and milestones. op=award adds XP against the SRD table and logs it; the engine only suggests encounter XP, never awards it, and in a milestone campaign award counts nothing and points at milestone. op=milestone grants the next level at a story beat with no XP; in an XP campaign it is refused and points at award. Both return level_up_available with level_up_options: call propose_level_up_options next, then level_up applies the player's choices; XP alone never changes the sheet.",
    fields: {
      campaign_id: CAMPAIGN_ID,
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
        'Applies the next level once earned and the player has chosen: hit points, the subclass at 3, an ability increase or feat at each ASI level, an Epic Boon at 19, new cantrips and spells, and homebrew_ids for picks from your suggestions or the library. Call xp {op: award} (or {op: milestone}) first for the legal options. Anything missing or illegal is refused, naming what is still needed. Levels 2 to 20.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        character_id: CHARACTER_ID,
        choices: z
          .object({
            hp: z.enum(['average', 'roll']).optional(),
            subclass: z.string().optional(),
            subclass_homebrew_id: z
              .number()
              .int()
              .optional()
              .describe('A subclass you wrote: its homebrew id from level_up_options.'),
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
      }),
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, levelUp(db, input)),
  );

  server.registerTool(
    'grant_feature',
    {
      title: 'Grant a feature or boon',
      description:
        'Adds a named feature with its rules text to a sheet, for what the SRD does not cover: a boon, a blessing, a feat earned in the story. The text is stored verbatim and never interpreted, so write it as a rule the player can read back.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        character_id: CHARACTER_ID,
        name: z.string(),
        text: z.string(),
        source: z.enum(['homebrew', 'feat']),
      }),
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantFeature(db, input)),
  );
}
