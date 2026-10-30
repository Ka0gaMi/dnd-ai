import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
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
  startEncounter,
  undoLastCombatAction,
  useAction,
} from '../../combat/engine.js';
import {
  combatLog,
  effectLine,
  getBattleState,
  listCombatants,
  renderBattle,
  renderTurn,
  renderUndo,
  requireEncounter,
  turnView,
  type BattleState,
  type CombatLogEntry,
} from '../../combat/state.js';
import { CAMPAIGN_ID } from './fields.js';
import { openKind, registerOpTool } from './op.js';
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
  .describe('A d20 the player already rolled. Give natural as the raw face; without it, crits and natural 1s are off for that roll.');
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

const BRUTAL_STRIKE = openKind('Brutal Strike effect', ['forceful', 'hamstring', 'staggering', 'sundering']);

const BOOSTS = z
  .array(z.string())
  .optional()
  .describe('Homebrew boost ids the reply offers; each is refused unless on offer with a use left, and spent before its roll.');

const RULING = z
  .object({ reason: z.string().describe('What the player did to earn it; logged.') })
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
  });

/** What an engine result offers beside its state and log, in the engine's own field names. */
interface Offers {
  reactions_available?: Array<{ name: string; hint: string }>;
  boosts_available?: Array<{ id: string; name: string; describe: string; uses_left: number }>;
  deflect_redirect_available?: { attacker_id: number; within_ft: number; hint: string };
  bardic_inspiration_available?: { hint: string };
  persistent_rage_available?: Array<{ hint: string }>;
  paused_for_reactions?: Array<{ id: number; name: string; hint: string }>;
  remaining_target?: { x: number; y: number };
  search_note?: string;
  flurry_strikes_left?: number;
}

