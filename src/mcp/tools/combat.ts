import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import {
  addCombatant,
  advanceTurn,
  applyEffect,
  attack,
  endEffectById,
  endEncounter,
  findPositions,
  moveToken,
  setCombatCondition,
  startEncounter,
  undoLastCombatAction,
  useAction,
} from '../../combat/engine.js';
import {
  getBattleState,
  renderBattle,
  renderTurn,
  turnView,
  type BattleState,
  type CombatLogEntry,
} from '../../combat/state.js';
import { reply } from './result.js';

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const ABILITY = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);
const POINT = z.object({ x: z.number().int(), y: z.number().int() });
const SHAPE = z.object({
  kind: z.enum(['sphere', 'cone', 'line', 'cube']),
  size_ft: z.number().int().min(5).describe('Radius for a sphere, length for a cone or line, side for a cube.'),
});
const PRE_ROLL = z
  .object({ total: z.number().int(), natural: z.number().int().nullable().optional() })
  .describe(
    'A d20 the player already rolled; pass it instead of letting the server roll. Give natural as the raw d20 face - omitting it turns off critical hit and natural 1 handling for that roll.',
  );
const PRE_ROLLS = z
  .record(z.string(), PRE_ROLL)
  .describe('Pre-rolled saving throws, keyed by the combatant id that rolls them.');
const OUT_OF_TURN = z
  .boolean()
  .optional()
  .describe('Act outside the initiative order: a reaction or an opportunity attack, never a second turn.');
const REASON = z
  .string()
  .optional()
  .describe('Required with out_of_turn: the trigger, e.g. "opportunity attack as Borg leaves its reach".');
/** The "where should I stand" fields find_position answers and move_token walks to. */
const INTENT = {
  cover_from: z.number().int().optional().describe('Combatant id to take cover from.'),
  line_of_sight_to: z.number().int().optional().describe('Combatant id that must be visible from the cell.'),
  within_reach_of: z.number().int().optional().describe('Combatant id to end up in melee reach of.'),
  within_range_ft_of: z
    .object({ combatant_id: z.number().int(), range_ft: z.number().int() })
    .optional()
    .describe('Combatant id to end up within this many feet of, e.g. a 30 ft spell.'),
  adjacent_to_feature: z.string().optional().describe('Feature to stand in or beside, e.g. "pillars", "wall".'),
  max_ft: z.number().int().optional().describe('Search this far instead of the movement left, e.g. for a Dash.'),
};

const BRUTAL_STRIKE = z.enum(['forceful', 'hamstring', 'staggering', 'sundering']);

const RULING = z
  .object({ reason: z.string().describe('What the player did to earn it, in one line; it goes in the fight log.') })
  .describe('A DM ruling for an improvised move: the mover may pass through occupied cells, but not stop on one.');

const EFFECT = z.object({
  name: z.string(),
  kind: z.enum(['damage', 'condition', 'buff']).optional(),
  damage_expr: z.string().optional(),
  damage_type: z.string().optional(),
  save_ability: ABILITY.optional(),
  save_dc: z.number().int().optional(),
  tick: z.enum(['start', 'end']).optional(),
  ends: z.enum(['rounds', 'save', 'concentration', 'manual']).optional(),
  remaining_rounds: z.number().int().optional(),
});

const ACTION_OVERRIDE = z
  .object({
    name: z.string(),
    kind: z.enum(['melee_weapon_attack', 'ranged_weapon_attack', 'action', 'bonus_action', 'reaction', 'legendary_action']),
    attack_bonus: z.number().int().optional(),
    reach_ft: z.number().int().optional(),
    range_ft: z.number().int().optional(),
    long_range_ft: z.number().int().optional(),
    damage: z
      .array(z.object({ dice: z.string(), type: z.string() }))
      .optional(),
    uses: z.string().optional(),
    text: z.string(),
  })
  .describe(
    "An action of this creature's own, replacing the stat block's action of the same name or adding a new one: name, kind (melee_weapon_attack, ranged_weapon_attack, action, bonus_action, reaction, legendary_action), attack_bonus, reach_ft/range_ft, damage parts each with dice and type, text. Use it to give a named monster a different weapon or a rider damage type; the stat block's other actions stay.",
  );

/** A mutating combat call answers with what changed and whose turn it is; get_battle_state carries the whole field. */
function turnReply<T extends { log: CombatLogEntry[]; state: BattleState }>(
  db: Db,
  campaignId: number,
  result: T,
  lead?: string,
): CallToolResult {
  const { state, ...rest } = result;
  const text = renderTurn(state, result.log);
  const payload: Record<string, unknown> = { ...rest, turn: turnView(state, result.log) };
  return reply(db, campaignId, payload, lead ? `${lead}\n${text}` : text);
}

