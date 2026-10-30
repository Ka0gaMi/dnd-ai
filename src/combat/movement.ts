// Combat engine: finding places to stand and moving tokens.
import type { Db } from '../db/connection.js';
import { actionsFor } from './actions.js';
import { isIncapacitated, speedZeroBy } from './conditions.js';
import {
  canStand,
  CELL_FT,
  distanceToPoint,
  coverBetween,
  COVER_ORDER,
  distanceBetween,
  hasLineOfSight,
  planMove,
  reachableCells,
  type Cover,
  type Point,
  type SizeCode,
} from './grid.js';
import { type BattleMap } from './map.js';
import { dropSnapshot, lastSnapshot, underSnapshot } from './undo.js';
import {
  encounterMap,
  getCombatant,
  listCombatants,
  logCombat,
  requireEncounter,
  saveCombatant,
  type Combatant,
  type EncounterRow,
} from './state.js';
import { finish, sheetOf } from './engine-core.js';
import { requireTurn, requireReaction, reactionText } from './resources.js';
import { frighteners } from './d20.js';

// --- finding a place to stand ----------------------------------------------

/** What the caller wants out of a cell: the fields find_position and move_token both take. */
export interface PositionIntent {
  cover_from?: number;
  line_of_sight_to?: number;
  within_reach_of?: number;
  within_range_ft_of?: { combatant_id: number; range_ft: number };
  adjacent_to_feature?: string;
  max_ft?: number;
}

export interface PositionCandidate extends Point {
  cost_ft: number;
  cover_from_target: Cover | null;
  line_of_sight: boolean | null;
  distance_ft_to_target: number | null;
  note: string;
}

export const hasIntent = (intent: PositionIntent): boolean =>
  intent.cover_from !== undefined ||
  intent.line_of_sight_to !== undefined ||
  intent.within_reach_of !== undefined ||
  intent.within_range_ft_of !== undefined ||
  intent.adjacent_to_feature !== undefined;

/** The combatant a candidate is measured against: the first one the intent names. */
const intentTarget = (intent: PositionIntent): number | null =>
  intent.cover_from ??
  intent.line_of_sight_to ??
  intent.within_reach_of ??
  intent.within_range_ft_of?.combatant_id ??
  null;

/** A cell is beside a feature when it sits inside its box or in the ring of cells around it. */
function besideFeature(map: BattleMap, cell: Point, wanted: string): boolean {
  const needle = wanted.trim().toLowerCase();
  return map.features.some(
    (f) =>
      (f.kind.includes(needle) || f.label.toLowerCase().includes(needle)) &&
      cell.x >= f.x - 1 &&
      cell.x <= f.x + f.w &&
      cell.y >= f.y - 1 &&
      cell.y <= f.y + f.h,
  );
}

