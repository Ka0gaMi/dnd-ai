// Combat engine: starting an encounter, initiative and adding combatants.
import {
  creatureLook,
  scheduleCombatantPortraits,
  type CombatantPortraitTarget,
} from '../core/auto-portraits.js';
import { party, pcRow } from '../core/campaign.js';
import { expressionDice, randomSeed, rollDice, withoutLuckPool } from '../core/dice.js';
import { getSettings } from '../core/settings.js';
import type { CreatureStatBlock, StatBlockAction } from '../srd/data.js';
import * as srd from '../srd/data.js';
import type { Db } from '../db/connection.js';
import { initiativeBonus } from './actions.js';
import { initiativeOutcomes, persistentRageOffer } from './features.js';
import { canStand, sizeCode, type Point, type SizeCode } from './grid.js';
import { generateBattleMap, type MapSize, type Terrain } from './map.js';
import { combatSheet, type CombatSheet } from './sheet.js';
import { underSnapshot } from './undo.js';
import {
  activeCombatant,
  encounterMap,
  getCombatant,
  insertCombatant,
  listCombatants,
  logCombat,
  requireEncounter,
  saveCombatant,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
  type Team,
} from './state.js';
import { signed, nowIso, refresh, finish, sheetOf, pcLuck } from './engine-core.js';
import { d20Context, askPlayer } from './d20.js';
import { tickEffects } from './effects.js';
import { applyOutcome } from './outcome.js';

// --- starting an encounter --------------------------------------------------

export interface EnemySpec {
  creature: string;
  count?: number;
  name?: string;
  /** This one is somebody in their own right and gets a portrait of their own. */
  unique?: boolean;
  /** Caught out by the ambush: initiative with disadvantage, the 2024 way of being surprised. */
  surprised?: boolean;
  /** Actions of its own, replacing the stat block's action of the same name or adding a new one. */
  actions?: StatBlockAction[];
}

export interface StartEncounterInput {
  campaign_id: number;
  seed?: number;
  terrain: Terrain;
  size?: MapSize;
  features?: string[];
  enemies: EnemySpec[];
  extra_party?: number[];
  /** Character ids of the party members the ambush caught: they roll initiative with disadvantage. */
  surprised_ids?: number[];
}

/** The SRD stat block for a creature name, as start_encounter and add_combatant place it. */
export function statBlockFor(name: string): CreatureStatBlock {
  const wanted = name.trim().toLowerCase();
  const creatures = srd.creatures();
  const found =
    creatures.find((c) => c.fields.name.toLowerCase() === wanted) ??
    creatures.find((c) => c.fields.name.toLowerCase().includes(wanted));
  if (!found) throw new Error(`No SRD creature matches "${name}". Try srd_lookup with kind "creature".`);
  return srd.creatureStatBlock(found);
}

const OVERRIDE_TARGET: Record<StatBlockAction['kind'], 'actions' | 'bonus_actions' | 'reactions' | 'legendary_actions'> =
  {
    melee_weapon_attack: 'actions',
    ranged_weapon_attack: 'actions',
    action: 'actions',
    bonus_action: 'bonus_actions',
    reaction: 'reactions',
    legendary_action: 'legendary_actions',
  };

/** A malformed override refuses the whole call before anything is written: the dice must parse, that is all. */
function validateActionOverrides(creature: string, overrides: StatBlockAction[]): void {
  for (const override of overrides) {
    if (!override.name?.trim()) {
      throw new Error(`Enemy "${creature}" has an action override without a name.`);
    }
    for (const part of override.damage ?? []) {
      if (expressionDice(part.dice) === null) {
        throw new Error(
          `Enemy "${creature}": the action override "${override.name}" carries damage "${part.dice}", which is not a dice expression.`,
        );
      }
    }
  }
}

/** A named monster's own actions: the same name replaces the stat block's action wherever it lives, a new name joins the list its kind implies. */
function applyActionOverrides(block: CreatureStatBlock, overrides: StatBlockAction[]): CreatureStatBlock {
  const lists = {
    actions: [...block.actions],
    bonus_actions: [...block.bonus_actions],
    reactions: [...block.reactions],
    legendary_actions: [...block.legendary_actions],
  };
  for (const override of overrides) {
    const stored: StatBlockAction = {
      ...override,
      damage: override.damage?.map((part) => ({ dice: part.dice, type: part.type ? part.type.toLowerCase() : null })),
      text: override.text,
    };
    const list = Object.values(lists).find((actions) =>
      actions.some((a) => a.name.toLowerCase() === stored.name.toLowerCase()),
    );
    if (list) {
      list[list.findIndex((a) => a.name.toLowerCase() === stored.name.toLowerCase())] = stored;
    } else {
      lists[OVERRIDE_TARGET[stored.kind]].push(stored);
    }
  }
  return { ...block, ...lists };
}

