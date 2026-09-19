import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { pcRow } from '../../core/campaign.js';
import { deathSave, exhaustionPenalty, setCondition, setExhaustion, stabilize } from '../../core/character.js';
import { awaitPlayerRoll, playerRollsStep, restWithPlayerRolls } from '../../core/rolls.js';
import { reply } from './result.js';
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
  server.registerTool(
    'set_condition',
    {
      title: 'Add or remove a condition',
      description:
        'Turns one SRD condition on or off for the character, for example poisoned, frightened, prone or restrained. Use it as soon as an effect applies or ends, because the condition list is part of the sheet the player sees. Only the fifteen SRD condition names are accepted and the error lists them, so look one up with srd_lookup if you are unsure what it does. A condition the character is immune to is refused, and a Rage keeps its own immunities while it runs. "exhaustion" is a level rather than a flag: true adds one level to the exhaustion track and false clears it, while set_exhaustion moves it directly.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        condition: z.string().describe('An SRD condition name, e.g. "prone".'),
        active: z.boolean().describe('True to apply it, false to remove it.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, setCondition(db, input)),
  );

  server.registerTool(
    'death_save',
    {
      title: 'Roll a death saving throw',
      description:
        "Rolls one death saving throw for a character at 0 hit points and records the result. Call it once at the start of each of the player's turns while they are down (pass character_id for a downed companion), and narrate only what comes back. A natural 20 wakes them with 1 HP, a natural 1 counts as two failures, three successes make them stable, and three failures kill them - and when it is the player character who dies the result carries death_options: read out exactly the options it returned (a new character with create_character, promote_companion when a companion is in the party, or end_session) and let the player choose.",
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
      annotations: { ...WRITES },
    },
    async (input) => reply(db, input.campaign_id, deathSave(db, { ...input, roll: await clickedDeathSave(db, input) })),
  );

  server.registerTool(
    'stabilize',
    {
      title: 'Stabilise a dying character',
      description:
        "Stops the death saves of a character at 0 hit points: a successful DC 10 Medicine check, a Spare the Dying, a healer's kit. Roll the check first with the roll tool, then call this on a success. They stay unconscious at 0 HP but no longer roll death saves, and after 1d4 hours of in-world time - which advance_time applies - they regain 1 HP on their own. Any damage while they are down undoes it and the saves start again.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        source: z.string().optional().describe('What steadied them, e.g. "Aldric\'s healer\'s kit".'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, stabilize(db, input)),
  );

  server.registerTool(
    'set_exhaustion',
    {
      title: 'Set the exhaustion level',
      description:
        'Moves exhaustion, the 2024 version: a level from 0 to 6, where every level takes 2 off every d20 test and 6 is death. Pass delta 1 for a forced march, a night without sleep, a failed save against a draining effect, delta -1 for a long rest with food and drink, or level to set it outright. The server applies the penalty to the player\'s own rolls, so never subtract it yourself.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        delta: z.number().int().optional().describe('How many levels to add or remove.'),
        level: z.number().int().min(0).max(6).optional().describe('The exact level, instead of a delta.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, setExhaustion(db, input)),
  );

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
