import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { getCharacterSheet, pcRow } from '../../core/campaign.js';
import { awaitPlayerRoll, playerRollsStep, restWithPlayerRolls, rollForTool } from '../../core/rolls.js';
import {
  addItem,
  addLanguage,
  adjustGold,
  applyDamage,
  awardXp,
  concentrationOf,
  concentrationSaveDc,
  checkModifier,
  createCharacter,
  createCompanion,
  deathSave,
  exhaustionPenalty,
  endConcentration,
  inActiveEncounter,
  grantLanguage,
  grantLevel,
  equipItem,
  grantFeature,
  grantInspiration,
  grantSpellRuling,
  heal,
  learnSpell,
  levelUp,
  listCharacterOptions,
  listInventory,
  listParty,
  prepareSpells,
  promoteCompanion,
  removeItem,
  retireCompanion,
  sellItem,
  setCondition,
  setExhaustion,
  setTempHp,
  stabilize,
  spendInspiration,
  useItem,
  useSpellSlot,
} from '../../core/character.js';
import { clausesSchema } from '../../core/mechanics.js';
import { ITEM_RARITIES, srdSearch } from '../../srd/lookup.js';
import { reply } from './result.js';

const ABILITY_SCORES = z.object({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});

const CHARACTER_ID = z
  .number()
  .int()
  .optional()
  .describe('Who this applies to. Leave it out for the player character; pass a companion id from list_party.');

const ITEM_REF = 'An item the character carries, by its name or its id; items inside a container count.';

const COIN_PURSE = z
  .object({
    cp: z.number().int().optional(),
    sp: z.number().int().optional(),
    ep: z.number().int().optional(),
    gp: z.number().int().optional(),
    pp: z.number().int().optional(),
  })
  .describe('Coins by denomination, negative to spend: 10 cp = 1 sp, 5 sp = 1 ep, 2 ep = 1 gp, 10 gp = 1 pp.');

const ITEM_MAGIC = z
  .object({
    rarity: z
      .enum(ITEM_RARITIES)
      .optional()
      .describe('Required for an item the SRD does not know; an SRD magic item brings its own.'),
    attunement: z
      .union([z.boolean(), z.string()])
      .optional()
      .describe('false for none, true for anyone, or the requirement in words, e.g. "by a Wizard".'),
    bonus: z.number().int().min(1).max(3).optional().describe('+N to attack and damage for a weapon, to AC for armour or a shield.'),
    charges: z
      .object({
        current: z.number().int().min(0),
        max: z.number().int().min(1),
        recharge: z
          .enum(['dawn', 'dusk', 'long_rest', 'never', 'unknown'])
          .describe('When the charges come back; "unknown" is the SRD text not saying, which leaves it to you.'),
        dice: z.string().optional().describe('What one recharge rolls, e.g. "1d6+1"; leave it out to get every charge back.'),
      })
      .optional(),
    identified: z.boolean().optional().describe('Use the unidentified flag instead; this is the stored form of it.'),
    mechanics: z
      .object({
        resistances: z.array(z.string()).optional(),
        vulnerabilities: z.array(z.string()).optional(),
        immunities: z.array(z.string()).optional(),
        ac_bonus: z.number().int().optional(),
        clauses: clausesSchema
          .optional()
          .describe(
            'What the item does, in the clause language a feature uses; it applies only while the item is worn, and attuned when it asks for attunement, so the clauses never have to say so.',
          ),
      })
      .optional()
      .describe('What the item does in numbers, in the same shape a feature carries them.'),
  })
  .describe('What makes the item magical. An item the SRD does not know must at least name its rarity.');

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

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

/** Which character this call is about, so concentration is read and ended on the right row. */
function heldHolderId(db: Db, input: { campaign_id: number; character_id?: number }): number {
  if (input.character_id !== undefined) return input.character_id;
  const pc = pcRow(db, input.campaign_id);
  if (!pc) throw new Error(`Campaign ${input.campaign_id} has no character yet.`);
  return pc.id as number;
}

/**
 * Damage taken outside a fight while concentrating: a Constitution save against half the damage,
 * never below DC 10, rolled the way the player's settings say. A failure ends the spell.
 */