/** The Offers block: everything the DM may take next with the ids its call needs, or nothing when none is on offer. */
function offerLines(result: Offers, extra: string[] = []): string[] {
  const paused = result.paused_for_reactions ?? [];
  const target = result.remaining_target;
  const boosts = result.boosts_available ?? [];
  const redirect = result.deflect_redirect_available;
  const strikes = result.flurry_strikes_left ?? 0;
  // uses_left is -1 for a boost with no use limit.
  const uses = (left: number): string => (left < 0 ? 'no use limit' : `${left} use${left === 1 ? '' : 's'} left`);
  const lines = [
    ...(paused.length
      ? [
          `Move paused for reactions from ${paused.map((p) => `#${p.id} ${p.name}`).join(', ')}${
            target ? `; remaining target (${target.x},${target.y})` : ''
          }.`,
          ...paused.map((p) => p.hint),
        ]
      : []),
    ...(result.reactions_available ?? []).map((offer) => `${offer.name}: ${offer.hint}`),
    ...(redirect ? [`Deflect redirect (attacker #${redirect.attacker_id}, within ${redirect.within_ft} ft): ${redirect.hint}`] : []),
    ...(result.bardic_inspiration_available ? [result.bardic_inspiration_available.hint] : []),
    ...(result.persistent_rage_available ?? []).map((offer) => `Persistent Rage: ${offer.hint}`),
    ...(boosts.length
      ? [`Boosts, by id in boosts: ${boosts.map((b) => `${b.id} (${b.name}: ${b.describe}, ${uses(b.uses_left)})`).join('; ')}.`]
      : []),
    ...(strikes > 0
      ? [`Flurry of Blows: ${strikes} Unarmed Strike${strikes === 1 ? '' : 's'} left, each with attack {flurry: true}.`]
      : []),
    ...(result.search_note ? [result.search_note] : []),
    ...extra,
  ];
  return lines.length ? ['', 'Offers:', ...lines.map((line) => `- ${line}`)] : [];
}

/** A mutating combat call answers with what changed and whose turn it is; the whole field is a separate read. */
export function turnReply<T extends { log: CombatLogEntry[]; state: BattleState }>(
  db: Db,
  campaignId: number,
  result: T,
  lead?: string,
): CallToolResult {
  const { state, ...rest } = result;
  const text = renderTurn(state, result.log, offerLines(result as Offers));
  const payload: Record<string, unknown> = { ...rest, turn: turnView(state, result.log) };
  return reply(db, campaignId, payload, lead ? `${lead}\n${text}` : text);
}

export function registerCombatTools(server: McpServer, db: Db): void {
  server.registerTool(
    'start_encounter',
    {
      title: 'Start a combat encounter',
      description:
        'Opens a fight: generates a seeded battle map for the terrain, places the party on one side and the enemies on the other, rolls initiative and returns the battle state with an ASCII grid. Call it the moment combat begins, before the first blow, and name enemies exactly as the SRD does ("Goblin Warrior", "Wolf") so their stat blocks load. One encounter per campaign: end the previous one first. Surprise (2024): name the caught party members in surprised_ids, or set surprised on an enemy the party jumped; they roll initiative with disadvantage. How much of a stat block the player sees is their own window setting.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
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
                .describe("Its own actions, replacing the stat block's action of the same name or adding one; needs creature, and its other actions stay."),
            }),
          )
          .min(1),
        extra_party: z.array(z.number().int()).optional().describe('Character ids of companions to bring in.'),
        surprised_ids: z
          .array(z.number().int())
          .optional()
          .describe('Character ids of the party members the ambush caught: initiative with disadvantage.'),
      }),
      annotations: { ...WRITES },
    },
    async (input) => {
      const started = await startEncounter(db, input);
      const battle = renderBattle(started.state);
      // The battle text keeps only the last few log lines, so an Initiative reminder older than those is listed here.
      const reminders = (started.reminders ?? []).filter((r) => !battle.includes(r.text)).map((r) => `Reminder: ${r.text}`);
      return reply(
        db,
        input.campaign_id,
        started as unknown as Record<string, unknown>,
        [
          battle,
          ...offerLines(started, reminders),
          'Turn loop: read_guide {section: "combat", topic: "turn-loop"}.',
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'add_combatant',
    {
      title: 'Add a combatant to the fight',
      description:
        'Drops another creature or character into the active encounter, rolls its initiative and slots it into the order: reinforcements, an NPC joining in, a forgotten companion. Pass creature for an SRD stat block or character_id for a character, and x and y only for a specific cell. Returns the new combatant id and the turn view.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        creature: z.string().optional().describe('SRD creature name for a monster.'),
        character_id: z.number().int().optional().describe('A PC or companion, instead of creature.'),
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
          .describe("Its own actions, replacing the stat block's action of the same name or adding one; needs creature."),
      }),
      annotations: { ...WRITES },
    },
    async (input) => {
      const added = await addCombatant(db, input);
      const newcomer = added.state.combatants.find((c) => c.id === added.combatant_id)!;
      return turnReply(db, input.campaign_id, added, `${newcomer.name} is combatant id ${newcomer.id}.`);
    },
  );

  server.registerTool(
    'get_battle_state',
    {
      title: 'Get the battle state',
      description:
        "Returns the running fight: map, every combatant with position, HP, conditions and distance to the actor, round and turn, the active combatant's legal actions, every ongoing effect with the id effect {op: end} takes, the last log lines and an ASCII grid. Call it whenever you lose track of the battlefield, before describing positions, or when the player asks what they can do. It changes nothing, and says so when no fight is running.",
      inputSchema: z.object({ campaign_id: CAMPAIGN_ID }),
      annotations: { ...READS },
    },
    ({ campaign_id }) => {
      const state = getBattleState(db, campaign_id, false);
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
        'Asks the engine where to stand instead of guessing a cell. Give the combatant and the purpose - cover_from, line_of_sight_to, within_reach_of, within_range_ft_of, adjacent_to_feature - and it returns cells reachable with the movement left (or max_ft), ranked by cover then the shortest walk, each with cost, cover, sight and distance. Then move_token to the cell you pick, or pass the same fields to move_token. When nothing qualifies it says why: tell the player rather than invent a cell.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        combatant_id: z.number().int(),
        ...INTENT,
        limit: z.number().int().min(1).optional().describe('How many cells to return; defaults to 5.'),
      }),
      annotations: { ...READS },
    },
    (input) => {
      const found = findPositions(db, input);
      // The engine's notes name combatants without ids, so the lead line names each one the call asked about.
      const combatants = listCombatants(db, requireEncounter(db, input.campaign_id).id);
      const named = (id: number): string => `${combatants.find((c) => c.id === id)!.name} #${id}`;
      const others = [
        ...new Set(
          [input.cover_from, input.line_of_sight_to, input.within_reach_of, input.within_range_ft_of?.combatant_id].filter(
            (id): id is number => id !== undefined,
          ),
        ),
      ];
      const lead = `Cells for ${named(found.combatant_id)} within ${found.budget_ft} ft${
        others.length ? `, relative to ${others.map(named).join(' and ')}` : ''
      }:`;
      const text = found.candidates.length
        ? found.candidates.map((c) => `(${c.x},${c.y}) ${c.note}`).join('\n')
        : found.reason!;
      return reply(db, input.campaign_id, found as unknown as Record<string, unknown>, `${lead}\n${text}`);
    },
  );

  server.registerTool(
    'move_token',
    {
      title: 'Move a combatant',
      description:
        "Walks a combatant across the grid at 5 ft a cell (double in difficult terrain), refusing blocked and occupied cells. Pass to, toward an enemy id to close in, or the find_position intent fields to walk to the best cell. Leaving an enemy's reach stops the walk at its edge: the reply's Offers name who may take an opportunity attack; resolve it with attack {out_of_turn: true, reason}, then call move_token again to go on, once for each enemy left behind - or pass waive_reactions to finish in one call. A paused move never ends on an occupied cell, and only a completed out-of-turn move spends the mover's reaction. Grappled, Restrained, Paralyzed, Unconscious and Petrified all mean speed 0 and the move is refused; a grappler drags whoever it holds at half speed. After a won check for something improvised, pass ruling and the mover may cross occupied cells (never stop on one). The engine never moves anyone on its own.",
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
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
          .describe('Your ruling that nobody takes an opportunity attack on this move (surprised, held back, or chose not to): it completes in one go.'),
      }),
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
        "Resolves one weapon or natural attack end to end - range, sight, cover, the d20 against AC, crits, damage with resistances and temporary HP, concentration and death saves - for anyone: player, companion or monster. Narrate only the numbers it returns; never decide a hit, a miss or damage yourself. Pass action_name exactly as the stat block or weapon names it (\"Scimitar\"), advantage when the fiction grants it, and roll when the player rolled their own d20. Conditions apply themselves (prone, paralyzed, blinded, poisoned, long range, a hostile in an archer's face, armour without proficiency). One Action a turn is enforced, Extra Attack and Multiattack included, so a swing with none left is refused. 2024 weapon mastery applies itself for a weapon the sheet names and comes back under mastery; a Cleave hit names who it may carry into - attack again with cleave_from. With player rolls on, the call waits for the player's clicks, the timeout counting per die.",
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
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
          .describe('Cleave mastery: the creature just hit; this swing carries to its neighbour within 5 ft, free of the Attack action, once a turn.'),
        no_push: z
          .boolean()
          .optional()
          .describe('Push mastery only: leave the target where it stands instead of driving it 10 ft back.'),
        reckless: z
          .boolean()
          .optional()
          .describe('Barbarian Reckless Attack: Advantage on Strength attacks, and against you, until your next turn; declared once, it rides on the rest of the turn.'),
        sneak_attack: z
          .boolean()
          .optional()
          .describe("Rogue Sneak Attack applies itself when the rules allow; false keeps the turn's one use for a better swing."),
        cunning_strike: z
          .array(openKind('Cunning Strike effect', ['poison', 'trip', 'withdraw', 'daze', 'knock_out', 'obscure']))
          .optional()
          .describe('Rogue 5 Cunning Strike, paid in Sneak Attack dice with one left to deal damage; daze, obscure, knock_out from 14. One a hit, two from 11.'),
        stunning_strike: z
          .boolean()
          .optional()
          .describe('Monk 5: a Focus Point on this hit for a CON save or Stunned until your next turn; once a turn, Monk weapon or Unarmed Strike.'),
        flurry: z
          .boolean()
          .optional()
          .describe('Monk Flurry of Blows: an Unarmed Strike the bonus action bought, free of the Attack action; use_action flurry_of_blows first.'),
        empowered_strike: z
          .boolean()
          .optional()
          .describe('Monk 6 Empowered Strikes: this Unarmed Strike deals Force damage instead of bludgeoning.'),
        brutal_strike: z
          .union([BRUTAL_STRIKE, z.array(BRUTAL_STRIKE)])
          .optional()
          .describe("Barbarian 9: trade Reckless Attack's Advantage on this swing for 1d10 (2d10 at 17) and an effect; staggering, sundering from 13; two at 17."),
        quivering_palm: z
          .boolean()
          .optional()
          .describe('Monk 17: 4 Focus Points set vibrations going; end them with use_action quivering_palm for 10d12 Force, half on a CON save.'),
        hurl_through_hell: z
          .boolean()
          .optional()
          .describe('Warlock 14: the target makes a CHA save or takes 8d10 Psychic (not Fiends) and is Incapacitated; once a turn, once a long rest or a slot.'),
        prey_target_id: z
          .number()
          .int()
          .optional()
          .describe("Ranger 11 Superior Hunter's Prey: a second creature within 30 ft of the marked one also takes the mark's damage; once a turn."),
        mastery_property: z
          .enum(['push', 'sap', 'slow'])
          .optional()
          .describe('Fighter 9 Tactical Master: swing this weapon with Push, Sap or Slow instead of its own mastery property.'),
        sacred_weapon: z
          .boolean()
          .optional()
          .describe('Paladin 3: a Channel Divinity on this Attack-action swing blesses the melee weapon for 10 minutes (CHA to hit, Radiant, light).'),
        eldritch_smite: z
          .boolean()
          .optional()
          .describe('Warlock invocation: on a pact-weapon hit, a Pact slot for 1d8 Force per slot level plus one, and Prone on Huge or smaller; once a turn.'),
        inspiration: z
          .boolean()
          .optional()
          .describe('Add the held Bardic Inspiration die: rolled only if the swing would miss, spent only if it turns the miss into a hit.'),
        peerless_aim: z
          .boolean()
          .optional()
          .describe('Boon of Combat Prowess (19): a miss hits instead; once, back at the start of your next turn, and refused while spent.'),
        boosts: BOOSTS,
        out_of_turn: OUT_OF_TURN,
        reason: REASON,
      }),
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
        'Resolves anything that is not a plain attack roll: a spell, a class feature, a standard action, a breath weapon, a potion, an area effect. A class feature is taken by its id (rage, second_wind, action_surge, lay_on_hands, wild_shape, ...; read_guide {section: "class-features"} has them all) and the engine spends the use, the action and the resource; legal_actions in the turn view lists what this character has left, and an id it does not know is refused rather than spending the Action. The D20 Test stances (indomitable, disciplined_survivor, peerless_skill, stroke_of_luck, boon_of_fate) are declared the same way and spend their use only on the next roll of theirs that fails. For a spell pass its SRD name: the engine fills in dice, damage type, save, DC, area, range, concentration and duration and spends the slot (slot_level to upcast); it refuses with no slot left, and refuses anything longer than an action in a fight. A bonus-action spell spends the bonus action; a reaction spell needs out_of_turn. Standard actions: dash, disengage, dodge, help, hide, ready, utilize, stand, grapple, shove, escape_grapple - grapple and shove need target_id, help takes target_id and ally_target_id, ready takes trigger and readied_action. Otherwise describe the effect with damage_expr, damage_type, save_ability, save_dc and half_on_save, and pass effect to leave something ongoing. Returns saves, damage per target and the updated turn.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        actor_id: z.number().int(),
        action_name: z
          .string()
          .describe("The spell, stat-block action, standard action or class feature id (rage, flurry_of_blows, ...); legal_actions in the turn view lists this character's."),
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
          .describe('Lay On Hands cure, "focus" (Patient Defense, Step of the Wind), Divine Spark heal/radiant/necrotic, a Wild Shape beast, a pact weapon or a familiar form.'),
        spell: z
          .string()
          .optional()
          .describe('SRD spell name: fills in the dice, save, DC, area, range and duration, and spends the slot.'),
        slot_level: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Upcast at this slot level (default the spell's own); also the slot Font of Magic, Font of Inspiration and Wild Resurgence burn or create."),
        metamagic: z
          .array(z.string())
          .optional()
          .describe('Sorcerer Metamagic by name, known options only: one a casting (Empowered and Seeking always stack; Sorcery Incarnate allows two); points spent here.'),
        sculpt: z
          .array(z.number().int())
          .optional()
          .describe('Evoker 6 Sculpt Spells: combatant ids carved out of your Evocation spell, up to 1 + its level; they succeed and take no damage.'),
        careful_targets: z
          .array(z.number().int())
          .optional()
          .describe('Careful Spell: combatant ids protected from your own spell, up to your Charisma modifier.'),
        twin_target: z.number().int().optional().describe('Twinned Spell: the second creature the spell reaches.'),
        heighten_target: z.number().int().optional().describe('Heightened Spell: the creature that saves with Disadvantage.'),
        transmute_to: openKind('Transmuted Spell damage type', ['acid', 'cold', 'fire', 'lightning', 'poison', 'thunder'])
          .optional()
          .describe('Transmuted Spell: the damage type the spell deals instead of its own, e.g. fire.'),
        free_cast: openKind('free_cast feature', [
          'divine_intervention',
          'natural_recovery',
          'wild_companion',
          'pact_of_the_chain',
          'mystic_arcanum',
          'spell_mastery',
          'signature_spell',
        ])
          .optional()
          .describe("The feature paying instead of a slot (wild_companion and pact_of_the_chain take the form in option); Smites, Hunter's Mark and invocations apply themselves."),
        overchannel: z
          .boolean()
          .optional()
          .describe('Evoker 14: a damaging Wizard spell of slot 1-5 deals maximum damage; free once a long rest, then 2d12 Necrotic per slot level (+1d12 each time).'),
        boosts: BOOSTS,
        ally_target_id: z.number().int().optional().describe('Help: the enemy the ally attacks, within 5 ft of you.'),
        trigger: z.string().optional().describe('Ready: what sets the action off.'),
        readied_action: z.string().optional().describe('Ready: the action held for that trigger.'),
        shove_prone: z.boolean().optional().describe('Shove: knock the target prone instead of pushing it 5 ft.'),
        ruling: z
          .object({
            reason: z.string().describe('What the player did to earn it; logged.'),
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
      }),
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

  registerOpTool(server, 'effect', {
    title: 'Ongoing effects in a fight',
    description:
      "Engine-owned ongoing effects on a combatant: burning for 1d6 fire each turn, poisoned until it saves, blessed for three rounds. Use it whenever the fiction leaves something running that must not be forgotten; the server ticks damage and saves on the target's turn and reports them. This is the homebrew entry point; SRD conditions go through condition {op: set}. op=end switches one off by id - the #number in the battle state's Effects lines and the apply reply - whatever it was waiting for: anything with ends \"manual\", or a timed or save-ends effect cut short. Ending a condition effect takes the condition off the combatant and the sheet.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      target_id: z.number().int().optional().describe('(op=apply) The combatant the effect lands on.'),
      name: z.string().optional().describe('(op=apply) e.g. "on fire", "poisoned by the spider".'),
      kind: z.enum(['damage', 'condition', 'buff']).optional().describe('(op=apply) damage, condition or buff.'),
      damage_expr: z.string().optional().describe('(op=apply) Dice rolled on each tick, e.g. "1d6".'),
      damage_type: z.string().optional().describe('(op=apply) e.g. "fire".'),
      save_ability: ABILITY.optional().describe('(op=apply) The ability the save uses when ends is save.'),
      save_dc: z.number().int().optional().describe('(op=apply) The DC of that save.'),
      tick: z.enum(['start', 'end']).optional().describe("(op=apply) When it fires: the start or the end of the target's turn."),
      ends: z.enum(['rounds', 'save', 'concentration', 'manual']).optional().describe('(op=apply) How it stops.'),
      remaining_rounds: z.number().int().optional().describe('(op=apply) Rounds left when ends is rounds.'),
      source_id: z.number().int().optional().describe('(op=apply) The combatant that caused it.'),
      effect_id: z.number().int().optional().describe("(op=end) The effect to switch off: its #number in the battle state's Effects lines."),
    },
    ops: {
      apply: {
        summary: 'Put an engine-owned ongoing effect on a combatant',
        requires: ['target_id', 'name', 'kind', 'tick', 'ends'],
        uses: ['damage_expr', 'damage_type', 'save_ability', 'save_dc', 'remaining_rounds', 'source_id'],
        run: (args) => {
          const { op, ...input } = args;
          const result = applyEffect(db, {
            ...input,
            target_id: input.target_id!,
            name: input.name!,
            kind: input.kind!,
          });
          return turnReply(db, input.campaign_id, result, `Effect ${effectLine(result.effect, result.state)}.`);
        },
      },
      end: {
        summary: 'Stop an ongoing effect early',
        requires: ['effect_id'],
        run: (args) => {
          const { op, ...input } = args;
          const result = endEffectById(db, { campaign_id: input.campaign_id, effect_id: input.effect_id! });
          return turnReply(db, input.campaign_id, result);
        },
      },
    },
    annotations: { ...WRITES },
  });

  server.registerTool(
    'advance_turn',
    {
      title: 'Advance to the next turn',
      description:
        "Ends the current turn and starts the next: end-of-turn effects, initiative moves on (a new round when it wraps), movement and the action economy reset, then start-of-turn effects and any death save for the new actor. Call it exactly once at the end of every combatant's turn, and read out everything it reports ticking. It returns the new actor's legal actions to prompt the player with.",
      inputSchema: z.object({ campaign_id: CAMPAIGN_ID, rolls: PRE_ROLLS.optional() }),
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
        'Takes back the last mutating combat call - a move, attack, action, effect, condition or turn change: combatants, effects, round and turn return to before it, sheet hit points included. Use it when a call was plainly a mistake, and say out loud that you are rewinding. The log keeps its entries plus one naming the undo; call again to step further back, up to ten per fight. Starting or ending an encounter cannot be undone.',
      inputSchema: z.object({ campaign_id: CAMPAIGN_ID }),
      annotations: { ...WRITES },
    },
    ({ campaign_id }) => {
      const result = undoLastCombatAction(db, campaign_id);
      // Confirming the rewind is the point of the call, so the whole grid stays in the text.
      const { state, ...rest } = result;
      const range = result.reverted_log_ids;
      const reverted = range
        ? combatLog(db, result.encounter_id).filter((e) => e.id >= range.from && e.id <= range.to)
        : [];
      // The engine answers with the player's view for the window's undo button; the DM's text reads the true one.
      const dm = getBattleState(db, campaign_id, false)!;
      return reply(
        db,
        campaign_id,
        { ...rest, turn: turnView(state, result.log) },
        renderUndo(dm, result.undone, reverted),
      );
    },
  );

  server.registerTool(
    'end_encounter',
    {
      title: 'End the encounter',
      description:
        'Closes the fight, records the outcome and returns a compact summary: rounds, damage dealt, taken and healed per combatant, the enemies defeated and an XP suggestion from their challenge ratings. Call it as soon as the fighting stops, won, fled or fallen. The XP is only a suggestion: award it with xp {op: award} if earned, then checkpoint {op: save}.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        outcome: z.enum(['victory', 'retreat', 'defeat', 'other']),
        summary: z.string().optional().describe('One line on how the fight ended.'),
      }),
      annotations: { ...WRITES },
    },
    (input) => {
      const { state, log, reminder, ...result } = endEncounter(db, input);
      void log;
      void reminder;
      const next_step =
        result.xp_suggestion > 0
          ? `Award the ${result.xp_suggestion} XP with xp {op: award} now; the engine only suggests it. Then checkpoint {op: save}.`
          : 'Nothing was defeated, so no XP is due; checkpoint {op: save} when the scene is done.';
      const party = state.combatants
        .filter((c) => c.team === 'party')
        .map((c) => ({ name: c.name, hp_current: c.hp_current, hp_max: c.hp_max, alive: c.alive }));
      return reply(db, input.campaign_id, { ...result, party, next_step } as unknown as Record<string, unknown>);
    },
  );
}