function freeCell(
  encounter: EncounterRow,
  size: SizeCode,
  preferX: number,
  placed: Combatant[],
): Point {
  const map = encounterMap(encounter);
  const token = { id: -1, x: 0, y: 0, size, alive: true };
  const centre = Math.floor(map.h / 2);
  for (let dx = 0; dx < map.w; dx += 1) {
    for (const x of [preferX + dx, preferX - dx]) {
      if (x < 0 || x >= map.w) continue;
      for (let dy = 0; dy < map.h; dy += 1) {
        for (const y of [centre + dy, centre - dy]) {
          if (y < 0 || y >= map.h) continue;
          if (canStand(map, placed, { ...token, x, y }, x, y)) return { x, y };
        }
      }
    }
  }
  throw new Error('The map has no free cell left to place a combatant.');
}

export function addToEncounter(
  db: Db,
  encounter: EncounterRow,
  input: {
    kind: Combatant['kind'];
    name: string;
    team: Team;
    statBlock?: CreatureStatBlock | null;
    sheet?: CombatSheet | null;
    x?: number;
    y?: number;
    preferX: number;
  },
): Combatant {
  const size = input.statBlock ? sizeCode(input.statBlock.size) : (input.sheet?.size ?? 'M');
  const placed = listCombatants(db, encounter.id);
  const at =
    input.x !== undefined && input.y !== undefined
      ? { x: input.x, y: input.y }
      : freeCell(encounter, size, input.preferX, placed);
  const map = encounterMap(encounter);
  if (!canStand(map, placed, { id: -1, x: at.x, y: at.y, size, alive: true }, at.x, at.y)) {
    throw new Error(`(${at.x},${at.y}) is blocked or occupied; pick another cell or omit x and y.`);
  }
  const hpMax = input.sheet ? input.sheet.hp_max : (input.statBlock?.hp ?? 1);
  const id = insertCombatant(db, {
    encounter_id: encounter.id,
    kind: input.kind,
    character_id: input.sheet?.id ?? null,
    stat_block: input.statBlock ?? null,
    name: input.name,
    team: input.team,
    x: at.x,
    y: at.y,
    size,
    hp_current: input.sheet ? input.sheet.hp_current : hpMax,
    hp_max: hpMax,
    temp_hp: input.sheet?.temp_hp ?? 0,
    ac: input.sheet ? input.sheet.ac : (input.statBlock?.ac ?? 10),
    speed: input.sheet ? input.sheet.speed : (input.statBlock?.speed.walk ?? 30),
    conditions: input.sheet?.conditions ?? [],
    death_saves: input.sheet?.death_saves,
    // Above 0 HP everyone is alive; at 0 a PC or companion is alive until their sheet says dead.
    alive: (input.sheet ? input.sheet.hp_current : hpMax) > 0 || (input.kind !== 'monster' && input.sheet?.status !== 'dead'),
  });
  return getCombatant(db, encounter.id, id);
}

/** One combatant's initiative: the player clicks their own, everyone else is rolled here. */
export async function rollOwnInitiative(
  db: Db,
  encounter: EncounterRow,
  combatant: Combatant,
  bonus: number,
  tool: string,
  surprised = false,
): Promise<{ total: number; output: string }> {
  // Initiative is a DEX check: exhaustion, unfamiliar armour and the rest of the d20 context count.
  const context = d20Context(db, encounter, combatant, {
    kind: 'check',
    ability: 'dex',
    str_or_dex: true,
    initiative: true,
    advantage: surprised ? 'disadvantage' : 'none',
  });
  const advantage = context.advantage;
  const rolled = bonus + context.penalty;
  const pre = await askPlayer(db, encounter, combatant, 'initiative', {
    tool,
    expr: `1d20${signed(rolled)}`,
    purpose: surprised ? 'Initiative (surprised: disadvantage)' : 'Initiative',
    roll_type: 'check',
    advantage,
    advantage_sources: context.advantage_sources,
  });
  if (pre) return { total: pre.total, output: pre.output };
  const roll = withoutLuckPool(
    rollDice(`1d20${signed(rolled)}`, { roll_type: 'check', advantage, luck_bias: pcLuck(db, encounter, combatant) }),
  );
  return { total: roll.total, output: roll.output };
}