/** Every cell in reach that satisfies the intent, best cover first, then the shortest walk. */
export function findPositions(
  db: Db,
  input: { campaign_id: number; combatant_id: number; limit?: number } & PositionIntent,
): { combatant_id: number; budget_ft: number; candidates: PositionCandidate[]; reason: string | null } {
  const encounter = requireEncounter(db, input.campaign_id);
  const mover = getCombatant(db, encounter.id, input.combatant_id);
  const combatants = listCombatants(db, encounter.id);
  const map = encounterMap(encounter);
  const budget = input.max_ft ?? mover.movement_left;
  const targetId = intentTarget(input);
  const target = targetId === null ? null : getCombatant(db, encounter.id, targetId);
  const reach = reachOf(db, mover);

  const candidates: PositionCandidate[] = [];
  for (const cell of reachableCells(map, combatants, mover, budget)) {
    const standing = { ...mover, x: cell.x, y: cell.y };
    const others = combatants.map((c) => (c.id === mover.id ? standing : c));
    const named = (id: number): Combatant => others.find((c) => c.id === id) ?? getCombatant(db, encounter.id, id);
    const notes: string[] = [];
    let ok = true;

    let cover: Cover | null = null;
    if (input.cover_from !== undefined) {
      const from = named(input.cover_from);
      cover = coverBetween(map, others, from, standing).cover;
      if (cover === 'none') ok = false;
      else notes.push(`${cover.replace('_', '-')} cover from ${from.name}`);
    }
    let sight: boolean | null = null;
    if (ok && input.line_of_sight_to !== undefined) {
      const to = named(input.line_of_sight_to);
      sight = hasLineOfSight(map, standing, to);
      if (!sight) ok = false;
      else notes.push(`line of sight to ${to.name}`);
    }
    if (ok && input.within_reach_of !== undefined) {
      const to = named(input.within_reach_of);
      if (distanceBetween(standing, to) > reach) ok = false;
      else notes.push(`within ${reach} ft reach of ${to.name}`);
    }
    if (ok && input.within_range_ft_of !== undefined) {
      const to = named(input.within_range_ft_of.combatant_id);
      const away = distanceBetween(standing, to);
      if (away > input.within_range_ft_of.range_ft) ok = false;
      else notes.push(`${away} ft from ${to.name}, inside ${input.within_range_ft_of.range_ft} ft`);
    }
    if (ok && input.adjacent_to_feature !== undefined) {
      if (!besideFeature(map, cell, input.adjacent_to_feature)) ok = false;
      else notes.push(`beside the ${input.adjacent_to_feature}`);
    }
    if (!ok) continue;

    const measured = target === null ? null : others.find((c) => c.id === target.id)!;
    candidates.push({
      x: cell.x,
      y: cell.y,
      cost_ft: cell.cost_ft,
      cover_from_target: cover ?? (measured ? coverBetween(map, others, measured, standing).cover : null),
      line_of_sight: sight ?? (measured ? hasLineOfSight(map, standing, measured) : null),
      distance_ft_to_target: measured ? distanceBetween(standing, measured) : null,
      note: `${cell.cost_ft} ft away${notes.length ? `: ${notes.join(', ')}` : ''}.`,
    });
  }

  candidates.sort(
    (a, b) =>
      COVER_ORDER.indexOf(b.cover_from_target ?? 'none') - COVER_ORDER.indexOf(a.cover_from_target ?? 'none') ||
      a.cost_ft - b.cost_ft ||
      a.x - b.x ||
      a.y - b.y,
  );
  const limited = candidates.slice(0, input.limit ?? 5);
  const name = (id: number): string => getCombatant(db, encounter.id, id).name;
  const wanted: string[] = [];
  if (input.cover_from !== undefined) wanted.push(`cover from ${name(input.cover_from)}`);
  if (input.line_of_sight_to !== undefined) wanted.push(`line of sight to ${name(input.line_of_sight_to)}`);
  if (input.within_reach_of !== undefined) wanted.push(`${reach} ft reach of ${name(input.within_reach_of)}`);
  if (input.within_range_ft_of !== undefined) {
    wanted.push(`${input.within_range_ft_of.range_ft} ft of ${name(input.within_range_ft_of.combatant_id)}`);
  }
  if (input.adjacent_to_feature !== undefined) wanted.push(`a cell beside the ${input.adjacent_to_feature}`);
  return {
    combatant_id: mover.id,
    budget_ft: budget,
    candidates: limited,
    reason:
      limited.length > 0
        ? null
        : `No cell ${mover.name} can reach with ${budget} ft of movement gives ${
            wanted.length > 0 ? wanted.join(' and ') : 'anything asked for'
          }. Raise max_ft for a Dash, drop a constraint, or move somewhere else first.`,
  };
}

export interface TacticsView {
  distance_ft: number;
  line_of_sight: boolean;
  cover: 'none' | 'half' | 'three-quarters' | 'total';
  in_reach: boolean;
  in_range: { normal: boolean; long: boolean } | null;
  path_cost_ft: number | null;
}

/** Plenty of feet for "how far is the walk", whatever the movement left. */
const PATH_BUDGET_FT = 1000;

