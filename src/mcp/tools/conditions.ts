import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { pcRow } from '../../core/campaign.js';
import { deathSave, exhaustionPenalty, partyRest, setCondition, setExhaustion, stabilize } from '../../core/character.js';
import { setCombatCondition } from '../../combat/engine.js';
import { awaitPlayerRoll, playerRollsStep, restWithPlayerRolls } from '../../core/rolls.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { turnReply } from './combat.js';
import { WRITES } from './character-shared.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';

/** The player's own death save is theirs to click; a companion's is rolled by the server. */
async function clickedDeathSave(
  db: Db,
  input: { campaign_id: number; character_id?: number },
): Promise<{ total: number; natural_d20: number | null } | undefined> {
  const pc = pcRow(db, input.campaign_id);
  const isPlayerCharacter = Boolean(pc) && (input.character_id === undefined || input.character_id === pc!.id);
  if (!playerRollsStep(db, input.campaign_id, isPlayerCharacter, 'death_save')) return undefined;
  // deathSave takes exhaustion off the total, so the card has to show it or the window judges the bare
  // face and calls a failed save a success.
  const penalty = exhaustionPenalty(db, input.campaign_id, input.character_id);
  const record = await awaitPlayerRoll(db, {
    expr: penalty ? `1d20-${penalty}` : '1d20',
    purpose: 'Death saving throw',
    dc: 10,
    roll_type: 'save',
    campaign_id: input.campaign_id,
    context: { encounter_id: null, tool: 'condition', step: 'death_save', actor_id: pc!.id as number },
  });
  return { total: record.total, natural_d20: record.natural_d20 };
}

