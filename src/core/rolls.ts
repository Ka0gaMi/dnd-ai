import { EventEmitter } from 'node:events';
import type { Db } from '../db/connection.js';
import { bus } from './bus.js';
import { getCampaign, logEvent, pcRow, type RollRecord } from './campaign.js';
import { rest, spendFeatureResource, spendInspiration, type RestInput, type RestResult, type RestRollSource } from './character.js';
import type { RollBoost } from '../combat/homebrew.js';
import {
  applyRollOverride,
  expressionDice,
  rollDice,
  withoutLuckPool,
  type Advantage,
  type RollDetail,
  type RollType,
} from './dice.js';
import { getSettings, luckBiasFor } from './settings.js';

export type RollSource = 'player' | 'auto' | 'override';

/** The combat step a player-clicked die belongs to, as the engine asks for it step by step. */
export type RollStep = 'attack' | 'damage' | 'save' | 'check' | 'initiative' | 'death_save';

/** What the card and the DM's tool result need to place a combat roll: which fight, step and tokens. */
export interface RollContext {
  /** Null for a roll made outside a fight, e.g. a death save between encounters. */
  encounter_id: number | null;
  tool: string;
  step: RollStep;
  /** The combatant rolling, or the character when there is no encounter. */
  actor_id: number;
  target_id?: number;
}

/** One line of where a d20 modifier came from, for the player's own card. */
export interface ModifierPart {
  label: string;
  value: number;
}

/** The homebrew boosts a pending roll offers and the ones chosen, carried in its context payload. */
export interface PendingRollBoosts {
  boosts_available?: RollBoost[];
  boosts_chosen?: string[];
  /** Whose sheet the chosen boosts are spent from when the roll resolves. */
  boosts_character_id?: number;
  /** Where a sheet-composed flat modifier came from, in the order the sheet added it. */
  modifier_parts?: ModifierPart[];
  /** Why the dice are what they are, e.g. a spell's scaling and a critical's doubling. */
  dice_notes?: string[];
}

/** What is stored in context_json: the combat step when there is one, the boosts either way, and every advantage source. */
type StoredContext = Partial<RollContext> &
  PendingRollBoosts & {
    /** Every source behind the stored `advantage`, so a later boost re-nets the whole list instead of one enum. */
    advantage_sources?: Advantage[];
  };

export interface PendingRollRow {
  id: number;
  campaign_id: number;
  expr: string;
  purpose: string;
  dc: number | null;
  roll_type: RollType;
  advantage: Advantage;
  created_at: string;
  resolved_at: string | null;
  result_json: string | null;
  source: RollSource | null;
  /** The roll the cheat-mode player was shown before deciding; resolving uses it instead of rolling again. */
  preview_json: string | null;
  /** The combat step this roll belongs to, or null for a free-standing roll. */
  context_json: string | null;
}

export interface RollInput {
  expr: string;
  purpose: string;
  dc?: number;
  campaign_id?: number;
  advantage?: Advantage;
  roll_type?: RollType;
  roller?: 'player' | 'dm';
  /** Whose roll this is; absent means the player character, as it does everywhere else. */
  character_id?: number;
  context?: RollContext;
  /** The homebrew clauses this roll could be boosted with; the card offers them before it is rolled. */
  boosts_available?: RollBoost[];
  /** Where a sheet-composed flat modifier came from; the player's card shows it. */
  modifier_parts?: ModifierPart[];
  /** Why the dice are what they are, shown beside the expression on the player's card. */
  dice_notes?: string[];
  /** Every source behind `advantage`, kept so a later boost re-nets the list rather than the single enum. */
  advantage_sources?: Advantage[];
}

export interface RollOverride {
  /** One value per die the expression rolls, in written order: what cheat mode edits. */
  dice?: number[];
  /** Kept for the older shape: a single d20's face. */
  natural?: number;
  /** Kept for the older shape; the total is not editable on its own. */
  total?: number;
}