/** What one combatant needs to know about another: distance, sight, cover, reach, range and the walk. */
export function tacticsBetween(db: Db, campaignId: number, fromId: number, toId: number): TacticsView {
  const encounter = requireEncounter(db, campaignId);
  const from = getCombatant(db, encounter.id, fromId);
  const to = getCombatant(db, encounter.id, toId);
  const combatants = listCombatants(db, encounter.id);
  const map = encounterMap(encounter);
  const away = distanceBetween(from, to);
  const cover = coverBetween(map, combatants, from, to);
  const ranged = actionsFor(from, sheetOf(db, from)).filter((a) => a.kind === 'ranged_weapon_attack');
  const normal = Math.max(0, ...ranged.map((a) => a.range_ft ?? 0));
  const long = Math.max(normal, ...ranged.map((a) => a.long_range_ft ?? 0));
  const plan = planMove(map, combatants, from, { x: to.x, y: to.y }, PATH_BUDGET_FT, true);
  return {
    distance_ft: away,
    line_of_sight: cover.line_of_sight,
    cover: cover.cover.replace('_', '-') as TacticsView['cover'],
    in_reach: away <= reachOf(db, from),
    in_range: ranged.length > 0 ? { normal: away <= normal, long: away <= long } : null,
    path_cost_ft: away <= 5 ? 0 : plan.reached ? plan.cost_ft : null,
  };
}

// --- movement ---------------------------------------------------------------

export function moveToken(db: Db, input: Parameters<typeof runMoveToken>[1]) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'move_token', () => runMoveToken(db, input));
}