export function registerConditionTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'condition', {
    title: 'Conditions, death saves and exhaustion',
    description:
      "Conditions, death saves and exhaustion on a character or a combatant. Only SRD condition names pass; one the target is immune to is refused, and a Rage keeps its own immunities. Each applies its own rules: advantage and disadvantage, speed 0 for Grappled, Restrained, Paralyzed, Petrified and Unconscious, no actions while incapacitated, auto-crits within 5 ft on the paralyzed and unconscious, failed STR and DEX saves. duration_rounds counts down on a combatant; one on the player mirrors onto their sheet. The condition \"exhaustion\" adds a level (active true) or clears the track (active false). Death saves (2024): one per turn while down; a natural 20 wakes with 1 HP, a natural 1 is two failures, three successes stabilise, three failures kill, and death_options arrive to read out exactly. Stabilise after a DC 10 Medicine check you rolled, or with Spare the Dying or a healer's kit: still unconscious at 0 HP, 1 HP after 1d4 hours, and damage undoes it. Exhaustion runs 0 to 6, each level 2 off every d20 test, 6 is death; the server applies it, so never subtract it yourself.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      character_id: CHARACTER_ID,
      combatant_id: z
        .number()
        .int()
        .optional()
        .describe('(op=set) A combatant in the running fight; use it instead of character_id during an encounter.'),
      condition: z.string().optional().describe('(op=set) An SRD condition name, e.g. prone, grappled, frightened.'),
      active: z.boolean().optional().describe('(op=set) true to add it, false to remove it.'),
      duration_rounds: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('(op=set, with combatant_id) Rounds until it wears off on its own.'),
      source: z.string().optional().describe("(op=stabilize) What steadied them, e.g. \"Aldric's healer's kit\"."),
      delta: z.number().int().optional().describe('(op=exhaustion) How many levels to add or remove.'),
      level: z.number().int().min(0).max(6).optional().describe('(op=exhaustion) The exact level, instead of a delta.'),
    },
    shared: ['character_id'],
    ops: {
      set: {
        summary: 'Add or remove a condition on a character or a combatant',
        requires: ['condition', 'active'],
        uses: ['combatant_id', 'duration_rounds'],
        run: (args) => {
          const { op, ...input } = args;
          if (input.duration_rounds !== undefined && input.combatant_id === undefined) {
            const refused: CallToolResult = {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: 'duration_rounds only applies to a combatant in a fight; pass combatant_id, or leave duration_rounds out.',
                },
              ],
            };
            return refused;
          }
          if (input.combatant_id !== undefined) {
            return turnReply(
              db,
              input.campaign_id,
              setCombatCondition(db, {
                campaign_id: input.campaign_id,
                combatant_id: input.combatant_id,
                condition: input.condition!,
                active: input.active!,
                duration_rounds: input.duration_rounds,
              }),
            );
          }
          return reply(
            db,
            input.campaign_id,
            setCondition(db, {
              campaign_id: input.campaign_id,
              character_id: input.character_id,
              condition: input.condition!,
              active: input.active!,
            }),
          );
        },
      },
      death_save: {
        summary: 'Roll the death save of a character at 0 HP outside a fight (advance_turn rolls it inside one)',
        requires: [],
        run: async (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, deathSave(db, { ...input, roll: await clickedDeathSave(db, input) }));
        },
      },
      stabilize: {
        summary: 'End the death saves of a character at 0 HP',
        requires: [],
        uses: ['source'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, stabilize(db, input));
        },
      },
      exhaustion: {
        summary: "Move a character's exhaustion level by delta or set it to level",
        requires: [],
        uses: ['delta', 'level'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, setExhaustion(db, input));
        },
      },
    },
    annotations: { ...WRITES },
  });

  server.registerTool(
    'rest',
    {
      title: 'Take a short or long rest',
      description:
        'Applies a short or long rest; read out features_restored. A long rest needs at least 1 HP: it restores all HP, spell slots and hit dice, clears temporary HP, refills every rest feature and removes one exhaustion level. A short rest heals with the hit dice you pass, returns Warlock pact slots, refills short-rest features and gives one use back to Rage, Channel Divinity and Wild Shape; it is also where magic items are attuned, unattuned and identified. A long rest takes 8 hours and a short rest 1, moving the clock unless advance_time is false. Only one long rest per 24 hours of world time: a second is refused with when the last one ended. No rest inside an active encounter - end the fight first. A rest broken off (interrupted, or too few hours) gives nothing back, and a long one is still owed: narrate what broke it. Any rest ends Concentration.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        character_id: CHARACTER_ID,
        kind: z.enum(['short', 'long']),
        party: z
          .boolean()
          .optional()
          .describe(
            'Rests the PC and every active companion at once; anyone at 0 HP or dead sits out, one refusal refuses all, and per-character options are refused.',
          ),
        hit_dice: z.number().int().min(0).optional().describe('Short rest: how many hit dice the player spends.'),
        hit_dice_to_spend: z.number().int().min(0).optional().describe('The older name for hit_dice; either works.'),
        food_and_drink: z.boolean().optional().describe('Long rest: yours to narrate; a completed long rest lifts exhaustion either way.'),
        arcane_recovery: z.boolean().optional().describe('Short rest, Wizard: spend Arcane Recovery for spell slots.'),
        natural_recovery: z
          .boolean()
          .optional()
          .describe('Short rest, Circle of the Land Druid 6: Natural Recovery for spell slots, once per long rest.'),
        sorcerous_restoration: z
          .boolean()
          .optional()
          .describe('Short rest, Sorcerer 5: regain Sorcery Points up to half your level, once per long rest.'),
        memorize_spell: z
          .object({
            replace: z.string().describe('The prepared level 1+ spell to drop.'),
            with: z.string().describe('The level 1+ spellbook spell to prepare instead.'),
          })
          .optional()
          .describe('Short rest, Wizard 5 Memorize Spell: swap one prepared spell for one in the spellbook.'),
        fiendish_resilience: z
          .string()
          .optional()
          .describe('Either rest, Fiend Warlock 10: the damage type to resist until the next rest; any SRD type but force.'),
        attune: z
          .array(z.string())
          .optional()
          .describe('Short rest: magic items, by name or id, to attune to; three at a time at most.'),
        unattune: z.array(z.string()).optional().describe('Short rest: attunements to end, freeing a slot.'),
        attune_ruling: z
          .string()
          .optional()
          .describe('Your reason for allowing an attunement whose requirement the character does not meet; logged as a ruling.'),
        identify: z.array(z.string()).optional().describe('Short rest: magic items to study, which reveals what they are.'),
        mastery_weapons: z
          .array(z.string())
          .optional()
          .describe('Long rest: the weapons Weapon Mastery covers from now on, as many as now, each proficient; left out, the picks stay.'),
        interrupted: z
          .boolean()
          .optional()
          .describe('Something broke the rest off: it gives nothing back, and a long rest does not count.'),
        hours: z
          .number()
          .min(0)
          .optional()
          .describe('Hours actually rested; under 8 for a long rest or 1 for a short one counts as interrupted.'),
        force: z
          .boolean()
          .optional()
          .describe('Freeform rules_mode only: allow a long rest within 24 hours of the last, as your ruling.'),
        advance_time: z
          .boolean()
          .optional()
          .describe('False leaves the clock alone; by default the rest costs its 8 or 1 hours.'),
      }),
      annotations: { ...WRITES },
    },
    async ({ party, ...input }) => {
      const asked = { ...input, hit_dice_to_spend: input.hit_dice ?? input.hit_dice_to_spend };
      if (party) {
        return reply(db, input.campaign_id, { ...(await partyRest(db, asked, (one) => restWithPlayerRolls(db, one))) });
      }
      return reply(db, input.campaign_id, { ...(await restWithPlayerRolls(db, asked)) });
    },
  );
}