/** Initiative: d20 plus the DEX modifier or the stat block's bonus, ties broken by DEX then by a second d20. */
/** Persistent Rage is offered when Initiative is rolled, never taken: this is what the DM is shown. */
export interface PersistentRageOffer {
  combatant_id: number;
  name: string;
  rages: number;
  hint: string;
}

/**
 * Perfect Focus, Superior Inspiration, Archdruid and Boon of Fate all key off rolling Initiative: this is
 * that seam, asked of every character on the field once the order is settled. Persistent Rage keys off it
 * too, but its text says "you can regain", so it leaves an offer here instead of spending itself.
 */
function initiativeFeatures(db: Db, encounter: EncounterRow, offers: PersistentRageOffer[] = []): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  for (const combatant of listCombatants(db, encounter.id)) {
    if (!combatant.character_id || !combatant.alive) continue;
    const sheet = combatSheet(db, combatant.character_id);
    const rages = persistentRageOffer(sheet);
    if (rages > 0) {
      const fresh = getCombatant(db, encounter.id, combatant.id);
      fresh.flags = { ...fresh.flags, persistent_rage_offered: true };
      saveCombatant(db, fresh);
      const hint = `use_action {actor_id: ${combatant.id}, action_name: "persistent_rage_regain"} takes back all ${rages} expended uses of Rage, free of any action, until the end of ${combatant.name}'s first turn of this fight.`;
      offers.push({ combatant_id: combatant.id, name: combatant.name, rages, hint });
      entries.push(
        logCombat(db, encounter, {
          actor_id: combatant.id,
          kind: 'feature_note',
          payload: { feature: 'Persistent Rage', offered: true, rages },
          text: `${combatant.name} rolls Initiative and may take back every expended Rage (Persistent Rage): ${hint}`,
        }),
      );
    }
    for (const outcome of initiativeOutcomes(sheet, combatant)) {
      entries.push(...applyOutcome(db, encounter, combatant, sheet, outcome));
    }
  }
  return entries;
}

async function rollInitiative(
  db: Db,
  encounter: EncounterRow,
  surprised: Set<number> = new Set(),
  offers: PersistentRageOffer[] = [],
): Promise<CombatLogEntry[]> {
  const combatants = listCombatants(db, encounter.id);
  const rolled = [];
  for (const c of combatants) {
    const sheet = sheetOf(db, c);
    const bonus = initiativeBonus(c, sheet);
    const roll = await rollOwnInitiative(db, encounter, c, bonus, 'start_encounter', surprised.has(c.id));
    const dex = c.stat_block ? (c.stat_block.abilities.dex ?? 10) : (sheet?.abilities.dex?.score ?? 10);
    // Ties go through the engine's own dice like every other outcome, never another module's PRNG.
    // A wider die than the d20: on a tie the stable sort falls back to row id, and the party is
    // seated first, so a narrow die would hand the party every doubly-tied slot.
    const tiebreak = rollDice('1d100', { roll_type: 'other' });
    rolled.push({
      combatant: c,
      total: roll.total,
      output: roll.output,
      dex,
      tiebreak: tiebreak.total,
      tiebreak_output: tiebreak.output,
    });
  }
  rolled.sort((a, b) => b.total - a.total || b.dex - a.dex || b.tiebreak - a.tiebreak);
  const entries: CombatLogEntry[] = [];
  rolled.forEach((entry, index) => {
    entry.combatant.initiative = entry.total;
    entry.combatant.initiative_order = index;
    entry.combatant.movement_left = entry.combatant.speed;
    saveCombatant(db, entry.combatant);
    entries.push(
      logCombat(db, encounter, {
        actor_id: entry.combatant.id,
        kind: 'initiative',
        payload: {
          initiative: entry.total,
          order: index,
          roll: entry.output,
          tiebreak: entry.tiebreak_output,
          surprised: surprised.has(entry.combatant.id),
        },
        text: `${entry.combatant.name} rolls initiative ${entry.total} (${entry.output})${
          surprised.has(entry.combatant.id) ? ', surprised, so with disadvantage' : ''
        }.`,
      }),
    );
  });
  entries.push(...initiativeFeatures(db, encounter, offers));
  return entries;
}