function runMoveToken(
  db: Db,
  input: {
    campaign_id: number;
    combatant_id: number;
    to?: Point;
    toward?: number;
    out_of_turn?: boolean;
    reason?: string;
    ruling?: { reason: string };
    waive_reactions?: boolean;
  } & PositionIntent,
) {
  const encounter = requireEncounter(db, input.campaign_id);
  const mover = getCombatant(db, encounter.id, input.combatant_id);
  if (!mover.alive || mover.hp_current === 0) throw new Error(`${mover.name} is down and cannot move.`);
  const stuck = speedZeroBy(mover.conditions);
  if (stuck.length > 0) {
    throw new Error(
      `${mover.name} has speed 0 while ${stuck.join(' and ')} and cannot move. End the condition first - a grapple ends with an escape, a Restrained effect with effect {op: end}.`,
    );
  }
  requireTurn(db, encounter, mover, input.out_of_turn);
  const reaction = requireReaction(mover, input.out_of_turn, input.reason);
  const combatants = listCombatants(db, encounter.id);
  const map = encounterMap(encounter);
  const ruling = input.ruling?.reason.trim();
  if (input.ruling && !ruling) throw new Error('A DM ruling needs a reason: what the player did to earn it.');
  // Dragging a grappled creature halves the mover's speed unless it is two or more sizes smaller.
  const dragged = (mover.flags.grappling ?? [])
    .map((id) => combatants.find((c) => c.id === id))
    .filter((c): c is Combatant => c !== undefined && c.alive && c.flags.grappled_by === mover.id);
  const heavy = dragged.some((c) => footprintSizes(mover.size) - footprintSizes(c.size) < 2);
  const speedLimit = dragged.length > 0 && heavy ? Math.floor(mover.movement_left / 2) : mover.movement_left;
  const budget = Math.min(speedLimit, input.max_ft ?? speedLimit);

  let target: Point;
  let adjacent = false;
  if (input.to) {
    target = input.to;
  } else if (input.toward !== undefined) {
    const other = getCombatant(db, encounter.id, input.toward);
    target = { x: other.x, y: other.y };
    adjacent = true;
  } else if (hasIntent(input)) {
    // The same intent find_position answers, resolved to its best cell and walked to.
    const found = findPositions(db, { ...input, limit: 1 });
    const best = found.candidates[0];
    if (!best) throw new Error(found.reason!);
    target = { x: best.x, y: best.y };
  } else {
    throw new Error('Pass to {x,y}, toward <combatant_id>, or an intent such as cover_from <combatant_id>.');
  }

  const before = combatants.filter(
    (c) => c.id !== mover.id && c.alive && c.team !== mover.team && distanceBetween(mover, c) <= reachOf(db, c),
  );
  let plan = planMove(map, combatants, mover, target, budget, adjacent, Boolean(ruling));
  if (plan.path.length === 0) {
    throw new Error(
      plan.budget_exhausted
        ? `${mover.name} cannot reach (${target.x},${target.y}): the path search ran out of budget on this map, so there may well be a way round. Move to a nearer waypoint first, then on from there.`
        : `${mover.name} cannot reach (${target.x},${target.y}) with ${budget} ft of movement - blocked, occupied or too far.`,
    );
  }

  // Frightened: the destination may not be closer to a frightener than the cell stepped off, ruling or not.
  const scarySources = frighteners(db, encounter, mover);
  for (const scary of scarySources) {
    if (distanceToPoint(scary, plan.destination) < distanceToPoint(scary, { x: mover.x, y: mover.y })) {
      throw new Error(
        `${mover.name} is frightened of ${scary.name} and cannot move closer to them. Move away or to one side, or end the condition with effect {op: end}.`,
      );
    }
  }

  const from = { x: mover.x, y: mover.y };
  const originalDestination = plan.destination;

  // Opportunity attacks interrupt the move: stop at the edge of the first reach the mover would leave,
  // so the reaction can be resolved while it is still in reach.
  const pending = mover.flags.disengaged
    ? []
    : combatants
        // A creature being dragged along moves with the mover, so it never sees the mover leave its reach.
        // Only one that could actually take the reaction does: awake, sighted and seeing the mover.
        .filter(
          (c) =>
            c.id !== mover.id &&
            c.alive &&
            c.team !== mover.team &&
            !c.reaction_used &&
            !dragged.includes(c) &&
            !isIncapacitated(c.conditions) &&
            !c.conditions.includes('blinded') &&
            hasLineOfSight(map, c, mover),
        )
        .map((c) => {
          const reach = reachOf(db, c);
          let inReach = distanceBetween(mover, c) <= reach;
          for (let i = 0; i < plan.path.length; i += 1) {
            const step = plan.path[i]!;
            const here = distanceBetween({ ...mover, x: step.x, y: step.y }, c);
            if (here > reach && inReach) return { combatant: c, index: i };
            inReach = here <= reach;
          }
          return null;
        })
        .filter((p): p is { combatant: Combatant; index: number } => p !== null);
  let pausedFor: Array<{ id: number; name: string; hint: string }> | null = null;
  if (!input.waive_reactions && pending.length > 0) {
    const firstIndex = Math.min(...pending.map((p) => p.index));
    const leaving = pending.filter((p) => p.index === firstIndex).map((p) => p.combatant);
    pausedFor = leaving.map((c) => ({
      id: c.id,
      name: c.name,
      hint: `${c.name} may take an opportunity attack against ${mover.name} as they leave its reach; resolve it with attack {out_of_turn: true, reason: ...} or pass waive_reactions to move_token to let it go, then call move_token again to continue.`,
    }));
    // The stop cell must be one the mover can end on: back off past anyone standing there (the plan let
    // the mover pass through them, never finish on them), down to not moving at all.
    let stopIndex = firstIndex - 1;
    while (stopIndex >= 0 && !canStand(map, combatants, mover, plan.path[stopIndex]!.x, plan.path[stopIndex]!.y)) {
      stopIndex -= 1;
    }
    if (stopIndex < 0) {
      // Already at the edge: the pause moves nobody, so it leaves no undo snapshot. One log line says
      // whose reach holds the mover, so the turn text tells the DM without a battle-state read.
      const snapshot = lastSnapshot(db, encounter.id);
      if (snapshot) dropSnapshot(db, snapshot.id);
      const held = logCombat(db, encounter, {
        actor_id: mover.id,
        kind: 'move',
        payload: { from, to: from, movement_left: mover.movement_left, paused_for: pausedFor.map((p) => p.id) },
        text: `${mover.name} holds at (${from.x},${from.y}) on the edge of ${pausedFor.map((p) => p.name).join(', ')}'s reach; the next step leaves it.`,
      });
      return finish(db, encounter, 'move_token', `${mover.name} holds at the edge of reach.`, [held], {
        combatant_id: mover.id,
        position: from,
        cost_ft: 0,
        movement_left: mover.movement_left,
        ...(ruling ? { ruling } : {}),
        reached_target: false,
        remaining_target: originalDestination,
        paused_for_reactions: pausedFor,
        path: [],
        adjacent_enemies: combatants
          .filter((c) => c.id !== mover.id && c.alive && c.team !== mover.team && distanceBetween(mover, c) <= reachOf(db, c))
          .map((c) => ({ id: c.id, name: c.name, distance_ft: distanceBetween(mover, c) })),
        opportunity_attack_warning: [],
      });
    }
    const stopCell = plan.path[stopIndex]!;
    // The pause stops short of the planned destination, so the Frightened rule must hold for that cell too.
    for (const scary of scarySources) {
      if (distanceToPoint(scary, stopCell) < distanceToPoint(scary, from)) {
        throw new Error(
          `${mover.name} is frightened of ${scary.name} and cannot move closer to them. Move away or to one side, or end the condition with effect {op: end}.`,
        );
      }
    }
    // Walk the original plan's prefix: re-planning to the stop cell can pick a different equal-cost route.
    plan = {
      path: plan.path.slice(0, stopIndex + 1),
      cost_ft: stopCell.cost,
      destination: { x: stopCell.x, y: stopCell.y },
      reached: false,
      budget_exhausted: false,
    };
  }

  mover.x = plan.destination.x;
  mover.y = plan.destination.y;
  mover.movement_left -= plan.cost_ft;
  // Steady Aim asks whether its Rogue has moved: this is the one place a creature moves itself.
  mover.flags = { ...mover.flags, moved_this_turn: true };
  // An out-of-turn move that paused has not happened yet: spend the reaction only when it completes.
  if (reaction && !pausedFor) mover.reaction_used = true;
  saveCombatant(db, mover);
  const dragging = dragged.map((c) => dragAlong(db, encounter, mover, c, from));

  const after = combatants.filter((c) => c.id !== mover.id && c.alive && c.team !== mover.team);
  // The path holds every cell after the one moved from, so walking through someone's reach counts too.
  const walkedThroughReach = (c: Combatant): boolean =>
    plan.path.some((step) => distanceBetween({ ...mover, x: step.x, y: step.y }, c) <= reachOf(db, c));
  // Disengage is the whole point of the action: nobody gets an opportunity attack for this move.
  const leftReach = mover.flags.disengaged
    ? []
    : after.filter((c) => distanceBetween(mover, c) > reachOf(db, c) && (before.includes(c) || walkedThroughReach(c)));
  const adjacentNow = after.filter((c) => distanceBetween(mover, c) <= reachOf(db, c));

  const log = [
    logCombat(db, encounter, {
      actor_id: mover.id,
      kind: 'move',
      payload: {
        from,
        to: plan.destination,
        cost_ft: plan.cost_ft,
        movement_left: mover.movement_left,
        opportunity_attacks: leftReach.map((c) => c.id),
        ...(dragging.length ? { dragged: dragging } : {}),
        ...(ruling ? { ruling } : {}),
        ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
      },
      text: reactionText(
        reaction,
        pausedFor
          ? `${ruling ? `DM ruling: ${ruling}. ` : ''}${mover.name} moves to (${mover.x},${mover.y}) for ${plan.cost_ft} ft, ${mover.movement_left} ft left, and stops at the edge of ${pausedFor.map((p) => p.name).join(', ')}'s reach.`
          : `${ruling ? `DM ruling: ${ruling}. ` : ''}${mover.name} moves to (${mover.x},${mover.y}) for ${plan.cost_ft} ft, ${mover.movement_left} ft left.${
              dragging.length ? ` Drags ${dragging.map((d) => d.name).join(', ')} along.` : ''
            }${mover.flags.disengaged ? ' Disengaged, so no opportunity attacks.' : ''}${
              leftReach.length ? ` Leaves the reach of ${leftReach.map((c) => c.name).join(', ')}.` : ''
            }`,
      ),
    }),
  ];
  return finish(db, encounter, 'move_token', `${mover.name} moves.`, log, {
    combatant_id: mover.id,
    position: plan.destination,
    cost_ft: plan.cost_ft,
    movement_left: mover.movement_left,
    ...(ruling ? { ruling } : {}),
    ...(dragging.length ? { dragged: dragging } : {}),
    reached_target: pausedFor ? false : plan.reached,
    ...(pausedFor ? { remaining_target: originalDestination, paused_for_reactions: pausedFor } : {}),
    // The A* search has a budget: on a big map "did not get there" is not proof there is no way.
    ...(plan.budget_exhausted && !plan.reached
      ? { search_note: 'The path search ran out of budget before finding the way there; move to a nearer waypoint and go on from it.' }
      : {}),
    path: plan.path,
    adjacent_enemies: adjacentNow.map((c) => ({ id: c.id, name: c.name, distance_ft: distanceBetween(mover, c) })),
    opportunity_attack_warning: leftReach.map((c) => ({
      id: c.id,
      name: c.name,
      hint: `${c.name} may spend its reaction on an opportunity attack against ${mover.name}.`,
    })),
  });
}