/** Cheat mode sets dice, never sums: this turns whatever the caller sent into the dice it means. */
function overrideDice(expr: string, override: RollOverride): number[] {
  const sides = expressionDice(expr);
  if (!sides) throw new RollError(`The dice of "${expr}" cannot be edited.`, 400);
  const wanted = override.dice ?? (override.natural === undefined ? null : [override.natural]);
  if (!wanted) {
    throw new RollError('A roll is edited by its dice, not by its total: send dice, one value per die.', 400);
  }
  if (wanted.length !== sides.length) {
    throw new RollError(`This roll has ${sides.length} dice; send one value for each.`, 400);
  }
  wanted.forEach((value, index) => {
    const faces = sides[index]!;
    if (!Number.isInteger(value) || value < 1 || value > faces) {
      throw new RollError(`A d${faces} shows 1 to ${faces}, not ${value}.`, 400);
    }
  });
  return wanted;
}

/** Carries the HTTP status the resolve route answers with. */
export class RollError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Advantage and Disadvantage never stack: one of each cancels, however many sources there are. */
export function netAdvantage(sources: Advantage[]): Advantage {
  const up = sources.includes('advantage');
  const down = sources.includes('disadvantage');
  return up && down ? 'none' : up ? 'advantage' : down ? 'disadvantage' : 'none';
}

/** Wakes the tool call blocking on a pending roll the moment the player resolves it. */
const waiters = new EventEmitter();

const nowIso = (): string => new Date().toISOString();

function parseResult(json: string | null): { roll?: RollRecord } | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as { roll?: RollRecord };
  } catch {
    return null;
  }
}

function parseContext(json: string | null): StoredContext | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredContext;
  } catch {
    return null;
  }
}

/** The boosts on offer for this roll and the ones already chosen, for the card and the DM's reply. */
export function rollBoosts(
  row: PendingRollRow,
): Required<Pick<PendingRollBoosts, 'boosts_available' | 'boosts_chosen'>> &
  Pick<PendingRollBoosts, 'modifier_parts' | 'dice_notes'> {
  const context = parseContext(row.context_json);
  return {
    boosts_available: context?.boosts_available ?? [],
    boosts_chosen: context?.boosts_chosen ?? [],
    ...(context?.modifier_parts?.length ? { modifier_parts: context.modifier_parts } : {}),
    ...(context?.dice_notes?.length ? { dice_notes: context.dice_notes } : {}),
  };
}

/** No character named means the player character; a named one is only the PC when their row says so. */
function isPlayerCharacter(db: Db, campaignId: number, characterId?: number): boolean {
  if (characterId === undefined) return true;
  const row = db.prepare('SELECT is_pc FROM character WHERE id = ? AND campaign_id = ?').get(characterId, campaignId) as
    | { is_pc: number }
    | undefined;
  return row?.is_pc === 1;
}

/**
 * The luck dial follows whoever the card was pushed for: outside a fight the context names them, and
 * inside one only the player character is ever asked to click.
 */
function pendingRollLuck(db: Db, row: PendingRollRow): number {
  const context = parseContext(row.context_json);
  const characterId = context && context.encounter_id === null ? context.actor_id : undefined;
  return luckBiasFor(db, row.campaign_id, isPlayerCharacter(db, row.campaign_id, characterId));
}

export function getPendingRoll(db: Db, id: number): PendingRollRow | undefined {
  return db.prepare('SELECT * FROM pending_roll WHERE id = ?').get(id) as PendingRollRow | undefined;
}

export function openPendingRolls(db: Db, campaignId: number): PendingRollRow[] {
  return db
    .prepare('SELECT * FROM pending_roll WHERE campaign_id = ? AND resolved_at IS NULL ORDER BY id')
    .all(campaignId) as PendingRollRow[];
}

