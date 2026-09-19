import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { pcRow } from '../../core/campaign.js';
import { deathSave, exhaustionPenalty, setCondition, setExhaustion, stabilize } from '../../core/character.js';
import { setCombatCondition } from '../../combat/engine.js';
import { awaitPlayerRoll, playerRollsStep, restWithPlayerRolls } from '../../core/rolls.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { turnReply } from './combat.js';
import { CHARACTER_ID, WRITES } from './character-shared.js';

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
    context: { encounter_id: null, tool: 'death_save', step: 'death_save', actor_id: pc!.id as number },
  });
  return { total: record.total, natural_d20: record.natural_d20 };
}

export function registerConditionTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'condition', {
    title: 'Conditions, death saves and exhaustion',
    description:
      'Conditions, death saves and exhaustion on a character or combatant. Only SRD condition names pass and the error lists them; the immune are refused, a Rage keeps its own. Each applies itself: advantage and disadvantage where it says, speed 0 for Grappled, Restrained, Paralyzed, Petrified and Unconscious, no actions at all while incapacitated, auto-crits within 5 ft on paralyzed/unconscious, STR and DEX saves failing; duration_rounds counts it down on a combatant, one on the player mirrors onto their sheet. Death saves (2024): one per turn while down; natural 20 wakes with 1 HP, natural 1 is two failures, three successes stabilise, three kill, and death_options arrive to read out exactly. Stabilise on a DC 10 Medicine check, Spare the Dying or a healer\'s kit (roll the check first); still unconscious at 0 HP, 1 HP after 1d4 hours, damage undoes it. Exhaustion runs 0 to 6, each level 2 off every d20 test, 6 death; the server applies it, never subtract it yourself; level sets it outright.',
    fields: {
      campaign_id: z.number().int(),
      character_id: z
        .number()
        .int()
        .optional()
        .describe('(any op) Who this applies to outside a fight: leave it out for the player character, pass a companion id.'),
      combatant_id: z
        .number()
        .int()
        .optional()
        .describe('(op=set) The combatant in the running fight; use this instead of character_id during an encounter.'),
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
    ops: {
      set: {
        summary: 'Add or remove a condition on a character (character_id) or a combatant in a fight (combatant_id)',
        requires: ['condition', 'active'],
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
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, stabilize(db, input));
        },
      },
      exhaustion: {
        summary: "Move a character's exhaustion level by delta or set it to level",
        requires: [],
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
        'Applies a rest. A short rest is also where magic items are handled: attune names items to attune to (at most three at once, and a requirement such as "by a Wizard" is checked - one the engine cannot parse is allowed with a note, and a refused one goes through anyway if you pass attune_ruling with your reason), unattune ends one, and identify works out what an unidentified item is. A long rest restores all hit points and spell slots, clears temporary HP, gives back half the hit dice, refills every feature that recharges on a rest, and removes one level of exhaustion; it is also where weapon drills happen, so mastery_weapons swaps the weapons a Barbarian, Fighter, Paladin, Ranger or Rogue may use the mastery properties of. A short rest heals with hit dice (pass how many), gives a Warlock their pact slots back, refills the short-rest features (Second Wind, Action Surge, Focus Points, Bardic Inspiration from level 5) and hands one use back to Rage, Channel Divinity and Wild Shape; a Wizard may also spend Arcane Recovery for spell slots, a Circle of the Land Druid Natural Recovery, a Sorcerer Sorcerous Restoration for their points, and a Wizard of level 5 may swap one prepared spell with memorize_spell. A Fiend Warlock chooses what Fiendish Resilience makes them resist on either rest. Use it whenever the player camps or catches their breath, and read out features_restored. A long rest takes 8 hours and a short rest 1, and the campaign clock moves by that much unless you pass advance_time false. Nobody benefits from more than one long rest in 24 hours of world time: a second one is refused with the time the last one ended. A rest cannot be taken in an active encounter - rolling Initiative interrupts a rest - so end the fight first. If the rest was broken off, pass interrupted true (or the hours they actually got): it gives nothing back and, for a long rest, leaves them still owed one - narrate what interrupted it. Any rest ends Concentration.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        kind: z.enum(['short', 'long']),
        hit_dice: z.number().int().min(0).optional().describe('Short rest only: how many hit dice the player spends after the rest.'),
        hit_dice_to_spend: z.number().int().min(0).optional().describe('The older name for hit_dice; either works.'),
        food_and_drink: z.boolean().optional().describe('Long rest: whether the party ate and drank is yours to narrate; a completed long rest lifts exhaustion either way.'),
        arcane_recovery: z.boolean().optional().describe('Short rest, Wizard only: spend Arcane Recovery to get spell slots back.'),
        natural_recovery: z
          .boolean()
          .optional()
          .describe('Short rest, Circle of the Land Druid 6: spend Natural Recovery for spell slots back, once per long rest.'),
        sorcerous_restoration: z
          .boolean()
          .optional()
          .describe('Short rest, Sorcerer 5: get back Sorcery Points up to half your level, once per long rest.'),
        memorize_spell: z
          .object({
            replace: z.string().describe('The prepared level 1+ spell to drop.'),
            with: z.string().describe('The level 1+ spell from the spellbook to prepare instead.'),
          })
          .optional()
          .describe('Short rest, Wizard 5 Memorize Spell: swap one prepared spell for another out of the spellbook.'),
        fiendish_resilience: z
          .string()
          .optional()
          .describe(
            'Either rest, Fiend Warlock 10: the damage type Fiendish Resilience makes them resist until the next rest changes it. Any SRD type except force.',
          ),
        attune: z
          .array(z.string())
          .optional()
          .describe('Short rest only: magic items, by name or id, the rest is spent attuning to. Three at a time is the limit.'),
        unattune: z.array(z.string()).optional().describe('Short rest only: attunements to end, freeing a slot.'),
        attune_ruling: z
          .string()
          .optional()
          .describe('Your reason for allowing an attunement whose requirement the character does not meet; it is logged as a DM ruling.'),
        identify: z
          .array(z.string())
          .optional()
          .describe('Short rest only: magic items the rest is spent studying, which reveals what they are.'),
        mastery_weapons: z
          .array(z.string())
          .optional()
          .describe(
            'Long rest only: the weapons Weapon Mastery covers from here on, as many as it covers now and each one the character is proficient with. Left out, the picks stay as they were.',
          ),
        interrupted: z
          .boolean()
          .optional()
          .describe('True when something broke the rest off: it gives nothing back and, for a long rest, does not count as one.'),
        hours: z
          .number()
          .min(0)
          .optional()
          .describe('How long they actually rested; under 8 hours for a long rest or 1 for a short one counts as interrupted.'),
        force: z
          .boolean()
          .optional()
          .describe(
            'Freeform rules_mode only: allow a long rest inside 24 hours of the last one, as your ruling. Refused in strict and flexible mode.',
          ),
        advance_time: z
          .boolean()
          .optional()
          .describe('False leaves the campaign clock alone; by default the rest costs its 8 or 1 hours of world time.'),
      },
      annotations: { ...WRITES },
    },
    async (input) =>
      reply(db, input.campaign_id, {
        ...(await restWithPlayerRolls(db, { ...input, hit_dice_to_spend: input.hit_dice ?? input.hit_dice_to_spend })),
      }),
  );
}