/** A ranged attack with a hostile that can see you within 5 ft is rushed: disadvantage. */
export function crowdedShot(db: Db, encounter: EncounterRow, attacker: Combatant): string | null {
  const map = encounterMap(encounter);
  const foe = listCombatants(db, encounter.id).find(
    (c) =>
      c.id !== attacker.id &&
      c.alive &&
      c.hp_current > 0 &&
      c.team !== attacker.team &&
      distanceBetween(c, attacker) <= 5 &&
      !isIncapacitated(c.conditions) &&
      !c.conditions.includes('blinded') &&
      hasLineOfSight(map, c, attacker),
  );
  return foe ? `${foe.name} is within 5 ft` : null;
}

const SIZE_ORDER: SizeCode[] = ['T', 'S', 'M', 'L', 'H', 'G'];

/** A size as a number, so "two or more sizes smaller" is a subtraction. */
export const footprintSizes = (size: SizeCode): number => SIZE_ORDER.indexOf(size);

/** A grappled creature comes with its grappler: it lands in the cell the grappler just left, or beside it. */
function dragAlong(
  db: Db,
  encounter: EncounterRow,
  mover: Combatant,
  target: Combatant,
  vacated: Point,
): { id: number; name: string; x: number; y: number } {
  const map = encounterMap(encounter);
  const others = listCombatants(db, encounter.id);
  // Beside the grappler when the walk ends, as near as possible to where the held creature stood.
  const cells = cellsAround(mover).sort(
    (a, b) =>
      distanceToPoint(target, a) - distanceToPoint(target, b) ||
      Math.hypot(a.x - vacated.x, a.y - vacated.y) - Math.hypot(b.x - vacated.x, b.y - vacated.y),
  );
  const spot = cells.find((cell) => canStand(map, others, target, cell.x, cell.y));
  if (spot) {
    target.x = spot.x;
    target.y = spot.y;
    saveCombatant(db, target);
  }
  return { id: target.id, name: target.name, x: target.x, y: target.y };
}