/** Writes the roll the player is asked for and pushes it to the companion window. */
export function createPendingRoll(db: Db, input: RollInput & { campaign_id: number }): PendingRollRow {
  getCampaign(db, input.campaign_id);
  const ts = nowIso();
  const id = Number(
    db
      .prepare(
        'INSERT INTO pending_roll (campaign_id, expr, purpose, dc, roll_type, advantage, created_at, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.campaign_id,
        input.expr,
        input.purpose,
        input.dc ?? null,
        input.roll_type ?? 'other',
        input.advantage ?? 'none',
        ts,
        storedContext(input),
      ).lastInsertRowid,
  );
  const row = getPendingRoll(db, id)!;
  bus.publish({
    campaign_id: row.campaign_id,
    event_id: null,
    kind: 'pending_roll',
    text: `${row.purpose}${row.dc === null ? '' : ` vs DC ${row.dc}`}`,
    ts,
    payload: { ...row, ...rollBoosts(row) },
  });
  return row;
}

/** The context column: the combat step, the boosts the clauses offer, the modifier parts, the dice notes and the advantage sources. */
function storedContext(input: RollInput & { campaign_id: number }): string | null {
  const boosts = input.boosts_available ?? [];
  const parts = input.modifier_parts ?? [];
  const notes = input.dice_notes ?? [];
  const sources = (input.advantage_sources ?? []).filter((one) => one !== 'none');
  if (!input.context && boosts.length === 0 && parts.length === 0 && notes.length === 0) return null;
  const stored: StoredContext = {
    ...(input.context ?? {}),
    ...(boosts.length ? { boosts_available: boosts } : {}),
    ...(boosts.length && input.character_id !== undefined ? { boosts_character_id: input.character_id } : {}),
    ...(parts.length ? { modifier_parts: parts } : {}),
    ...(notes.length ? { dice_notes: notes } : {}),
    ...(sources.length ? { advantage_sources: sources } : {}),
  };
  return JSON.stringify(stored);
}

const signed = (value: number): string => (value < 0 ? String(value) : `+${value}`);

/**
 * The advantage sources behind a pending roll: the stored list, or the single netted enum for a row
 * written before lists were kept. A Disadvantage an earlier cancellation removed cannot come back here.
 */
function storedAdvantageSources(context: StoredContext | null, row: PendingRollRow): Advantage[] {
  const stored = context?.advantage_sources;
  if (stored !== undefined) return stored;
  return row.advantage === 'none' ? [] : [row.advantage];
}

/**
 * A boost the player chose before rolling: the roll is recomputed with it and the choice recorded. The
 * use is not spent here - it is spent when the roll resolves, so a card left open costs nothing.
 */
export function applyRollBoost(db: Db, id: number, boostId: string): PendingRollRow & PendingRollBoosts {
  const row = getPendingRoll(db, id);
  if (!row) throw new RollError(`No pending roll with id ${id}.`, 404);
  if (row.resolved_at) throw new RollError(`Pending roll ${id} was already resolved.`, 409);
  if (row.preview_json) throw new RollError('The dice are already on the table; a boost is chosen before the roll.', 409);
  const context = parseContext(row.context_json) ?? {};
  const boost = (context.boosts_available ?? []).find((one) => one.id === boostId);
  if (!boost) {
    const names = (context.boosts_available ?? []).map((one) => one.id).join(', ') || 'none';
    throw new RollError(`No boost "${boostId}" on this roll. Available: ${names}.`, 400);
  }
  const chosen = context.boosts_chosen ?? [];
  if (chosen.includes(boostId)) throw new RollError(`${boost.name} is already on this roll.`, 409);
  // Advantage and Disadvantage cancel, as they do everywhere else; a flat bonus goes into the expression.
  // The whole source list is re-netted, so a Disadvantage an earlier cancellation removed is still there.
  const sources = boost.advantage
    ? [...storedAdvantageSources(context, row), 'advantage' as Advantage]
    : storedAdvantageSources(context, row);
  const advantage: Advantage = netAdvantage(sources);
  const expr = boost.bonus ? `${row.expr}${signed(boost.bonus)}` : row.expr;
  // A flat bonus joins the card's breakdown too, so the parts keep summing to the modifier in expr.
  const parts =
    boost.bonus && context.modifier_parts?.length
      ? { modifier_parts: [...context.modifier_parts, { label: boost.name, value: boost.bonus }] }
      : {};
  db.prepare('UPDATE pending_roll SET expr = ?, advantage = ?, context_json = ? WHERE id = ?').run(
    expr,
    advantage,
    JSON.stringify({ ...context, ...parts, boosts_chosen: [...chosen, boostId], advantage_sources: sources }),
    id,
  );
  const updated = getPendingRoll(db, id)!;
  bus.publish({
    campaign_id: row.campaign_id,
    event_id: null,
    kind: 'pending_roll',
    text: `${row.purpose} (${boost.name})`,
    ts: nowIso(),
    payload: { ...updated, ...rollBoosts(updated) },
  });
  return { ...updated, ...rollBoosts(updated) };
}