async function concentrationSave(
  db: Db,
  input: { campaign_id: number; character_id?: number },
  spell: string,
  damage: number,
): Promise<Record<string, unknown>> {
  const holderId = heldHolderId(db, input);
  const dc = concentrationSaveDc(damage);
  const modifier = checkModifier(db, input.campaign_id, holderId, { save: 'con' });
  const pc = pcRow(db, input.campaign_id);
  const isPlayerCharacter = Boolean(pc) && holderId === (pc!.id as number);
  const roll = await rollForTool(db, {
    expr: modifier.total_modifier === 0 ? '1d20' : `1d20${modifier.total_modifier < 0 ? '' : '+'}${modifier.total_modifier}`,
    purpose: `Concentration save (${spell})`,
    dc,
    roll_type: 'save',
    campaign_id: input.campaign_id,
    roller: playerRollsStep(db, input.campaign_id, isPlayerCharacter, 'save') ? 'player' : 'dm',
  });
  const held = roll.total >= dc;
  if (!held) endConcentration(db, input.campaign_id, holderId, `they failed the DC ${dc} Constitution save`);
  return {
    spell,
    dc,
    total: roll.total,
    modifier: modifier.total_modifier,
    outcome: held ? 'success' : 'failure',
    concentration: held ? 'held' : 'ended',
    rule: 'Damage while concentrating calls for a Constitution save at DC 10 or half the damage, whichever is higher.',
  };
}

