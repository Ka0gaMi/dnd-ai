// Combat engine: turn ownership, action economy and resource spending.
import { slotsLeft, spendFeatureResource } from '../core/character.js';
import type { Db } from '../db/connection.js';
import { resourceRow, resourceSpec, type FeatureCost } from './features.js';
import { attacksPerAction, type CombatSheet } from './sheet.js';
import { boostsFor, ROLL_HOOK, type ClauseCtx } from './homebrew.js';
import { type ClauseWhen } from '../core/mechanics.js';
import {
  activeCombatant,
  listCombatants,
  logCombat,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
} from './state.js';

// --- turn ownership ---------------------------------------------------------

/** Only the combatant whose turn it is may act; out_of_turn covers reactions, opportunity attacks and DM rulings. */
export function requireTurn(db: Db, encounter: EncounterRow, actor: Combatant, outOfTurn?: boolean): void {
  if (outOfTurn) return;
  const active = activeCombatant(listCombatants(db, encounter.id), encounter.turn_index);
  if (active && active.id !== actor.id) {
    throw new Error(
      `It is ${active.name}'s turn, not ${actor.name}'s. Call advance_turn first, or pass out_of_turn true for a reaction, an opportunity attack or a DM ruling.`,
    );
  }
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/** How many swings one Attack action buys: Extra Attack on a sheet, Multiattack on a stat block. */
export function attacksAllowed(combatant: Combatant, sheet: CombatSheet | null): number {
  if (sheet) return attacksPerAction(sheet);
  const multi = (combatant.stat_block?.actions ?? []).find((a) => a.name.toLowerCase() === 'multiattack');
  const match = multi?.text.match(/makes (\w+) /i);
  return NUMBER_WORDS[match?.[1]?.toLowerCase() ?? ''] ?? 1;
}

/** One Action, one Bonus Action and one Reaction a turn: this is what refuses the second one. */
export function requireEconomy(
  actor: Combatant,
  kind: 'action' | 'bonus',
  what: string,
  swings = 1,
): void {
  const left = `${actor.bonus_used ? '' : 'a bonus action, '}${actor.movement_left} ft of movement${
    actor.reaction_used ? '' : ' and a reaction'
  }`;
  if (kind === 'bonus') {
    if (actor.bonus_used) {
      throw new Error(`${actor.name} has already used their bonus action this turn. Call advance_turn to end the turn.`);
    }
    return;
  }
  const used = actor.flags.attacks_used ?? 0;
  if (!actor.action_used) return;
  // Extra Attack keeps its remaining swings only while the spent Action was the Attack action itself,
  // which is exactly what attacks_used counts: a Dash is not that action however many swings are owed.
  if (swings > 1 && used > 0 && used < swings) return;
  throw new Error(
    swings > 1 && used >= swings
      ? `${actor.name} has taken all ${swings} attacks of their Attack action this turn. Left: ${left}. Call advance_turn to end the turn.`
      : `${actor.name} has already taken their Action this turn (${what} would be a second one). Left: ${left}. Call advance_turn to end the turn.`,
  );
}

/** Acting out of turn spends the reaction; in turn it spends the action or the bonus action. */
export function spendResource(actor: Combatant, kind: 'action' | 'bonus', outOfTurn?: boolean): void {
  if (outOfTurn) actor.reaction_used = true;
  else if (kind === 'bonus') actor.bonus_used = true;
  else {
    actor.action_used = true;
    // The surged Action has gone on something, and whatever it was, it was not a spell.
    if (actor.flags.surge_action_pending) actor.flags = { ...actor.flags, surge_action_pending: undefined };
  }
}

/**
 * Out of turn is a reaction and nothing else: it needs a stated trigger and the one reaction a round.
 * Returns the reason, which every log line of that call carries.
 */
export function requireReaction(actor: Combatant, outOfTurn: boolean | undefined, reason: string | undefined): string | null {
  if (!outOfTurn) return null;
  const stated = reason?.trim();
  if (!stated) {
    throw new Error(
      `${actor.name} acting out of turn needs a reason: pass reason with the trigger, e.g. "opportunity attack as the goblin flees". Out of turn is for reactions only.`,
    );
  }
  if (actor.reaction_used) {
    throw new Error(
      `${actor.name} has already used their reaction this round. A creature gets one reaction per round and regains it at the start of its turn, so this cannot happen - resolve it on ${actor.name}'s own turn instead.`,
    );
  }
  return stated;
}

/** Marks a log line as the reaction it is, so the fight log never hides an out-of-turn action. */
export const reactionText = (reason: string | null, text: string): string => (reason ? `REACTION: ${reason}. ${text}` : text);

// --- class features ----------------------------------------------------------

/** Spends a class resource off the actor's sheet and says so in the fight log; it throws before it writes. */
export function spendFeatureCost(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet,
  cost: FeatureCost,
  what: string,
): CombatLogEntry {
  if (!actor.character_id) throw new Error(`${actor.name} has no character sheet to spend ${what} from.`);
  const spec = resourceSpec(sheet, cost.resource);
  const spent = spendFeatureResource(db, {
    campaign_id: encounter.campaign_id,
    character_id: actor.character_id,
    resource: cost.resource,
    amount: cost.amount,
    ...(spec ? { label: spec.label, max: spec.max, per: spec.per } : {}),
  });
  // The sheet in hand is read again later in this same call - once a target, in an area spell - so the
  // use it just paid for has to be on it, or the next read would spend it twice and throw.
  markSpent(sheet, cost, spent);
  return logCombat(db, encounter, {
    actor_id: actor.id,
    kind: 'feature_resource',
    payload: { feature: what, resource: cost.resource, amount: cost.amount, left: spent.left, max: spent.max },
    text: `${actor.name} spends ${cost.amount} ${spent.name}: ${spent.left} of ${spent.max} left.`,
  });
}

/** Writes a spend onto the sheet object the hooks are still reading, so nothing reads a stale count. */
function markSpent(sheet: CombatSheet, cost: FeatureCost, spent: { name: string; used: number; max: number }): void {
  const row =
    resourceRow(sheet, cost.resource) ?? sheet.features.find((f) => f.name.toLowerCase() === spent.name.toLowerCase());
  // A feature with two counters keeps each on a row of its own, which the sheet only grows once it is
  // spent: without it the second spend of this call would read the old count and charge twice.
  if (!row) {
    sheet.features.push({ name: spent.name, mechanics: { resource: cost.resource, max: spent.max, used: spent.used } });
    return;
  }
  row.mechanics = { ...row.mechanics, resource: cost.resource, max: spent.max, used: spent.used };
}

/**
 * The boosts chosen for this call: an `ask_before` clause the player or the DM named. Each is refused
 * unless it is on offer with a use left, then spent, and only then marked on the sheet the hooks read -
 * plan, validate, spend, apply, inside the call's own snapshot.
 */
export function spendChosenBoosts(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet | null,
  chosen: string[] | undefined,
  ctx: Omit<ClauseCtx, 'sheet'> = {},
  hooks: ClauseWhen[] = ROLL_HOOK,
): CombatLogEntry[] {
  if (!chosen?.length) return [];
  if (!sheet) throw new Error(`${actor.name} has no sheet, so there is no boost to spend.`);
  const offered = boostsFor(sheet, sheet.features, ctx, hooks);
  for (const id of chosen) {
    const boost = offered.find((one) => one.id === id);
    if (!boost) {
      throw new Error(
        `${actor.name} has no boost "${id}" to spend here. Available: ${offered.map((one) => one.id).join(', ') || 'none'}.`,
      );
    }
  }
  // A rider taken before the swing costs nothing until it lands: the rider carries its own spend.
  const log = chosen
    .map((id) => offered.find((one) => one.id === id)!)
    .filter((boost) => boost.spend_on_fire !== true)
    .map((boost) => spendFeatureCost(db, encounter, actor, sheet, { resource: boost.id, amount: 1 }, boost.name));
  sheet.chosen_boosts = [...(sheet.chosen_boosts ?? []), ...chosen];
  return log;
}

/** Refuses a feature that burns a spell slot before anything is written, naming the slots that are open. */
export function requireSlot(sheet: CombatSheet, actor: Combatant, level: number, what: string): void {
  const slot = sheet.spell_slots[String(level)];
  const open = Object.entries(sheet.spell_slots)
    .filter(([, entry]) => slotsLeft(entry) > 0)
    .map(([at, entry]) => `level ${at} (${slotsLeft(entry)} left)`);
  if (slot && slotsLeft(slot) > 0) return;
  throw new Error(
    `${actor.name} has no level ${level} spell slot left for ${what}. Slots remaining: ${open.length ? open.join(', ') : 'none'}.`,
  );
}

/** Refuses a feature that creates a spell slot of a level this character has none of, before it is paid for. */
export function requireSlotLevel(sheet: CombatSheet, actor: Combatant, level: number, what: string): void {
  if (sheet.spell_slots[String(level)]) return;
  const have = Object.keys(sheet.spell_slots).join(', ') || 'none';
  throw new Error(
    `${actor.name} has no level ${level} spell slots at all, so ${what} cannot create one. Slot levels available: ${have}.`,
  );
}

/** Refuses a spend before anything is written, with an error that names what is left. */
export function requireResource(sheet: CombatSheet, actor: Combatant, cost: FeatureCost, what: string): void {
  const spec = resourceSpec(sheet, cost.resource);
  const row = sheet.features.find((f) => f.mechanics?.resource === cost.resource);
  const max = spec?.max ?? row?.mechanics?.max ?? 0;
  const left = Math.max(0, max - (row?.mechanics?.used ?? 0));
  if (left >= cost.amount) return;
  throw new Error(
    `${actor.name} has ${left} of ${max} ${spec?.label ?? cost.resource} left and ${what} costs ${cost.amount}. Rest to get it back, or leave that option off.`,
  );
}