/**
 * The chosen boosts, spent once the roll stands - and only then, which is what "you can" buys. A roll
 * made inside a fight is not paid for here: the engine spends it inside the snapshot the call runs in,
 * so undoing the attack gives the use back.
 */
function spendChosenBoosts(db: Db, row: PendingRollRow): void {
  const context = parseContext(row.context_json);
  const chosen = context?.boosts_chosen ?? [];
  if (chosen.length === 0 || context?.encounter_id != null) return;
  for (const id of chosen) {
    const boost = (context?.boosts_available ?? []).find((one) => one.id === id);
    if (!boost) continue;
    const characterId = context?.boosts_character_id ?? pcRow(db, row.campaign_id)?.id;
    if (typeof characterId !== 'number') continue;
    spendFeatureResource(db, {
      campaign_id: row.campaign_id,
      character_id: characterId,
      resource: boost.id,
      label: boost.label,
      max: boost.max,
      per: boost.per,
    });
  }
}

function storedPreview(row: PendingRollRow): RollDetail | null {
  if (!row.preview_json) return null;
  try {
    return JSON.parse(row.preview_json) as RollDetail;
  } catch {
    return null;
  }
}

/** A d20 test: the only kind of roll Heroic Inspiration may be spent on. */
const isD20Test = (row: PendingRollRow): boolean => row.roll_type !== 'damage' && /^\s*1?d20/i.test(row.expr);

/** Whether the player has Heroic Inspiration in hand for this roll. */
function canInspire(db: Db, row: PendingRollRow): boolean {
  if (!isD20Test(row)) return false;
  return pcRow(db, row.campaign_id)?.inspiration === 1;
}

/**
 * Rolls the pending roll once and keeps it, so the player can see the result before it stands:
 * cheat mode may edit it, and a player holding Heroic Inspiration may reroll it. Resolving afterwards
 * uses this roll rather than rolling again.
 */
export function previewPendingRoll(db: Db, id: number): RollRecord {
  const row = getPendingRoll(db, id);
  if (!row) throw new RollError(`No pending roll with id ${id}.`, 404);
  if (row.resolved_at) throw new RollError(`Pending roll ${id} was already resolved.`, 409);
  const settings = getSettings(db, row.campaign_id);
  if (!settings.cheat_mode && !canInspire(db, row)) {
    throw new RollError('Cheat mode is off; a roll cannot be previewed.', 403);
  }

  let detail = storedPreview(row);
  if (!detail) {
    detail = rollDice(row.expr, {
      advantage: row.advantage,
      dc: row.dc,
      roll_type: row.roll_type,
      luck_bias: pendingRollLuck(db, row),
    });
    db.prepare('UPDATE pending_roll SET preview_json = ? WHERE id = ?').run(JSON.stringify(detail), id);
  }
  return { ...detail, id: null, purpose: row.purpose, campaign_id: row.campaign_id };
}