export function registerCombatTools(server: McpServer, db: Db): void {
  server.registerTool(
    'start_encounter',
    {
      title: 'Start a combat encounter',
      description:
        'Opens a fight: generates a seeded battle map for the terrain you name, places the player character and any companions on one side and the enemies on the other, rolls initiative for everyone and returns the full battle state with an ASCII grid. Call it the moment combat begins, before you narrate the first blow, and name the enemies exactly as the SRD does ("Goblin Warrior", "Wolf") so their stat blocks are loaded. Only one encounter can be active per campaign; end the previous one first. Surprise is the 2024 rule: name the party members caught out in surprised_ids, or set surprised on an enemy the party jumped, and they roll initiative with disadvantage. How much of an enemy stat block the player screen shows is the player own setting in the companion window, not yours. Every later combat tool works from the state this creates.',
      inputSchema: {
        campaign_id: z.number().int(),
        terrain: z.enum(['forest', 'cave', 'road', 'ruins', 'interior']),
        size: z.enum(['small', 'medium', 'large']).optional().describe('Map size; defaults to medium (20x14 cells).'),
        seed: z.number().int().optional().describe('Fix the map layout; omit for a random one.'),
        features: z
          .array(z.string())
          .optional()
          .describe('Named terrain features to place, e.g. ["river", "pillars", "fire", "rubble", "wall"].'),
        enemies: z
          .array(
            z.object({
              creature: z.string().describe('SRD creature name, e.g. "Goblin Warrior".'),
              count: z.number().int().min(1).optional(),
              name: z.string().optional().describe('Override the displayed name, e.g. "Bandit Captain Rook".'),
              unique: z
                .boolean()
                .optional()
                .describe('This one is somebody, and gets a portrait of their own instead of the shared one.'),
              surprised: z
                .boolean()
                .optional()
                .describe('The party got the drop on them: they roll initiative with disadvantage.'),
              actions: z
                .array(ACTION_OVERRIDE)
                .optional()
                .describe("This one fights with actions of its own; only works with creature. Its other stat block actions stay."),
            }),
          )
          .min(1),
        extra_party: z.array(z.number().int()).optional().describe('Character ids of companions to bring in.'),
        surprised_ids: z
          .array(z.number().int())
          .optional()
          .describe('Character ids of the party members the ambush caught: initiative with disadvantage.'),
      },
      annotations: { ...WRITES },
    },
    async (input) => {
      const started = await startEncounter(db, input);
      return reply(db, input.campaign_id, started as unknown as Record<string, unknown>, renderBattle(started.state));
    },
  );

  server.registerTool(
    'add_combatant',
    {
      title: 'Add a combatant to the fight',
      description:
        'Drops another creature or character into the active encounter, rolls its initiative and slots it into the order. Use it for reinforcements arriving mid-fight, for an NPC who joins in, or for a companion you forgot at the start. Pass creature for an SRD stat block or character_id for an existing character row, and x and y only if you want a specific cell. Returns the new combatant id and the turn view.',
      inputSchema: {
        campaign_id: z.number().int(),
        creature: z.string().optional().describe('SRD creature name for a monster.'),
        character_id: z.number().int().optional().describe('Character row id for a PC or companion.'),
        name: z.string().optional(),
        unique: z
          .boolean()
          .optional()
          .describe('This one is somebody, and gets a portrait of their own instead of the shared one.'),
        team: z.enum(['party', 'enemy', 'neutral']).optional(),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        actions: z
          .array(ACTION_OVERRIDE)
          .optional()
          .describe("Actions of its own, replacing the stat block's action of the same name or adding new ones; only works with creature."),
      },
      annotations: { ...WRITES },
    },
    async (input) => {
      const added = await addCombatant(db, input);
      return turnReply(db, input.campaign_id, added);
    },
  );

  server.registerTool(
    'get_battle_state',
    {
      title: 'Get the battle state',
      description:
        'Returns everything about the running fight: the map, every combatant with position, HP, conditions and distance to whoever is acting, the round and turn, the active combatant, its legal actions and all ongoing effects, plus an ASCII grid with a legend. Call it whenever you have lost track of the battlefield, before describing positions, or when the player asks what they can do. It changes nothing, so call it as often as you like. Returns encounter null when no fight is running.',
      inputSchema: { campaign_id: z.number().int() },
      annotations: { ...READS },
    },
    ({ campaign_id }) => {
      const state = getBattleState(db, campaign_id);
      return reply(
        db,
        campaign_id,
        { encounter: state },
        state ? renderBattle(state) : 'No active encounter in this campaign.',
      );
    },
  );

  server.registerTool(
    'find_position',
    {
      title: 'Find a place to stand',
      description:
        'Asks the engine where to stand instead of guessing a cell. Give the combatant and what the move is for - cover_from an enemy, line_of_sight_to a target, within_reach_of someone to melee, within_range_ft_of for a spell, adjacent_to_feature for "behind the pillar" - and it returns the cells reachable with the movement left (or max_ft), ranked by cover and then by the shortest walk, each with its cost, cover, line of sight, distance and a note. Use it whenever the player says something like "I take cover behind the rocks", then move_token to the cell you picked, or pass the same fields straight to move_token. When nothing qualifies it says why, so tell the player that instead of inventing a cell.',
      inputSchema: {
        campaign_id: z.number().int(),
        combatant_id: z.number().int(),
        ...INTENT,
        limit: z.number().int().min(1).optional().describe('How many cells to return; defaults to 5.'),
      },
      annotations: { ...READS },
    },
    (input) => {
      const found = findPositions(db, input);
      const text = found.candidates.length
        ? found.candidates.map((c) => `(${c.x},${c.y}) ${c.note}`).join('\n')
        : found.reason!;
      return reply(db, input.campaign_id, found as unknown as Record<string, unknown>, text);
    },
  );

  server.registerTool(
    'move_token',
    {
      title: 'Move a combatant',
      description:
        'Walks a combatant across the grid, paying 5 ft per cell and double for difficult terrain, refusing blocked cells and occupied squares. Use it before every attack that needs closing the distance, and pass toward with an enemy id when you just want to get next to someone. Instead of guessing a cell for "I duck behind the pillar", pass the same intent find_position takes - cover_from, line_of_sight_to, within_reach_of, within_range_ft_of, adjacent_to_feature - and the engine walks to the best cell it finds. A move that would leave an enemy\'s reach stops at its edge instead: the reply carries paused_for_reactions naming who may take an opportunity attack, and you resolve that with attack {out_of_turn: true, reason: ...} before calling move_token again to finish the walk, or pass waive_reactions to complete it in one go. The pause repeats for each enemy whose reach the walk leaves in turn until each has been resolved; waive_reactions skips every remaining one and completes the whole walk in that call. A paused move never ends on an occupied cell: it backs off to the last free cell inside reach, or holds still. A mover already at the edge pauses without moving, answering cost_ft 0 and the same paused_for_reactions so nobody is skipped. An out-of-turn move resumes the same way, and only a move that actually completes spends the mover\'s reaction. The result carries the new position, the movement left, which enemies are now in reach and a warning listing anyone already left behind. Grappled, Restrained, Paralyzed, Unconscious and Petrified all mean speed 0 and the move is refused; a grappler drags whoever it holds along at half speed. After a won check for something improvised - sliding under a charging ogre - pass ruling with the reason and the mover may cross occupied cells (never stop on one); the ruling is logged. The engine never moves anyone on its own.',
      inputSchema: {
        campaign_id: z.number().int(),
        combatant_id: z.number().int(),
        to: POINT.optional().describe('Exact destination cell.'),
        toward: z.number().int().optional().describe('Combatant id to close with; stops next to them.'),
        ...INTENT,
        ruling: RULING.optional(),
        out_of_turn: OUT_OF_TURN,
        reason: REASON,
        waive_reactions: z
          .boolean()
          .optional()
          .describe(
            'The DM rules that nobody takes an opportunity attack for this move (they are surprised, restrained by the fiction, or chose not to): the move completes in one go.',
          ),
      },
      annotations: { ...WRITES },
    },
    (input) => {
      const moved = moveToken(db, input);
      return turnReply(db, input.campaign_id, moved);
    },
  );

  server.registerTool(
    'attack',
    {
      title: 'Make an attack',
      description:
        'Resolves one weapon or natural attack end to end: range and line of sight, cover, the d20 against AC, criticals on a natural 20, the damage dice with the target resistances and temporary hit points, concentration checks and death saves. Call it for every attack by anyone - the player, a companion or a monster - and narrate only the numbers it returns. Pass action_name exactly as the stat block or the weapon names it ("Scimitar", "Longsword"), advantage when the fiction grants it, and roll when the player rolled their own d20. The conditions do the rest themselves: advantage against the prone and the paralyzed, disadvantage for the blinded and the poisoned, automatic criticals on a helpless target within 5 ft, long range, a hostile in the archer face, heavy weapons and armour worn without proficiency. One Action a turn is enforced, Extra Attack and Multiattack included, so the second swing is refused when there is none left. 2024 weapon mastery applies itself for a character whose sheet names that weapon: Graze deals the ability modifier on a miss, Push drives the target 10 ft back (pass no_push to leave it standing), Sap costs it its next attack roll, Slow takes 10 ft off its speed, Topple makes it save against being knocked Prone and Vex gives you Advantage on your next attack against it; the result carries them under mastery. A hit with Cleave answers with cleave_available - call attack again with cleave_from set to the first target to carry the swing into a creature beside it, once a turn and free of the Attack action. With player rolls on, this call waits for the player\'s clicks; the player\'s timeout applies per die, so an attack can wait for the d20 and then for the damage before it answers. Never decide a hit, a miss or damage yourself.',
      inputSchema: {
        campaign_id: z.number().int(),
        attacker_id: z.number().int(),
        target_id: z.number().int(),
        action_name: z.string(),
        advantage: z.enum(['none', 'advantage', 'disadvantage']).optional(),
        roll: PRE_ROLL.optional(),
        knock_out: z
          .boolean()
          .optional()
          .describe('Pull the blow: a melee hit that would drop the target leaves it unconscious instead of dead.'),
        grip: z
          .enum(['one_hand', 'two_hands'])
          .optional()
          .describe('Versatile weapons only: two-handed by default with no shield, one_hand takes the smaller die.'),
        cleave_from: z
          .number()
          .int()
          .optional()
          .describe(
            'Cleave mastery only: the id of the creature just hit, whose neighbour within 5 ft this swing carries into. Costs no attack of the Attack action, once per turn.',
          ),
        no_push: z
          .boolean()
          .optional()
          .describe('Push mastery only: leave the target where it stands instead of driving it 10 ft back.'),
        reckless: z
          .boolean()
          .optional()
          .describe(
            'Barbarian Reckless Attack: Advantage on Strength attacks until your next turn, and Advantage on every attack against you during it. Declare it once and it rides on the rest of the turn.',
          ),
        sneak_attack: z
          .boolean()
          .optional()
          .describe(
            'Rogue Sneak Attack applies itself whenever the rules allow it; pass false to keep the turn\'s one use back for a better swing.',
          ),
        cunning_strike: z
          .array(z.enum(['poison', 'trip', 'withdraw', 'daze', 'knock_out', 'obscure']))
          .optional()
          .describe(
            'Rogue 5 Cunning Strike: each effect costs Sneak Attack dice, and at least one die must be left to deal damage with. poison (1d6) is a CON save or Poisoned for a minute, trip (1d6) a DEX save or Prone, withdraw (1d6) half your Speed with no Opportunity Attacks; Devious Strikes at level 14 adds daze (2d6), obscure (3d6, DEX save or Blinded) and knock_out (6d6, CON save or Unconscious for a minute). One effect a hit, and two from level 11 (Improved Cunning Strike).',
          ),
        stunning_strike: z
          .boolean()
          .optional()
          .describe(
            'Monk 5 Stunning Strike: spend a Focus Point on this hit for a CON save against being Stunned until the start of your next turn. Once per turn, and only with a Monk weapon or an Unarmed Strike.',
          ),
        flurry: z
          .boolean()
          .optional()
          .describe(
            'Monk Flurry of Blows: one of the Unarmed Strikes the bonus action already bought, free of the Attack action. Take use_action {action_name: "flurry_of_blows"} first.',
          ),
        empowered_strike: z
          .boolean()
          .optional()
          .describe('Monk 6 Empowered Strikes: this Unarmed Strike deals Force damage instead of bludgeoning.'),
        brutal_strike: z
          .union([BRUTAL_STRIKE, z.array(BRUTAL_STRIKE)])
          .optional()
          .describe(
            'Barbarian 9 Brutal Strike: give up the Advantage of Reckless Attack on this swing for 1d10 extra damage (2d10 from level 17) and an effect. forceful pushes the target 15 ft and lets you follow; hamstring takes 15 ft off its Speed; Improved Brutal Strike at level 13 adds staggering (Disadvantage on its next save) and sundering (+5 on the next attack roll another creature makes against it). Pass an array of two different effects at level 17.',
          ),
        quivering_palm: z
          .boolean()
          .optional()
          .describe(
            'Monk 17 Quivering Palm: 4 Focus Points on this Unarmed Strike set lethal vibrations going in the target. End them later with use_action {action_name: "quivering_palm", target_id} for 10d12 Force damage, halved on a CON save.',
          ),
        hurl_through_hell: z
          .boolean()
          .optional()
          .describe(
            'Warlock 14 Hurl Through Hell: the creature this hit lands on makes a CHA save or is dragged through the Lower Planes for 8d10 Psychic damage (none if it is a Fiend) and is Incapacitated until the end of your next turn. Once per turn, once per long rest, or a Pact Magic slot to buy the use back.',
          ),
        prey_target_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Ranger 11 Superior Hunter's Prey: a second creature within 30 ft of the one your Hunter's Mark is on, which the mark's extra damage also lands on. Once on each of your turns.",
          ),
        mastery_property: z
          .enum(['push', 'sap', 'slow'])
          .optional()
          .describe('Fighter 9 Tactical Master: swing this weapon with Push, Sap or Slow instead of its own mastery property.'),
        sacred_weapon: z
          .boolean()
          .optional()
          .describe(
            'Paladin 3 Sacred Weapon: spend a Channel Divinity on an attack of your Attack action to bless that melee weapon for 10 minutes - your Charisma modifier (minimum +1) on its attack rolls, Radiant damage at will and bright light in a 20 ft radius. It rides on the swing, so it costs no action of its own.',
          ),
        eldritch_smite: z
          .boolean()
          .optional()
          .describe(
            'Warlock Eldritch Smite invocation: on a pact-weapon hit, spend a Pact Magic slot for 1d8 Force damage per slot level plus one, and knock a Huge or smaller creature Prone. Once per turn.',
          ),
        inspiration: z
          .boolean()
          .optional()
          .describe(
            'Add the Bardic Inspiration die this attacker is holding. The die is rolled only when the swing would otherwise miss, and spent only when it turns the miss into a hit.',
          ),
        peerless_aim: z
          .boolean()
          .optional()
          .describe(
            'Boon of Combat Prowess (level 19) Peerless Aim: if this attack misses, it hits instead. Once, and it comes back at the start of your next turn - a swing that asks for it when it is already spent is refused.',
          ),
        boosts: z
          .array(z.string())
          .optional()
          .describe(
            'Homebrew clauses spent on this call, by the boost id the reply lists in boosts_available. Each is refused unless it is on offer with a use left, and spent before the roll it rides on.',
          ),
        out_of_turn: OUT_OF_TURN,
        reason: REASON,
      },
      annotations: { ...WRITES },
    },
    async (input) => {
      const result = await attack(db, input);
      return turnReply(db, input.campaign_id, result);
    },
  );

  server.registerTool(
    'use_action',
    {
      title: 'Use a spell, ability or area effect',
      description:
        'Resolves anything that is not a plain attack roll: a spell, a class feature, a standard action, a breath weapon, a potion, an area effect. A class feature with an action of its own is taken by its id - rage, second_wind, action_surge, cunning_action_dash, steady_aim, flurry_of_blows, patient_defense, step_of_the_wind, lay_on_hands, uncanny_dodge, deflect_attacks, deflect_redirect, bardic_inspiration, cutting_words, divine_spark, turn_undead, preserve_life, wild_shape, wild_shape_revert, lands_aid, innate_sorcery, font_of_magic_to_points, font_of_magic_to_slot, dark_ones_own_luck, pact_weapon, and from level 11 intimidating_presence, fleet_step (or fleet_step_focus for the 1 Focus Point half), persistent_rage_regain (offered when Initiative is rolled and gone once the first turn of the fight belonging to that Barbarian ends; start_encounter names it under persistent_rage_available), natures_veil, superior_hunters_defense, superior_defense, quivering_palm, holy_nimbus, natures_sanctuary, natures_magician - and the engine spends the use, the action and the resource itself; the D20 Test stances (indomitable, disciplined_survivor, peerless_skill, stroke_of_luck, boon_of_fate) are declared the same way and fire on the next roll of theirs that fails, spending the use only then; get_battle_state lists which of them this character has left; an id it does not know is refused rather than narrated into spending the Action (Sacred Weapon is attack {sacred_weapon: true}, not an action of its own). For a spell pass spell with its SRD name and the engine fills in the dice, the damage type, the save, your DC, the area, the range, concentration, the duration and the casting time - a bonus-action spell spends the bonus action, a reaction spell needs out_of_turn, and anything longer than an action is refused in a fight - spends a slot (slot_level to upcast, cantrips spend none) and refuses when no slot is left; anything you pass yourself still wins. For a standard action pass action_name as one of dash, disengage, dodge, help, hide, ready, utilize, stand, grapple, shove or escape_grapple - grapple and shove need target_id, help takes target_id (the ally) and ally_target_id (the enemy within 5 ft of you), ready takes trigger and readied_action, shove takes shove_prone to knock the target down instead of pushing it. Otherwise describe the effect with damage_expr, damage_type, save_ability, save_dc and half_on_save, and pass effect to leave something burning or poisoned behind. It returns the saves, the damage per target and the updated turn.',
      inputSchema: {
        campaign_id: z.number().int(),
        actor_id: z.number().int(),
        action_name: z
          .string()
          .describe(
            'The spell, stat-block action, standard action id (dash, dodge, grapple, shove, hide, ready, stand, escape_grapple) or class feature id (rage, second_wind, flurry_of_blows, lay_on_hands, uncanny_dodge, bardic_inspiration, divine_spark, turn_undead, preserve_life, wild_shape, innate_sorcery, ...). get_battle_state lists the ones this character has under legal_actions.',
          ),
        target_id: z.number().int().optional(),
        amount: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Lay On Hands: hit points to pour out of the pool. Archdruid: uses of Wild Shape to turn into a slot.'),
        option: z
          .string()
          .optional()
          .describe(
            'Which option a feature takes: "poison" for Lay On Hands (and, with Restoring Touch at Paladin 14, "blinded", "charmed", "deafened", "frightened", "paralyzed" or "stunned"), "focus" for the Focus Point half of Patient Defense or Step of the Wind, "heal"/"radiant"/"necrotic" for Divine Spark, the Beast for Wild Shape, the weapon for Pact of the Blade, the animal form for a Find Familiar cast through Wild Companion or Pact of the Chain.',
          ),
        spell: z
          .string()
          .optional()
          .describe('SRD spell name: fills in the dice, save, DC, area, range and duration, and spends the slot.'),
        slot_level: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Cast at this slot level to upcast; defaults to the spell own level. It is also the slot Font of Magic, Font of Inspiration and Wild Resurgence burn or create.',
          ),
        metamagic: z
          .array(z.string())
          .optional()
          .describe(
            'Sorcerer 2 Metamagic, by name: Careful Spell, Distant Spell, Empowered Spell, Extended Spell, Heightened Spell, Quickened Spell, Seeking Spell, Subtle Spell, Transmuted Spell or Twinned Spell. Only options this Sorcerer knows, one per casting unless the option says otherwise (Empowered and Seeking always may, and Sorcery Incarnate allows two while Innate Sorcery runs), and the sorcery points are spent here.',
          ),
        sculpt: z
          .array(z.number().int())
          .optional()
          .describe(
            'Evoker 6 Sculpt Spells: combatant ids carved out of your Evocation spell, up to 1 + the spell level. They succeed on the save and take no damage.',
          ),
        careful_targets: z
          .array(z.number().int())
          .optional()
          .describe('Careful Spell: combatant ids protected from your own spell, up to your Charisma modifier.'),
        twin_target: z.number().int().optional().describe('Twinned Spell: the second creature the spell reaches.'),
        heighten_target: z.number().int().optional().describe('Heightened Spell: the creature that saves with Disadvantage.'),
        transmute_to: z
          .enum(['acid', 'cold', 'fire', 'lightning', 'poison', 'thunder'])
          .optional()
          .describe('Transmuted Spell: the damage type the spell deals instead of its own.'),
        free_cast: z
          .enum([
            'divine_intervention',
            'natural_recovery',
            'wild_companion',
            'pact_of_the_chain',
            'mystic_arcanum',
            'spell_mastery',
            'signature_spell',
          ])
          .optional()
          .describe(
            'The feature paying for this casting instead of a spell slot: divine_intervention (Cleric 10, any Cleric spell of level 5 or lower, once per long rest, and Wish itself at level 20), natural_recovery (Circle of the Land 6, one prepared Circle spell, once per long rest), wild_companion (Druid 2, Find Familiar as a Magic action for a use of Wild Shape), pact_of_the_chain (the invocation, Find Familiar as a Magic action for nothing; those two take the animal form in option), mystic_arcanum (Warlock 11+, the one Warlock spell of level 6, 7, 8 or 9 chosen at that level, once a long rest), spell_mastery (Wizard 18, your chosen level 1 and level 2 spells at will) or signature_spell (Wizard 20, each of your two level 3 signature spells once before a rest). Everything else that casts for free - Divine Smite, Hunter\'s Mark, an invocation such as Armor of Shadows - applies itself.',
          ),
        overchannel: z
          .boolean()
          .optional()
          .describe(
            'Evoker 14 Overchannel: a damaging Wizard spell cast with a slot of level 1 to 5 deals its maximum damage. The first use each long rest is free; every one after it costs the caster 2d12 Necrotic damage per slot level, a d12 more each time, which no Resistance or Immunity softens.',
          ),
        boosts: z
          .array(z.string())
          .optional()
          .describe(
            'Homebrew clauses spent on this call, by the boost id the reply lists in boosts_available. Each is refused unless it is on offer with a use left, and spent before the roll it rides on.',
          ),
        ally_target_id: z.number().int().optional().describe('Help: the enemy the ally attacks, within 5 ft of you.'),
        trigger: z.string().optional().describe('Ready: what sets the action off.'),
        readied_action: z.string().optional().describe('Ready: the action held for that trigger.'),
        shove_prone: z.boolean().optional().describe('Shove: knock the target prone instead of pushing it 5 ft.'),
        ruling: z
          .object({
            reason: z.string().describe('What the player did to earn it; it goes in the fight log.'),
            push_ft: z.number().int().optional().describe('Shove further than 5 ft, e.g. a charging target momentum.'),
            advantage: z.boolean().optional().describe('The shove comes in hard: the target saves with disadvantage.'),
          })
          .optional()
          .describe('A DM ruling on a shove, always logged.'),
        point: POINT.optional().describe('Centre of the area; required with shape.'),
        shape: SHAPE.optional(),
        damage_expr: z.string().optional().describe('e.g. "8d6"; defaults to the stat block action damage.'),
        damage_type: z.string().optional(),
        save_ability: ABILITY.optional(),
        save_dc: z.number().int().optional(),
        half_on_save: z.boolean().optional(),
        heal_expr: z.string().optional().describe('Healing dice, e.g. "2d4+2".'),
        concentration: z.boolean().optional().describe('Marks the actor as concentrating on this effect.'),
        effect: EFFECT.optional().describe('Ongoing effect left on each target.'),
        rolls: PRE_ROLLS.optional(),
        out_of_turn: OUT_OF_TURN,
        reason: REASON,
      },
      annotations: { ...WRITES },
    },
    async (input) => {
      const result = await useAction(db, {
        ...input,
        effect: input.effect ? { ...input.effect, kind: input.effect.kind ?? 'damage' } : undefined,
      });
      return turnReply(db, input.campaign_id, result);
    },
  );

  server.registerTool(
    'apply_effect',
    {
      title: 'Apply an ongoing effect',
      description:
        'Puts an engine-owned ongoing effect on a combatant: burning for 1d6 fire at the start of its turns, poisoned until it saves, blessed for three rounds. Use it whenever the fiction leaves something running that must not be forgotten - the server rolls the damage and the saves on every turn and tells you what happened. Set tick for when it fires, ends for how it stops, and save_ability with save_dc when a save ends it. This is the homebrew entry point; conditions from the rules go through set_combat_condition, and end_effect stops one early when the fiction says it is over.',
      inputSchema: {
        campaign_id: z.number().int(),
        target_id: z.number().int(),
        name: z.string().describe('e.g. "on fire", "poisoned by the spider".'),
        kind: z.enum(['damage', 'condition', 'buff']),
        damage_expr: z.string().optional(),
        damage_type: z.string().optional(),
        save_ability: ABILITY.optional(),
        save_dc: z.number().int().optional(),
        tick: z.enum(['start', 'end']),
        ends: z.enum(['rounds', 'save', 'concentration', 'manual']),
        remaining_rounds: z.number().int().optional(),
        source_id: z.number().int().optional(),
      },
      annotations: { ...WRITES },
    },
    (input) => {
      const result = applyEffect(db, input);
      return turnReply(db, input.campaign_id, result);
    },
  );

  server.registerTool(
    'end_effect',
    {
      title: 'End an ongoing effect',
      description:
        'Switches off one ongoing effect by id, whatever it was waiting for: the flames are doused, the spell is dispelled, the DM rules it over. Use it for anything applied with ends "manual", and for cutting a timed or save-ends effect short. The ids come from get_battle_state under effects. A condition effect takes its condition off the combatant and the sheet as it goes.',
      inputSchema: { campaign_id: z.number().int(), effect_id: z.number().int() },
      annotations: { ...WRITES },
    },
    (input) => {
      const result = endEffectById(db, input);
      return turnReply(db, input.campaign_id, result);
    },
  );

  server.registerTool(
    'set_combat_condition',
    {
      title: 'Set a condition in combat',
      description:
        'Adds or removes an SRD condition on a combatant - prone, grappled, frightened, restrained and the rest - and mirrors it onto the character sheet when the target is the player. The engine then applies it: advantage and disadvantage on the rolls it touches, speed 0 for Grappled, Restrained, Paralyzed, Petrified and Unconscious, no actions at all while Incapacitated, Paralyzed, Petrified, Stunned or Unconscious, automatic critical hits from within 5 ft on the Paralyzed and the Unconscious, and STR and DEX saves that simply fail. Use it as soon as the fiction applies a condition, and pass duration_rounds when it wears off by itself so the engine counts it down and removes it. Invalid names are rejected with the list of valid conditions. Returns the combatant conditions and the updated turn.',
      inputSchema: {
        campaign_id: z.number().int(),
        combatant_id: z.number().int(),
        condition: z.string(),
        active: z.boolean(),
        duration_rounds: z.number().int().min(1).optional(),
      },
      annotations: { ...WRITES },
    },
    (input) => {
      const result = setCombatCondition(db, input);
      return turnReply(db, input.campaign_id, result);
    },
  );

  server.registerTool(
    'advance_turn',
    {
      title: 'Advance to the next turn',
      description:
        'Ends the current turn and starts the next one: runs the end-of-turn effects for whoever just acted, moves initiative on (raising the round when it wraps), refills movement and clears the action, bonus action, reaction, Dash, Dodge, Disengage and any unreleased readied action, then runs the start-of-turn effects and any death save for the new actor. Call it exactly once at the end of every combatant turn, and read out everything it reports as ticking. It returns the new active combatant with its legal actions, so use that list to prompt the player.',
      inputSchema: { campaign_id: z.number().int(), rolls: PRE_ROLLS.optional() },
      annotations: { ...WRITES },
    },
    async ({ campaign_id, rolls }) => {
      const result = await advanceTurn(db, campaign_id, rolls);
      // The turn view carries these four already; the engine's copies would only double the reply.
      const slim: Record<string, unknown> & { log: CombatLogEntry[]; state: BattleState } = { ...result };
      for (const key of ['active', 'round', 'turn_index', 'legal_actions']) delete slim[key];
      const active = result.state.active;
      // The DM plays everyone but the player's own character, and only a creature with something to do gets the nudge.
      const canAct = result.state.legal_actions.some((a) => a.id !== 'incapacitated');
      const lead =
        active && active.kind !== 'pc' && canAct
          ? `Act for ${active.name} now with attack or use_action, then call advance_turn once.`
          : undefined;
      return turnReply(db, campaign_id, slim, lead);
    },
  );

  server.registerTool(
    'undo_last_combat_action',
    {
      title: 'Undo the last combat action',
      description:
        'Takes the last mutating combat call back: the combatants, the ongoing effects and the round and turn return to what they were before that move, attack, action, effect, condition or turn change. Use it when a call was plainly a mistake - the wrong target, an attack that should never have happened out of turn - and say out loud that you are rewinding it. The fight log keeps its entries and gains one naming what was undone; call it again to step further back, up to ten calls per fight. Starting or ending an encounter cannot be undone; everything else goes back, the hit points on the character sheets included.',
      inputSchema: { campaign_id: z.number().int() },
      annotations: { ...WRITES },
    },
    ({ campaign_id }) => {
      const result = undoLastCombatAction(db, campaign_id);
      // Confirming the rewind is the point of the call, so the whole grid stays in the text.
      const { state, ...rest } = result;
      return reply(db, campaign_id, { ...rest, turn: turnView(state, result.log) }, renderBattle(state));
    },
  );

  server.registerTool(
    'end_encounter',
    {
      title: 'End the encounter',
      description:
        'Closes the fight, records the outcome and returns a compact summary: rounds fought, damage dealt, taken and healed per combatant, the enemies defeated and an XP suggestion from their challenge ratings. Call it as soon as the fighting stops, whether the party won, fled or fell. The XP is only a suggestion - award it with award_xp if you think it was earned - and the summary is the raw material for your narration and the next save_checkpoint.',
      inputSchema: {
        campaign_id: z.number().int(),
        outcome: z.enum(['victory', 'retreat', 'defeat', 'other']),
        summary: z.string().optional().describe('One line on how the fight ended.'),
      },
      annotations: { ...WRITES },
    },
    (input) => {
      const result = endEncounter(db, input);
      const next_step =
        result.xp_suggestion > 0
          ? `Award the ${result.xp_suggestion} XP with award_xp now; the engine only suggests it. Then save_checkpoint.`
          : 'Nothing was defeated, so no XP is due; save_checkpoint when the scene is done.';
      return reply(db, input.campaign_id, { ...result, next_step } as unknown as Record<string, unknown>);
    },
  );
}