export function registerCharacterTools(server: McpServer, db: Db): void {
  server.registerTool(
    'get_character_sheet',
    {
      title: 'Get character sheet',
      description:
        "Returns the player character's full sheet: level, HP, AC, ability scores, saves, skills, features, spells, inventory, conditions, Heroic Inspiration, hit dice, proficiency bonus, initiative bonus and passive Perception, plus the rules that are not columns on the row: the speed their armour and their pack leave them (speed_reason says why), stealth_disadvantage for loud armour, what they are concentrating on and when their last long rest ended. Use it when you need an exact number for a check or when the player asks about their character, instead of trusting your memory of the sheet. Pass character_id (from list_party) for a companion instead; a companion built from a creature stat block has no class and carries its traits and attacks as features with source \"stat_block\". Returns null while the campaign has no character yet, which means character creation still has to happen. It never changes anything.",
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

  server.registerTool(
    'apply_damage',
    {
      title: 'Apply damage',
      description:
        'Subtracts damage from the character: temporary hit points first, then real ones. Call it every single time something hurts the player or a companion (pass character_id for a companion), and never describe a hit point total you did not get back from this tool. At 0 HP it adds the unconscious condition; a hit while already at 0 costs a death save failure (two on a critical); damage that big enough kills outright is handled here too, from above 0 or already down. Outside a fight, typed damage goes through the character\'s own Resistances, Vulnerabilities and Immunities. Outside a fight, a concentrating character rolls the Constitution save against half the damage (DC 10 at least) here and the reply says whether the spell held. When the player character dies the result carries death_options - a new character with create_character, promote_companion when a companion is in the party, or end_session. Read out exactly the options the tool returned and let the player choose.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        amount: z.number().int().min(0),
        type: z.string().optional().describe('e.g. "slashing", "fire"'),
        source: z.string().optional().describe('What dealt it, e.g. "goblin scimitar".'),
        critical: z.boolean().optional().describe('True if the hit that struck a downed character was a critical.'),
      },
      annotations: { ...WRITES },
    },
    async (input) => {
      const held = concentrationOf(db, input.campaign_id, input.character_id);
      const outsideFight = held !== null && !inActiveEncounter(db, input.campaign_id, heldHolderId(db, input));
      const result = applyDamage(db, input);
      const save =
        held && outsideFight && result.status !== 'dead' && result.hp_current > 0 && result.damage_taken > 0
          ? await concentrationSave(db, input, held.spell, result.damage_taken)
          : null;
      return reply(db, input.campaign_id, { ...result, ...(save ? { concentration_save: save } : {}) });
    },
  );

  server.registerTool(
    'heal',
    {
      title: 'Heal the character',
      description:
        'Restores hit points up to the maximum, wakes a character who was unconscious at 0 HP and clears any death save progress. Use it for healing spells, potions and any other effect that gives hit points back, so the sheet stays correct. A dead character cannot be healed this way and the tool says so.',
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID, amount: z.number().int().min(0) },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, heal(db, input)),
  );

  server.registerTool(
    'set_temp_hp',
    {
      title: 'Set temporary hit points',
      description:
        'Gives the character temporary hit points, the buffer that damage eats before real hit points. Use it for effects that grant them, such as a Fighter\'s Second Wind or a False Life spell, and pass 0 when something removes them. Temporary hit points never stack: the tool keeps whichever pool is larger and says so, which is the rule players most often get wrong.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        amount: z.number().int().min(0).describe('The new pool; 0 clears the temporary hit points.'),
        source: z.string().optional().describe('What granted them, e.g. "Second Wind".'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, setTempHp(db, input)),
  );

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

  server.registerTool(
    'prepare_spells',
    {
      title: 'Prepare spells',
      description:
        "Sets the whole prepared list of a Cleric, Druid, Paladin or Wizard after a long rest - the 2024 classes whose list changes with the day. The list must be exactly as long as their class table allows, no spell may be above the level they can cast, and a Wizard may only prepare what stands in their spellbook. Anything wrong comes back with the count and the legal pool, so read that out. Bards, Rangers, Sorcerers and Warlocks do not re-prepare: they swap one spell when they gain a level, through level_up.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        spells: z.array(z.string()).describe('The complete new prepared list, not the changes to it.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, prepareSpells(db, input)),
  );

  server.registerTool(
    'learn_spell',
    {
      title: 'Copy a spell into a spellbook',
      description:
        "Writes a spell into a Wizard's spellbook - a scroll they found, a rival's book they studied, a master's gift. What it costs in gold and hours is yours to narrate; the sheet only records the page. Afterwards the spell can be prepared with prepare_spells like any other. Only a Wizard keeps a spellbook; other classes learn spells when they level.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        spell: z.string().describe('An SRD spell name of a level they can cast.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, learnSpell(db, input)),
  );

  server.registerTool(
    'grant_spell',
    {
      title: 'Grant a spell (ruling)',
      description:
        "Adds one spell to a caster's list outside a level-up - a pick that was lost, a boon from a patron, the reward at the end of a quest. It works for any class that learns spells; a Wizard's spellbook still goes through learn_spell. The spell must be on the character's class list and no higher than their highest slot level, and a cantrip is fine. It is written down as your ruling, so say in reason what the player is owed.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        spell: z.string().describe('A spell of their class list, of a level they can cast; a cantrip counts.'),
        reason: z.string().describe('What the player is owed, or why they get it: it goes in the log with the spell.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantSpellRuling(db, input)),
  );

  server.registerTool(
    'add_language',
    {
      title: 'Add a language to the campaign',
      description:
        'Invents a language for this world: who speaks it and what it is written in. It joins the SRD languages wherever one is chosen or granted, and appears in the glossary so the rest of the story can use it. Use it for a tongue the setting needs; grant_language then gives it to a character.',
      inputSchema: {
        campaign_id: z.number().int(),
        name: z.string().describe('What it is called, e.g. "Old Ashfallen".'),
        speakers: z.string().describe('Who speaks it, e.g. "the drowned court and its servants".'),
        script: z.string().optional().describe('What it is written in, if anything.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, addLanguage(db, input)),
  );

  server.registerTool(
    'grant_language',
    {
      title: 'Teach a character a language',
      description:
        'Adds a language to the character sheet: a season with a tutor, a year in a foreign city, a spell or a boon. Use it when the story earns it, not to paper over a failed conversation - a character who does not know a language gets no roll at all.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string().describe('An SRD language or one added with add_language.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantLanguage(db, input)),
  );

  server.registerTool(
    'use_spell_slot',
    {
      title: 'Spend a spell slot',
      description:
        'Outside a fight only: marks one spell slot of the given level as used, and records Concentration when the spell needs it. Inside an encounter never call it - use_action {spell, slot_level} spends the slot itself, and this tool refuses while the caster is in the fight. Casting Identify on an unidentified magic item reveals it: pass spell "Identify" and target_item with the item. Call it every time the player casts a spell of level 1 or higher out of combat, passing spell with its name; cantrips cost nothing and need no call. Starting a second Concentration spell ends the first and the reply says so. The tool refuses when no slot of that level is left, which means the spell simply cannot be cast until a rest.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        level: z.number().int().min(1).max(9),
        spell: z
          .string()
          .optional()
          .describe('The spell being cast. Pass it always: a spell that needs Concentration is recorded on the sheet from here.'),
        target_item: z
          .string()
          .optional()
          .describe('Identify only: the unidentified item it is cast on, by name or id, which becomes identified.'),
      },
      annotations: { ...WRITES },
    },
    (input) => {
      // use_action spends the slot on the caster's own sheet, so a second call here would spend two.
      const characterId = heldHolderId(db, input);
      if (inActiveEncounter(db, input.campaign_id, characterId)) {
        const { name } = db.prepare('SELECT name FROM character WHERE id = ?').get(characterId) as { name: string };
        throw new Error(`${name} is in a fight: use_action {spell, slot_level} spends the slot itself. Call that instead.`);
      }
      return reply(db, input.campaign_id, useSpellSlot(db, input));
    },
  );

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

  server.registerTool(
    'grant_inspiration',
    {
      title: 'Grant Heroic Inspiration',
      description:
        'Gives the character Heroic Inspiration. Award it when the player does something clever, brave or true to who their character is, and tell them they have it: they can spend it to reroll any one d20 test and must take the new roll. It does not stack - you either have it or you do not - so granting it twice changes nothing.',
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantInspiration(db, input)),
  );

  server.registerTool(
    'spend_inspiration',
    {
      title: 'Spend Heroic Inspiration',
      description:
        'Spends the character\'s Heroic Inspiration on a reroll. Call it when the player says they want to use it, then roll again with the roll tool and use the new result. The tool refuses when they have none, which means the reroll simply does not happen.',
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, spendInspiration(db, input)),
  );

  server.registerTool(
    'adjust_gold',
    {
      title: 'Add or spend gold',
      description:
        'Moves money on the sheet: a negative delta for what the character pays in gold, a positive one for what they earn or loot, or coins for exact denominations ({cp, sp, ep, gp, pp}, negative to spend). The purse is kept by denomination and change is made automatically - paying 1 gp out of a purse of silver breaks the silver, paying out of platinum breaks the platinum - so it only refuses when the whole purse is worth less than the price. Use it for a sale, a reward, a bribe or a tavern bill - a purchase of an actual item goes through add_item with cost_gp instead, so the item lands on the sheet too. Pass either delta or coins, never both - a call with both is refused. It refuses to take the purse below zero and says how much is there; pass allow_debt true only when the story means them to owe it. Never narrate a price the player paid without calling this.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        delta: z.number().int().optional().describe('Gold pieces: negative to spend, positive to gain. Pass this or coins.'),
        coins: COIN_PURSE.optional().describe('Exact coins instead of delta, e.g. {sp: -5} for five silver.'),
        reason: z.string().describe('What it was for, e.g. "a night at the Gilded Eel".'),
        allow_debt: z.boolean().optional().describe('True to let the purse go below zero.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, adjustGold(db, input)),
  );

  server.registerTool(
    'add_item',
    {
      title: 'Add an item to the inventory',
      description:
        'Puts an item on the character sheet - loot, a gift, a crafted thing, or a shop purchase when you pass cost_gp, which is deducted in the same step and refuses to overdraw the purse unless allow_debt is true. Use the SRD name where one exists ("Chain Mail", "Longsword", "Potion of Healing") and the tool copies the category, damage or armour value, properties and weight into the item note, so the player can see what it is. Magic items are recognised too: an SRD name ("Bag of Holding", "Wand of Magic Missiles", "Potion of Greater Healing") or a +N on any weapon, armour or shield ("+1 Longsword", "+2 Chain Mail") brings its own rarity, attunement requirement, charges and bonus. For an item you invented, pass magic with at least a rarity (common, uncommon, rare, very_rare, legendary, artifact) - without one the call is refused. Pass unidentified true for something the party has not worked out yet: the player\'s window sees only its kind ("Unidentified longsword") until a short rest studying it or the Identify spell. into puts it inside a container they already carry. A name already carried merges into that stack rather than making a second line; pass equipped true to wear or wield it at once, which recomputes AC for armour and shields. Carrying capacity is STR x 15 lb, and going over it comes back as a warning and drops the effective speed to 5 ft until something is dropped.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string().describe('The SRD name where there is one, e.g. "Potion of Healing".'),
        qty: z.number().int().min(1).optional().describe('How many; 1 by default.'),
        notes: z.string().optional().describe('Your own description; replaces the SRD one.'),
        equipped: z.boolean().optional().describe('True to wear or wield it straight away.'),
        cost_gp: z.number().int().min(0).optional().describe('What the character pays for it, deducted here.'),
        weight_lb: z.number().min(0).optional().describe('Weight of one, for an item the SRD does not list.'),
        allow_debt: z.boolean().optional().describe('True to let the purchase take the purse below zero.'),
        magic: ITEM_MAGIC.optional(),
        unidentified: z
          .boolean()
          .optional()
          .describe('True when nobody knows what it is yet: the player\'s own sheet shows only its kind until a short rest or Identify.'),
        into: z.string().optional().describe('A container already carried, by name or id, to put it in, e.g. "Backpack".'),
        container: z
          .object({
            capacity_lb: z.number().min(0).optional().describe('What it holds, in pounds; leave it out for no limit.'),
            weightless_contents: z.boolean().optional().describe('True when what is inside weighs its carrier nothing.'),
          })
          .optional()
          .describe('Declares the item a container, for a chest, a saddlebag or anything the SRD does not list as one.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, addItem(db, input)),
  );

  server.registerTool(
    'remove_item',
    {
      title: 'Remove an item from the inventory',
      description:
        'Takes an item off the sheet: consumed, given away, stolen or destroyed. Pass qty to take part of a stack; leave it out to remove the whole line. Selling has its own tool, sell_item, which pays for it too. It finds items inside containers as well as loose in the pack, and errors when the character is not carrying that name and lists what they do have, so read that back rather than inventing the contents of their pack. Removing a container that still holds something is refused and names the contents: empty it first, or pass force true to lose them with it.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string().describe(ITEM_REF),
        qty: z.number().int().min(1).optional().describe('How many to remove; the whole stack by default.'),
        force: z.boolean().optional().describe('True to remove a container and lose what is inside it with it.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, removeItem(db, input)),
  );

  server.registerTool(
    'equip_item',
    {
      title: 'Equip or unequip an item',
      description:
        'Wears, wields or puts away something the character already carries, and recomputes AC when it is armour or a shield: armour base plus its capped DEX, +2 for a shield, 10 + DEX with nothing on, the Barbarian or Monk Unarmored Defense where it applies, and the +N of magical armour once it is attuned (the reply says so when it is not). The reply carries ac_breakdown, which names every part of the number. Use it whenever the player changes armour, straps on a shield or takes it off; only one suit of body armour is worn at a time, so equipping a new one takes the old one off. Equipping something stowed in a container takes it out of the container first, which the event says; taking it off leaves it where it is. Read the AC it returns back to the player instead of computing one yourself. It does not add or remove anything - add_item and remove_item do that.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string().describe('An item already in the inventory, e.g. "Shield", by name or id.'),
        equipped: z.boolean().describe('True to put it on, false to take it off.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, equipItem(db, input)),
  );

  server.registerTool(
    'list_inventory',
    {
      title: 'List the inventory and gold',
      description:
        'Returns what the character carries - every item with its quantity, id, note, weight, magic block and, for a container, what is nested inside it - plus their purse by denomination (cp, sp, ep, gp, pp) and its total in gold, their three attunement slots, the weight they carry, their carrying capacity (STR x 15 lb) and whether they are over it. An unidentified item is listed under the name the player sees, with true_name beside it for you. Use it before a shopping scene, when the player asks what they have, and when you need to know whether they can afford or carry something. Pass character_id for a companion. It changes nothing.',
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
      annotations: { ...READS },
    },
    (input) => reply(db, input.campaign_id, listInventory(db, input)),
  );

  server.registerTool(
    'use_item',
    {
      title: 'Spend the charges of a magic item',
      description:
        'Spends charges off a wand, staff or ring and says how many are left and when they come back (at dawn, at dusk, on a long rest, or never). It refuses at zero and names the recharge, so the item simply cannot be used again until then. Where the bundled SRD text carries charges but no recharge rule the recharge is "unknown": that one is yours to rule on, and restore hands charges back on your say-so (logged as a DM ruling), while add_item magic.charges.recharge sets the schedule for good. It does not cast anything: the spell is yours to narrate, and if the player casts it themselves it still goes through use_spell_slot or use_action. The reply carries the item\'s own rules text so you know what it does. Dawn and dusk items fill up again on their own the moment the campaign clock passes that hour.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        item: z.string().describe(ITEM_REF),
        charges: z.number().int().min(1).optional().describe('How many charges this use costs; 1 by default, and 0 when restore is passed.'),
        restore: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Charges you are handing back as a DM ruling, for an item whose recharge the SRD text does not carry.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, useItem(db, input)),
  );

  server.registerTool(
    'sell_item',
    {
      title: 'Sell an item',
      description:
        'Sells something off the sheet and puts the coins in the purse in one step. Without price_gp the price is half the SRD list price, the 2024 rule of thumb, and the reply names the rule it used; a magic item needs a price_gp from you, because the SRD prices the mundane item behind it and not the magic one. It refuses an item that is still equipped or still attuned - take it off or end the attunement first, or pass force true when the story means them to hand it over anyway. Use it for shops, fences and pawn-brokers; a gift or a theft is remove_item instead.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        item: z.string().describe(ITEM_REF),
        qty: z.number().int().min(1).optional().describe('How many to sell; 1 by default.'),
        price_gp: z.number().min(0).optional().describe('What the buyer pays for one, in gold, instead of half the SRD price.'),
        force: z.boolean().optional().describe('True to sell something still equipped or still attuned, or a container with its contents inside.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, sellItem(db, input)),
  );
}