/**
 * Records the pending roll. Without an override the previewed (or freshly rolled) result stands; with
 * one (cheat mode only) that result is kept as the original and the edited values become final.
 */
export function resolvePendingRoll(
  db: Db,
  id: number,
  override?: RollOverride,
  source: RollSource = override ? 'override' : 'player',
): RollRecord {
  const row = getPendingRoll(db, id);
  if (!row) throw new RollError(`No pending roll with id ${id}.`, 404);
  const settings = getSettings(db, row.campaign_id);
  if (override && !settings.cheat_mode) throw new RollError('Cheat mode is off; a roll cannot be overridden.', 403);
  // Checked before the roll is claimed, so a rejected edit leaves it waiting for the player.
  const edited = override ? overrideDice(row.expr, override) : null;

  const claimed = db
    .prepare('UPDATE pending_roll SET resolved_at = ?, source = ? WHERE id = ? AND resolved_at IS NULL')
    .run(nowIso(), source, id);
  if (claimed.changes === 0) throw new RollError(`Pending roll ${id} was already resolved.`, 409);

  const luck = pendingRollLuck(db, row);
  const original =
    storedPreview(row) ??
    rollDice(row.expr, {
      advantage: row.advantage,
      dc: row.dc,
      roll_type: row.roll_type,
      luck_bias: luck,
    });
  const final = edited ? applyRollOverride(original, edited) : original;
  const roll = recordRoll(db, final, row.campaign_id, row.purpose, luck, {
    overridden: Boolean(override),
    pending_roll_id: id,
  });
  db.prepare('UPDATE pending_roll SET result_json = ? WHERE id = ?').run(
    JSON.stringify({
      roll,
      source,
      overridden: Boolean(override),
      original: override ? { total: original.total, natural_d20: original.natural_d20, outcome: original.outcome } : null,
    }),
    id,
  );
  spendChosenBoosts(db, row);
  waiters.emit(`roll:${id}`);
  return roll;
}

/** The faces of the leading d20 pool: the die, plus one for Advantage and any the luck dial added. */
function d20Pool(detail: RollDetail): number[] {
  const first = detail.groups[0];
  return typeof first === 'object' && first !== null ? first.dice.map((die) => die.value) : [];
}

/**
 * Heroic Inspiration rerolls one die, not the pool: a fresh d20 replaces the one that counted, the other
 * dice of an advantage pool stand, and the pool keeps its higher-or-lower rule.
 */
function inspiredD20(shown: RollDetail, natural: number, pool: number[], luck: number): RollDetail {
  const fresh = rollDice('1d20').natural_d20;
  if (fresh === null) throw new RollError('Heroic Inspiration rerolls a d20; this roll has none.', 400);
  const rerolled = [...pool];
  rerolled[Math.max(0, rerolled.indexOf(natural))] = fresh;
  const high = shown.advantage === 'advantage' || (shown.advantage === 'none' && luck > 0);
  return applyRollOverride(shown, [high ? Math.max(...rerolled) : Math.min(...rerolled)]);
}

/**
 * Heroic Inspiration, as the 2024 rules have it: the player sees the d20, spends their inspiration and
 * must take the reroll. The dice are the server's throughout.
 */