export async function startEncounter(db: Db, input: StartEncounterInput) {
  const existing = db
    .prepare("SELECT id FROM encounter WHERE campaign_id = ? AND status = 'active'")
    .get(input.campaign_id) as { id: number } | undefined;
  if (existing) {
    throw new Error(`Encounter ${existing.id} is still active in this campaign. Call end_encounter before starting another.`);
  }
  // pcRow falls back to a dead or retired PC; only an active one can walk into a fight.
  const pc = pcRow(db, input.campaign_id);
  if (!pc || pc.status !== 'active') {
    throw new Error('No living player character in this campaign; create one before starting a fight.');
  }
  // A malformed override refuses the whole call here, before the encounter row exists.
  const enemyBlocks = input.enemies.map((spec) => {
    const block = statBlockFor(spec.creature);
    validateActionOverrides(spec.name ?? block.name, spec.actions ?? []);
    return block;
  });
  const seed = input.seed ?? randomSeed();
  const map = generateBattleMap(seed, { terrain: input.terrain, size: input.size, features: input.features });
  const scene = db.prepare('SELECT current_scene_id AS id FROM campaign WHERE id = ?').get(input.campaign_id) as
    | { id: number | null }
    | undefined;

  const encounterId = Number(
    db
      .prepare(
        'INSERT INTO encounter (campaign_id, scene_id, status, round, turn_index, seed, map_json, visibility, started_at) VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?)',
      )
      .run(
        input.campaign_id,
        scene?.id ?? null,
        'active',
        seed,
        JSON.stringify(map),
        // The player owns the fog of war: the encounter opens on whatever the campaign setting says now.
        getSettings(db, input.campaign_id).visibility,
        nowIso(),
      ).lastInsertRowid,
  );
  const encounter = refresh(db, encounterId);

  const surprised = new Set<number>();
  const caught = new Set(input.surprised_ids ?? []);
  const pcSheet = combatSheet(db, pc.id as number);
  const pcToken = addToEncounter(db, encounter, { kind: 'pc', name: pcSheet.name, team: 'party', sheet: pcSheet, preferX: 1 });
  if (caught.has(pcSheet.id)) surprised.add(pcToken.id);
  // Every active companion fights beside the PC; extra_party is for anyone else the DM brings in.
  const joining = new Set(party(db, input.campaign_id).companions.map((c) => c.id));
  for (const characterId of input.extra_party ?? []) if (characterId !== pc.id) joining.add(characterId);
  for (const characterId of joining) {
    const sheet = combatSheet(db, characterId);
    const token = addToEncounter(db, encounter, { kind: 'companion', name: sheet.name, team: 'party', sheet, preferX: 1 });
    if (caught.has(characterId)) surprised.add(token.id);
  }
  const enemies: CombatantPortraitTarget[] = [];
  for (const [index, spec] of input.enemies.entries()) {
    const block = applyActionOverrides(enemyBlocks[index]!, spec.actions ?? []);
    const count = spec.count ?? 1;
    for (let i = 0; i < count; i += 1) {
      const base = spec.name ?? block.name;
      const placed = addToEncounter(db, encounter, {
        kind: 'monster',
        name: count > 1 ? `${base} ${i + 1}` : base,
        team: 'enemy',
        statBlock: block,
        preferX: map.w - 2,
      });
      if (spec.surprised) surprised.add(placed.id);
      enemies.push({
        id: placed.id,
        name: placed.name,
        creature: block.name,
        description: creatureLook(block),
        unique: spec.unique,
      });
    }
  }
  scheduleCombatantPortraits(db, input.campaign_id, enemies);

  const persistentRage: PersistentRageOffer[] = [];
  const log = [
    logCombat(db, encounter, {
      kind: 'encounter_start',
      payload: { seed, terrain: input.terrain, size: input.size ?? 'medium', map: { w: map.w, h: map.h } },
      text: `Combat begins on a ${input.terrain} map (${map.w}x${map.h} cells, seed ${seed}).`,
    }),
    ...(await rollInitiative(db, encounter, surprised, persistentRage)),
  ];
  const first = activeCombatant(listCombatants(db, encounter.id), 0);
  if (first) {
    log.push(...(await tickEffects(db, encounter, first.id, 'start', undefined, 'start_encounter')));
    log.push(
      logCombat(db, encounter, {
        actor_id: first.id,
        kind: 'turn_start',
        payload: { round: 1, turn_index: 0 },
        text: `Round 1: ${first.name} acts first.`,
      }),
    );
  }
  return finish(db, encounter, 'start_encounter', `Encounter ${encounter.id} started.`, log, {
    encounter_id: encounter.id,
    seed,
    ...(persistentRage.length ? { persistent_rage_available: persistentRage } : {}),
  });
}