/** The ring of cells around a combatant, nearest first. */
const cellsAround = (c: Combatant): Point[] => {
  const out: Point[] = [];
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if (dx || dy) out.push({ x: c.x + dx, y: c.y + dy });
  return out;
};

/** The furthest a combatant's melee attacks reach: 10 ft with a glaive or a whip, 5 ft otherwise. */
export const reachOf = (db: Db, combatant: Combatant): number => {
  const melee = actionsFor(combatant, sheetOf(db, combatant)).filter((a) => a.kind === 'melee_weapon_attack');
  return Math.max(5, ...melee.map((a) => a.reach_ft ?? 5));
};

/** Pushes a token straight away from another, cell by cell, stopping at whatever blocks it. */
export function pushToken(db: Db, encounter: EncounterRow, from: Combatant, target: Combatant, feet: number): number {
  const map = encounterMap(encounter);
  const others = listCombatants(db, encounter.id);
  const stepX = Math.sign(target.x - from.x);
  const stepY = Math.sign(target.y - from.y);
  if (stepX === 0 && stepY === 0) return 0;
  let moved = 0;
  for (let step = 0; step < Math.floor(feet / CELL_FT); step += 1) {
    const x = target.x + stepX;
    const y = target.y + stepY;
    if (!canStand(map, others, target, x, y)) break;
    target.x = x;
    target.y = y;
    moved += CELL_FT;
  }
  if (moved > 0) saveCombatant(db, target);
  return moved;
}