export function inspirePendingRoll(db: Db, id: number): RollRecord {
  const row = getPendingRoll(db, id);
  if (!row) throw new RollError(`No pending roll with id ${id}.`, 404);
  if (row.resolved_at) throw new RollError(`Pending roll ${id} was already resolved.`, 409);
  if (!isD20Test(row)) throw new RollError('Heroic Inspiration rerolls a d20 test; this roll is not one.', 400);
  if (!canInspire(db, row)) throw new RollError('There is no Heroic Inspiration to spend.', 409);
  const shown = storedPreview(row);
  if (!shown) throw new RollError('Roll it first: Heroic Inspiration rerolls a roll the player has seen.', 400);

  const claimed = db
    .prepare("UPDATE pending_roll SET resolved_at = ?, source = 'player' WHERE id = ? AND resolved_at IS NULL")
    .run(nowIso(), id);
  if (claimed.changes === 0) throw new RollError(`Pending roll ${id} was already resolved.`, 409);

  const luck = pendingRollLuck(db, row);
  const pool = d20Pool(shown);
  const again =
    expressionDice(shown.requested_expr)?.length === 1 && pool.length > 0 && shown.natural_d20 !== null
      ? inspiredD20(shown, shown.natural_d20, pool, luck)
      : rollDice(row.expr, {
          advantage: row.advantage,
          dc: row.dc,
          roll_type: row.roll_type,
          luck_bias: luck,
        });
  const recorded = recordRoll(db, again, row.campaign_id, row.purpose, luck, { pending_roll_id: id });
  // The boost the player chose is on this reroll as much as on the first one: it is spent all the same.
  spendChosenBoosts(db, row);
  const inspired = { from: shown.total, to: recorded.total };
  spendInspiration(db, { campaign_id: row.campaign_id, note: `${inspired.from} → ${inspired.to}` });
  const roll: RollRecord = { ...recorded, inspired };
  db.prepare('UPDATE pending_roll SET result_json = ? WHERE id = ?').run(
    JSON.stringify({
      roll,
      source: 'player',
      overridden: false,
      original: { total: shown.total, natural_d20: shown.natural_d20, outcome: shown.outcome },
      inspired,
    }),
    id,
  );
  waiters.emit(`roll:${id}`);
  return roll;
}

/** A rewind drops the rolls nobody answered; a tool still waiting rolls them itself. */
export function cancelPendingRolls(db: Db, campaignId: number): number {
  const open = openPendingRolls(db, campaignId);
  for (const row of open) {
    db.prepare("UPDATE pending_roll SET resolved_at = ?, source = 'auto', result_json = ? WHERE id = ?").run(
      nowIso(),
      JSON.stringify({ cancelled: true }),
      row.id,
    );
    waiters.emit(`roll:${row.id}`);
  }
  return open.length;
}

/**
 * The `roll` tool: a player roll waits for the click (up to roll_timeout_s, then it auto-rolls),
 * everything else rolls straight away.
 */
export async function rollForTool(db: Db, input: RollInput): Promise<RollRecord> {
  if (input.campaign_id === undefined) {
    const detail = rollDice(input.expr, {
      advantage: input.advantage,
      dc: input.dc ?? null,
      roll_type: input.roll_type,
    });
    return { ...detail, id: null, purpose: input.purpose, campaign_id: null };
  }
  const campaignId = input.campaign_id;
  const settings = getSettings(db, campaignId);
  // Only the player character's own dice reach their window: a companion the DM sends through the
  // player flow is rolled by the server, as the engine rolls one.
  const isPc = isPlayerCharacter(db, campaignId, input.character_id);
  if (input.roller === 'player' && isPc && settings.roll_mode === 'player') {
    const pending = createPendingRoll(db, { ...input, campaign_id: campaignId });
    return awaitPendingRoll(db, pending, settings.roll_timeout_s * 1000);
  }
  // The luck dial is the player's own thumb on the scale: it never touches a companion's, a monster's
  // or a hidden roll, which is what roller 'dm' means.
  return rollNow(
    db,
    { ...input, campaign_id: campaignId },
    input.roller === 'player' ? luckBiasFor(db, campaignId, isPc) : 0,
  );
}

/**
 * Whether the player clicks this die themselves: only their own character's, only while they roll,
 * and damage only when they asked for every die.
 */
export function playerRollsStep(db: Db, campaignId: number, isPlayerCharacter: boolean, step: RollStep): boolean {
  if (!isPlayerCharacter) return false;
  const settings = getSettings(db, campaignId);
  if (settings.roll_mode !== 'player' || settings.player_rolls === 'none') return false;
  return settings.player_rolls === 'all' || step !== 'damage';
}