export async function addCombatant(db: Db, input: Parameters<typeof runAddCombatant>[1]) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'add_combatant', () => runAddCombatant(db, input));
}

async function runAddCombatant(
  db: Db,
  input: {
    campaign_id: number;
    creature?: string;
    character_id?: number;
    name?: string;
    team?: Team;
    x?: number;
    y?: number;
    unique?: boolean;
    actions?: StatBlockAction[];
  },
) {
  const encounter = requireEncounter(db, input.campaign_id);
  if (!input.creature && input.character_id === undefined) {
    throw new Error('Pass either creature (an SRD name) or character_id (a character row).');
  }
  const map = encounterMap(encounter);
  const sheet = input.character_id === undefined ? null : combatSheet(db, input.character_id);
  const block = input.creature ? statBlockFor(input.creature) : null;
  if (!block && input.actions?.length) {
    throw new Error("actions override a creature's stat block; a character fights from its sheet, so pass creature or drop actions.");
  }
  if (block) validateActionOverrides(input.name ?? block.name, input.actions ?? []);
  const statBlock = block ? applyActionOverrides(block, input.actions ?? []) : null;
  const team = input.team ?? (sheet ? 'party' : 'enemy');
  const combatant = addToEncounter(db, encounter, {
    kind: sheet ? (sheet.is_pc ? 'pc' : 'companion') : 'monster',
    name: input.name ?? sheet?.name ?? statBlock?.name ?? 'Combatant',
    team,
    statBlock,
    sheet,
    x: input.x,
    y: input.y,
    preferX: team === 'party' ? 1 : map.w - 2,
  });

  if (statBlock) {
    scheduleCombatantPortraits(db, input.campaign_id, [
      {
        id: combatant.id,
        name: combatant.name,
        creature: statBlock.name,
        description: creatureLook(statBlock),
        unique: input.unique,
      },
    ]);
  }

  const bonus = initiativeBonus(combatant, sheet);
  const roll = await rollOwnInitiative(db, encounter, combatant, bonus, 'add_combatant');
  combatant.initiative = roll.total;
  saveCombatant(db, combatant);
  reorderInitiative(db, encounter, combatant.id);

  const log = [
    logCombat(db, encounter, {
      actor_id: combatant.id,
      kind: 'join',
      payload: { name: combatant.name, team, initiative: roll.total, x: combatant.x, y: combatant.y },
      text: `${combatant.name} joins the fight at (${combatant.x},${combatant.y}) on initiative ${roll.total}.`,
    }),
  ];
  return finish(db, encounter, 'add_combatant', `${combatant.name} joins the fight.`, log, {
    combatant_id: combatant.id,
  });
}

/**
 * Slots a late arrival into the settled order: everyone already there keeps their relative order, and
 * the turn stays on whoever held it. turn_index still indexes the list as it stood before the arrival,
 * so that old order is the current one minus the newcomer.
 */
export function reorderInitiative(db: Db, encounter: EncounterRow, newId: number): void {
  const placed = listCombatants(db, encounter.id);
  const newcomer = placed.find((c) => c.id === newId);
  if (!newcomer) return;
  const others = placed.filter((c) => c.id !== newId);
  const current = activeCombatant(others, encounter.turn_index);
  const found = others.findIndex((c) => c.initiative < newcomer.initiative);
  const at = found < 0 ? others.length : found;
  const order = [...others.slice(0, at), newcomer, ...others.slice(at)];
  order.forEach((c, index) => {
    if (c.initiative_order === index) return;
    c.initiative_order = index;
    saveCombatant(db, c);
  });
  if (current) {
    const index = order.findIndex((c) => c.id === current.id);
    if (index >= 0) db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounter.id);
  }
}