/** One step of a combat chain: the card goes out, the engine waits, the timeout rolls it instead. */
export async function awaitPlayerRoll(
  db: Db,
  input: RollInput & { campaign_id: number; context: RollContext },
): Promise<RollRecord & { boosts_chosen?: string[] }> {
  const settings = getSettings(db, input.campaign_id);
  const pending = createPendingRoll(db, { ...input, campaign_id: input.campaign_id });
  const roll = await awaitPendingRoll(db, pending, settings.roll_timeout_s * 1000);
  // What the player toggled on the card goes back to the engine, which spends it where it can undo it.
  const chosen = rollBoosts(getPendingRoll(db, pending.id) ?? pending).boosts_chosen;
  return chosen.length ? { ...roll, boosts_chosen: chosen } : roll;
}

/** A rest die the player has not answered yet: the rest stops here until the card resolves. */
class RestRollPending extends Error {
  constructor(readonly pending: PendingRollRow) {
    super(`Waiting for the player to roll ${pending.expr} (${pending.purpose}).`);
  }
}

/**
 * Whether the player rolls their own rest dice: their own character's, and only when they asked for
 * every die. A companion's rest never waits, and neither does a rest under roll_mode 'auto'.
 */
function restRollsToPlayer(db: Db, campaignId: number, characterId?: number): boolean {
  const settings = getSettings(db, campaignId);
  return settings.roll_mode === 'player' && settings.player_rolls === 'all' && isPlayerCharacter(db, campaignId, characterId);
}

/**
 * A rest the way the table asked for it: under player_rolls 'all' the hit dice and any homebrew rest
 * healing wait on a card like every other player roll, with the same timeout fallback. The rest body
 * is synchronous, so it is run again from the current sheet once each card resolves.
 */
export async function restWithPlayerRolls(db: Db, input: RestInput): Promise<RestResult> {
  if (!restRollsToPlayer(db, input.campaign_id, input.character_id)) return rest(db, input);
  const timeoutMs = getSettings(db, input.campaign_id).roll_timeout_s * 1000;
  const answers: RollRecord[] = [];
  for (;;) {
    let served = 0;
    const source: RestRollSource = (request) => {
      if (served < answers.length) return answers[served++]!;
      // The rest has reached a die the player has not rolled: push the card and stop this run.
      throw new RestRollPending(createPendingRoll(db, { ...request, campaign_id: input.campaign_id }));
    };
    try {
      return rest(db, input, source);
    } catch (err) {
      if (!(err instanceof RestRollPending)) throw err;
      // Outside any transaction, so the wait never holds one open; a timeout or a rewind rolls it here.
      answers.push(await awaitPendingRoll(db, err.pending, timeoutMs));
    }
  }
}

async function awaitPendingRoll(db: Db, pending: PendingRollRow, timeoutMs: number): Promise<RollRecord> {
  const key = `roll:${pending.id}`;
  // A listener on the pushed card can resolve the roll before we start waiting: do not wait for a
  // wake-up that has already happened.
  if (getPendingRoll(db, pending.id)?.resolved_at === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.off(key, done);
        resolve();
      }, timeoutMs);
      waiters.once(key, done);
    });
  }

  const stored = parseResult(getPendingRoll(db, pending.id)?.result_json ?? null);
  if (stored?.roll) return stored.roll;
  try {
    return resolvePendingRoll(db, pending.id, undefined, 'auto');
  } catch (err) {
    if (!(err instanceof RollError) || err.status !== 409) throw err;
    // Resolved between the wake-up and the claim, or cancelled by a rewind: read it back or roll now.
    const late = parseResult(getPendingRoll(db, pending.id)?.result_json ?? null);
    if (late?.roll) return late.roll;
    return rollNow(
      db,
      {
        expr: pending.expr,
        purpose: pending.purpose,
        dc: pending.dc ?? undefined,
        campaign_id: pending.campaign_id,
        advantage: pending.advantage,
        roll_type: pending.roll_type,
      },
      pendingRollLuck(db, pending),
      { pending_roll_id: pending.id },
    );
  }
}

function rollNow(
  db: Db,
  input: RollInput & { campaign_id: number },
  luckBias: number,
  extra: { overridden?: boolean; pending_roll_id?: number } = {},
): RollRecord {
  const detail = rollDice(input.expr, {
    advantage: input.advantage,
    dc: input.dc ?? null,
    roll_type: input.roll_type,
    luck_bias: luckBias,
  });
  return recordRoll(db, detail, input.campaign_id, input.purpose, luckBias, extra);
}

/**
 * A passive check: no dice at all, 10 plus the modifier. It is no roll, so it writes no roll row and
 * nothing reaches the player's window; it is logged as a DM-only passive_check event instead.
 */
export function recordPassiveCheck(
  db: Db,
  input: {
    campaign_id: number;
    purpose: string;
    character: string;
    skill?: string | null;
    ability?: string;
    modifier: number;
    advantage: Advantage;
    total: number;
    dc?: number | null;
  },
): { event_id: number; purpose: string; total: number; dc: number | null; outcome: 'success' | 'failure' | null } {
  const campaign = getCampaign(db, input.campaign_id);
  const dc = input.dc ?? null;
  const outcome = dc === null ? null : input.total >= dc ? 'success' : 'failure';
  const purpose = `${input.purpose} (passive)`;
  // The DC and the outcome stay in the payload: the text is what a reader of the log sees first.
  const event = logEvent(db, {
    campaign_id: campaign.id,
    kind: 'passive_check',
    text: `${input.character}: ${purpose} ${input.total}`,
    payload: {
      purpose: input.purpose,
      character: input.character,
      skill: input.skill ?? null,
      ability: input.ability ?? null,
      modifier: input.modifier,
      advantage: input.advantage,
      total: input.total,
      dc,
      outcome,
    },
  });
  return { event_id: event.id, purpose, total: input.total, dc, outcome };
}

/** One roll row plus its event. The luck dial and the cheat flag stay in the database. */
function recordRoll(
  db: Db,
  detail: RollDetail,
  campaignId: number,
  purpose: string,
  luckBias: number,
  extra: { overridden?: boolean; pending_roll_id?: number } = {},
): RollRecord {
  const campaign = getCampaign(db, campaignId);
  // The luck dial is the player's own: the event and the roll the tool reads back read as the roll
  // that was asked for, while the row keeps the whole pool for their ledger.
  const shown = withoutLuckPool(detail);
  const id = db.transaction(() => {
    const event = logEvent(db, {
      campaign_id: campaign.id,
      kind: 'roll',
      text: `${purpose}: ${shown.output}${detail.dc === null ? '' : ` vs DC ${detail.dc}`}${
        detail.outcome ? ` -> ${detail.outcome}` : ''
      }${detail.natural ? ` (natural ${detail.natural})` : ''}`,
      payload: {
        expr: shown.expr,
        total: detail.total,
        outcome: detail.outcome,
        advantage: detail.advantage,
        roll_type: detail.roll_type,
        natural: detail.natural,
        pending_roll_id: extra.pending_roll_id ?? null,
      },
    });
    return Number(
      db
        .prepare(
          'INSERT INTO roll (campaign_id, event_id, expr, results_json, total, purpose, dc, outcome, luck_bias_applied, overridden, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          campaign.id,
          event.id,
          detail.expr,
          JSON.stringify(detail.groups),
          detail.total,
          purpose,
          detail.dc,
          detail.outcome,
          luckBias,
          extra.overridden ? 1 : 0,
          event.ts,
        ).lastInsertRowid,
    );
  })();
  return { ...shown, id, purpose, campaign_id: campaign.id };
}
