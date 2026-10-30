// The combat engine: initiative, movement, attacks, saves, damage, effects, turns and the fight log.
import {
  creatureLook,
  scheduleCombatantPortraits,
  type CombatantPortraitTarget,
} from '../core/auto-portraits.js';
import { logEvent, party, pcRow } from '../core/campaign.js';
import {
  createCompanion,
  deathSave as pcDeathSave,
  grantInspiration,
  grantInspirationDie,
  heldInspirationDie,
  restoreFeatureResource,
  restoreSpellSlot,
  setCondition as setPcCondition,
  setTempHp as setPcTempHp,
  slotsLeft,
  spendInspirationDie,
  useSpellSlot,
} from '../core/character.js';
import {
  expressionDice,
  randomSeed,
  rollDice,
  withoutLuckPool,
  type Advantage,
} from '../core/dice.js';
import { customSpellAction, findHomebrewSpell } from '../core/progression.js';
import { netAdvantage } from '../core/rolls.js';
import { getSettings } from '../core/settings.js';
import { abilityMod, type Ability } from '../core/rules.js';
import type { CreatureStatBlock, StatBlockAction } from '../srd/data.js';
import * as srd from '../srd/data.js';
import { findSpell, weaponMastery } from '../srd/lookup.js';
import type { Db } from '../db/connection.js';
import {
  actionsFor,
  findAction,
  gripDamage,
  hasProperty,
  initiativeBonus,
  shieldEquipped,
  isAttack,
  legalActions,
  weaponAbility,
  weaponOfAction,
  STANDARD_ACTIONS,
} from './actions.js';
import {
  conditionRule,
  exhaustionPenalty,
  isIncapacitated,
  rulesOf,
  speedZeroBy,
} from './conditions.js';
import {
  arcaneApotheosisFree,
  attackBonusOf,
  auraHalfCover,
  bardicDie,
  castModifiers,
  chosenOptions,
  classFeatures,
  critRangeOf,
  cunningStrikeCount,
  cunningStrikeOptions,
  CUNNING_STRIKE_COST,
  attackSources as featureAttackSources,
  defenceSources,
  allFeatureActionIds,
  featureActionIds,
  findFeatureAction,
  hasBoon,
  hasEvasion,
  hasFeature,
  hasInvocation,
  healRiders,
  heldInvocations,
  heldMetamagic,
  hitRiders,
  holyNimbusDamage,
  huntersMarkDie,
  initiativeOutcomes,
  irresistibleOffense,
  isRaging,
  isWildShaped,
  killOutcomes,
  metamagicCost,
  missRiders,
  mysticArcanumLevels,
  pactSlotLevel,
  persistentRageOffer,
  reactionOffers,
  resourceMax,
  resourceSpec,
  sacredWeaponBlessing,
  saveMitigation,
  saveSucceededOutcomes,
  damageTakenOutcomes,
  signatureKey,
  spellDamageRiders,
  STACKING_METAMAGIC,
  turnOutcomes,
  wildShapeRounds,
  type AttackOptions,
  type BrutalStrikeOption,
  type CastModifier,
  type CastOptions,
  type CunningStrikeOption,
  type RiderWindow,
  type FeatureAction,
  type FeatureCost,
  type FeatureHandler,
  type FeatureOutcome,
  type HitRider,
  type ReactionOffer,
  type RollSource,
  type SpellInfo,
} from './features.js';
import {
  aoeTargets,
  canStand,
  CELL_FT,
  distanceToPoint,
  coverBetween,
  COVER_ORDER,
  distanceBetween,
  hasLineOfSight,
  planMove,
  reachableCells,
  sizeCode,
  type AoeShape,
  type Cover,
  type Point,
  type SizeCode,
  type Token,
} from './grid.js';
import { logFor } from './log-view.js';
import { generateBattleMap, type BattleMap, type MapSize, type Terrain } from './map.js';
import {
  anchorMechanics,
  combatSheet,
  sheetAbilityMod,
  sheetSkillBonus,
  type CombatSheet,
} from './sheet.js';
import { boostsFor, type ClauseCtx } from './homebrew.js';

import { dropSnapshot, lastSnapshot, restoreSnapshot, underSnapshot } from './undo.js';
import {
  activeCombatant,
  activeEncounter,
  battleState,
  combatLog,
  encounterMap,
  getCombatant,
  insertCombatant,
  listCombatants,
  listEffects,
  logCombat,
  requireEncounter,
  saveCombatant,
  setCombatantStatBlock,
  type Combatant,
  type CombatFlags,
  type CombatLogEntry,
  type EncounterRow,
  type Effect,
  type Team,
} from './state.js';
import {
  ATTACK_HOOKS,
  CAST_HOOKS,
  spentSlotThisTurn,
  type PreRoll,
  type RollOutcome,
  signed,
  nowIso,
  partyHp,
  xpForCr,
  refresh,
  finish,
  sheetOf,
  auraSources,
  pcLuck,
  immuneTo,
  profBonusOf,
} from './engine-core.js';
import {
  requireTurn,
  attacksAllowed,
  requireEconomy,
  spendResource,
  requireReaction,
  reactionText,
  spendFeatureCost,
  spendChosenBoosts,
  requireSlot,
  requireSlotLevel,
  requireResource,
} from './resources.js';
import {
  rollHealing,
  maximumDamage,
  criticalExpr,
  rollDamage,
  greatWeaponBonus,
  damageLinesOf,
  damageTypeNote,
  type DamageResult,
} from './damage-math.js';
import {
  frighteners,
  charmedBy,
  d20Context,
  rollD20,
  askPlayer,
  saveBonus,
  type SaveResult,
  applyD20Stance,
  rollSave,
  rollCheck,
} from './d20.js';
import {
  characterOf,
  mirrorCharacter,
  isDowned,
  damageCombatant,
  refreshVitals,
  healCombatant,
  dropCondition,
} from './hp.js';
import {
  endConcentration,
  afterDamage,
  type EffectInput,
  endEffect,
  tickEffects,
  killEntry,
  attachEffect,
} from './effects.js';
export {
  type EffectInput,
  tickEffects,
  applyEffect,
  endEffectById,
  setCombatCondition,
} from './effects.js';
export { damageCombatant } from './hp.js';
export { type D20Context, type SaveResult } from './d20.js';
export { criticalExpr, type DamageResult } from './damage-math.js';
export { type PreRoll, type RollOutcome, xpForCr } from './engine-core.js';

/**
 * A creature reaching 0 hit points is something features key off: Dark One's Blessing pays whoever
 * struck the blow, and whoever was standing within 10 ft of it. Asked of every character on the field.
 */
function droppedToZero(db: Db, encounter: EncounterRow, victim: Combatant, killer: Combatant | null): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  for (const combatant of listCombatants(db, encounter.id)) {
    if (!combatant.character_id || !combatant.alive || combatant.hp_current === 0 || combatant.id === victim.id) continue;
    const sheet = combatSheet(db, combatant.character_id);
    const outcomes = killOutcomes(sheet, {
      actor: combatant,
      victim,
      distance_ft: distanceBetween(combatant, victim),
      by_me: killer?.id === combatant.id,
    });
    for (const outcome of outcomes) entries.push(...applyOutcome(db, encounter, combatant, sheet, outcome));
  }
  return entries;
}

/** The kill entry and everything a creature dropping to 0 hit points sets off. */
function afterKill(
  db: Db,
  encounter: EncounterRow,
  victim: Combatant,
  killer: Combatant | null,
  source: string,
): CombatLogEntry[] {
  return [killEntry(db, encounter, victim, source), ...droppedToZero(db, encounter, victim, killer)];
}

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

function addToEncounter(
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
async function rollOwnInitiative(
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
function reorderInitiative(db: Db, encounter: EncounterRow, newId: number): void {
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
function crowdedShot(db: Db, encounter: EncounterRow, attacker: Combatant): string | null {
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
const footprintSizes = (size: SizeCode): number => SIZE_ORDER.indexOf(size);

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
const reachOf = (db: Db, combatant: Combatant): number => {
  const melee = actionsFor(combatant, sheetOf(db, combatant)).filter((a) => a.kind === 'melee_weapon_attack');
  return Math.max(5, ...melee.map((a) => a.reach_ft ?? 5));
};

// --- 2024 weapon mastery ----------------------------------------------------

/** Cleave carries into a creature within 5 ft of the first target; Push shoves 10 ft and Slow costs 10. */
const CLEAVE_FT = 5;
const PUSH_FT = 10;
const SLOW_FT = 10;

/** What a mastery property did, as the attack result and the fight log carry it. */
export interface MasteryEffect {
  property: string;
  /** Graze: the damage a miss still deals, the attacker's ability modifier, with no roll. */
  damage?: DamageResult & { type: string | null };
  pushed_ft?: number;
  save?: SaveResult;
  prone?: boolean;
  sapped?: boolean;
  slowed_ft?: number;
  vex?: boolean;
  /** Cleave: the other creatures this swing may carry on into, by id. */
  cleave_targets?: number[];
}

/**
 * The mastery property this swing carries: the weapon's own, and only for an attacker whose sheet names
 * that weapon. A monster fights from a stat block and never has mastery.
 */
function masteryFor(sheet: CombatSheet | null, action: StatBlockAction): srd.WeaponPropertyData | null {
  const weapon = sheet ? weaponOfAction(action.name, sheet) : undefined;
  if (!sheet || !weapon) return null;
  const known = sheet.mastery_weapons.some((name) => name.trim().toLowerCase() === weapon.name.toLowerCase());
  return known ? weaponMastery(weapon.name) : null;
}

/** Cleave is one extra attack a turn, into a second creature beside the first: this is what refuses it. */
function requireCleave(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  fromId: number,
  mastery: srd.WeaponPropertyData | null,
  action: StatBlockAction,
): void {
  if (mastery?.index !== 'cleave') {
    throw new Error(
      `cleave_from follows a hit with a Cleave weapon ${attacker.name} has mastery with; ${action.name} is not one.`,
    );
  }
  if (attacker.flags.cleaved) {
    throw new Error(`${attacker.name} has already cleaved this turn: Cleave gives one extra attack per turn.`);
  }
  if (fromId === target.id) {
    throw new Error(
      'Cleave strikes a second creature: pass cleave_from as the first target and target_id as the other one.',
    );
  }
  const first = getCombatant(db, encounter.id, fromId);
  const ready = attacker.flags.cleave_ready;
  if (ready?.target_id !== fromId || ready.weapon !== action.name) {
    throw new Error(`no Cleave to follow up: hit ${first.name} with ${action.name} first this turn.`);
  }
  const gap = distanceBetween(first, target);
  if (gap > CLEAVE_FT) {
    throw new Error(
      `${target.name} is ${gap} ft from ${first.name}; Cleave only carries into a creature within ${CLEAVE_FT} ft of the first target.`,
    );
  }
}

/** Cleave's extra swing deals the weapon's damage without the ability modifier, unless that is negative. */
function withoutAbilityMod(dice: string, mod: number): string {
  if (mod <= 0) return dice;
  const match = /^(.*?)([+-]\d+)$/.exec(dice);
  if (!match) return dice;
  const flat = Number(match[2]) - mod;
  return flat === 0 ? match[1]! : `${match[1]}${signed(flat)}`;
}

/**
 * The 2024 mastery property, resolved after the swing: Graze pays out on a miss, the rest on a hit.
 * Nick is not here - it rides on two-weapon fighting, which the engine does not run yet.
 */
async function resolveMastery(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  input: {
    mastery: srd.WeaponPropertyData;
    action: StatBlockAction;
    ability_mod: number;
    damage_type: string | null;
    hit: boolean;
    /** Slow and Vex need a hit that dealt damage; Push, Sap and Topple ride on the hit alone. */
    damage_dealt: number;
    melee: boolean;
    reach_ft: number;
    no_push?: boolean;
  },
): Promise<{ effect: MasteryEffect; log: CombatLogEntry[] }> {
  const log: CombatLogEntry[] = [];
  const effect: MasteryEffect = { property: input.mastery.name };
  const note = (text: string, payload: Record<string, unknown> = {}): void => {
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'mastery',
        payload: { property: input.mastery.name, action: input.action.name, ...payload },
        text,
      }),
    );
  };

  if (input.mastery.index === 'graze') {
    const amount = Math.max(0, input.ability_mod);
    if (input.hit || amount === 0) return { effect, log };
    const source = `${attacker.name}'s ${input.action.name} (Graze)`;
    const result = damageCombatant(db, encounter, target, { amount, type: input.damage_type, source });
    effect.damage = { ...result, type: input.damage_type };
    note(
      `The blow grazes ${target.name} for ${result.applied} ${input.damage_type ?? ''} damage${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
      { damage: result },
    );
    log.push(...(await afterDamage(db, encounter, target, result.applied, 'attack')));
    if (result.dead) log.push(killEntry(db, encounter, target, source));
    else if (isDowned(db, encounter, target.id)) {
      log.push(
        logCombat(db, encounter, {
          target_id: target.id,
          kind: 'downed',
          payload: { name: target.name },
          text: `${target.name} drops to 0 HP and falls unconscious.`,
        }),
      );
    }
    return { effect, log };
  }
  if (!input.hit) return { effect, log };
  // Cleave springs from the hit itself; the rest need a creature still on its feet to land on.
  const standing = target.alive && target.hp_current > 0;
  if (input.mastery.index !== 'cleave' && !standing) return { effect, log };

  switch (input.mastery.index) {
    case 'push': {
      if (input.no_push || footprintSizes(target.size) > footprintSizes('L')) break;
      const pushed = pushToken(db, encounter, attacker, target, PUSH_FT);
      effect.pushed_ft = pushed;
      note(`${attacker.name} drives ${target.name} ${pushed} ft back to (${target.x},${target.y}).`, {
        pushed_ft: pushed,
        to: { x: target.x, y: target.y },
      });
      break;
    }
    case 'sap': {
      target.flags = { ...target.flags, sapped_by: { attacker_id: attacker.id } };
      saveCombatant(db, target);
      effect.sapped = true;
      note(`${target.name} is sapped: Disadvantage on its next attack roll before ${attacker.name}'s next turn.`, {
        sapped_by: attacker.id,
      });
      break;
    }
    case 'slow': {
      if (input.damage_dealt <= 0) break;
      // No stacking: a creature already slowed has the window pushed out, not another 10 ft taken off.
      const already = target.flags.slowed_by !== undefined;
      target.flags = { ...target.flags, slowed_by: { attacker_id: attacker.id, ft: SLOW_FT } };
      if (!already) target.movement_left = Math.max(0, target.movement_left - SLOW_FT);
      saveCombatant(db, target);
      effect.slowed_ft = SLOW_FT;
      note(`${target.name} is slowed: ${SLOW_FT} ft off its speed until ${attacker.name}'s next turn.`, {
        slowed_by: attacker.id,
        ft: SLOW_FT,
      });
      break;
    }
    case 'topple': {
      const dc = 8 + input.ability_mod + profBonusOf(db, attacker);
      const save = await rollSave(db, encounter, target, 'con', dc, { tool: 'attack' });
      effect.save = save;
      if (save.success) {
        note(`${target.name} keeps its feet (CON save ${save.total} vs DC ${dc}).`, { save, prone: false });
        break;
      }
      const immune = immuneTo(db, encounter, target, 'prone');
      if (immune) {
        note(`${immune} (CON save ${save.total} vs DC ${dc}).`, { save, prone: false });
        break;
      }
      const created = attachEffect(db, encounter, {
        target_id: target.id,
        source_id: attacker.id,
        name: 'prone',
        kind: 'condition',
        tick: 'end',
        ends: 'manual',
      });
      log.push(created.entry);
      effect.prone = true;
      target.conditions = getCombatant(db, encounter.id, target.id).conditions;
      note(`${target.name} is knocked Prone (CON save ${save.total} vs DC ${dc}).`, { save, prone: true });
      break;
    }
    case 'vex': {
      if (input.damage_dealt <= 0) break;
      // A Vex granted out of turn runs out at the end of the attacker's next turn, not this round's.
      const ownTurn = activeCombatant(listCombatants(db, encounter.id), encounter.turn_index)?.id === attacker.id;
      attacker.flags = {
        ...attacker.flags,
        vex_against: { target_id: target.id, round: encounter.round, ...(ownTurn ? { granted_in_own_turn: true } : {}) },
      };
      saveCombatant(db, attacker);
      effect.vex = true;
      note(`${attacker.name} has Advantage on its next attack against ${target.name}.`, { vex_against: target.id });
      break;
    }
    case 'cleave': {
      if (!input.melee || attacker.flags.cleaved) break;
      attacker.flags = { ...attacker.flags, cleave_ready: { target_id: target.id, weapon: input.action.name } };
      saveCombatant(db, attacker);
      const beside = listCombatants(db, encounter.id).filter(
        (c) =>
          c.id !== target.id &&
          c.id !== attacker.id &&
          c.alive &&
          c.hp_current > 0 &&
          distanceBetween(c, target) <= CLEAVE_FT &&
          distanceBetween(attacker, c) <= input.reach_ft,
      );
      if (beside.length === 0) break;
      effect.cleave_targets = beside.map((c) => c.id);
      note(
        `${attacker.name} may cleave on into ${beside.map((c) => `${c.name} (${c.id})`).join(' or ')}: attack {cleave_from: ${target.id}} swings again without spending another attack.`,
        { cleave_targets: effect.cleave_targets },
      );
      break;
    }
    default:
      break;
  }
  return { effect, log };
}

/**
 * Sap, Vex and Studied Attacks are spent on the one attack roll they moved, hit or miss: a weapon swing
 * or a spell. Studied Attacks buys "your next attack roll against that creature", and this is it.
 */
function spendSapVex(db: Db, attacker: Combatant, target: Combatant): void {
  const vexed = attacker.flags.vex_against?.target_id === target.id;
  const studied = attacker.flags.studied_target?.target_id === target.id;
  if (!attacker.flags.sapped_by && !vexed && !studied) return;
  attacker.flags = {
    ...attacker.flags,
    sapped_by: undefined,
    ...(vexed ? { vex_against: undefined } : {}),
    ...(studied ? { studied_target: undefined } : {}),
  };
  saveCombatant(db, attacker);
}

/** Sap and Slow last until the start of the attacker's next turn; Vex until the end of it. */
function expireMastery(db: Db, encounter: EncounterRow, actor: Combatant, when: 'start' | 'end'): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  const clear = (on: Combatant, flags: CombatFlags, text: string, payload: Record<string, unknown>): void => {
    on.flags = flags;
    saveCombatant(db, on);
    entries.push(logCombat(db, encounter, { actor_id: actor.id, target_id: on.id, kind: 'mastery_end', payload, text }));
  };
  if (when === 'end') {
    const vex = actor.flags.vex_against;
    // The Advantage lasts through the attacker's whole next turn: one granted on this turn survives it.
    if (vex && (vex.round < encounter.round || !vex.granted_in_own_turn)) {
      clear(actor, { ...actor.flags, vex_against: undefined }, `${actor.name} loses the Advantage Vex gave it.`, {
        property: 'Vex',
        target_id: vex.target_id,
      });
    }
    return entries;
  }
  for (const other of listCombatants(db, encounter.id)) {
    if (other.flags.sapped_by?.attacker_id === actor.id) {
      clear(other, { ...other.flags, sapped_by: undefined }, `${other.name} shakes off the Sap.`, { property: 'Sap' });
    }
    const slowed = other.flags.slowed_by;
    if (slowed?.attacker_id === actor.id) {
      const fresh = getCombatant(db, encounter.id, other.id);
      clear(fresh, { ...fresh.flags, slowed_by: undefined }, `${other.name} has its full speed back.`, {
        property: 'Slow',
        ft: slowed.ft,
      });
    }
  }
  return entries;
}

/** The why at the end of a reminder line: "Feature: what it says - why it is yours". */
const reasonOf = (line: string): string => {
  const cut = line.lastIndexOf(' - ');
  return cut < 0 ? line : line.slice(cut + 3);
};

/**
 * What a feature's outcome does to the creature it fired on, at the hooks that have no action of their
 * own: Initiative, the two turn edges and a kill. One applier for all three, so no hook quietly runs
 * less than another, and every line the outcome could not run is handed back as a reminder.
 */
function applyOutcome(
  db: Db,
  encounter: EncounterRow,
  who: Combatant,
  sheet: CombatSheet,
  outcome: FeatureOutcome,
): CombatLogEntry[] {
  let on = getCombatant(db, encounter.id, who.id);
  const inspirationAlreadyHeld =
    outcome.grant_inspiration && on.kind === 'pc' && pcRow(db, encounter.campaign_id)?.inspiration === 1;
  const hasOtherEffect =
    outcome.flags !== undefined ||
    outcome.movement_ft !== undefined ||
    outcome.heal_amount !== undefined ||
    outcome.heal_expr !== undefined ||
    outcome.temp_hp_amount !== undefined ||
    outcome.temp_hp_expr !== undefined ||
    outcome.remove_conditions !== undefined ||
    outcome.self_condition !== undefined ||
    outcome.restore_resource !== undefined ||
    outcome.standard !== undefined ||
    outcome.gain_slot !== undefined ||
    outcome.spend_slot !== undefined ||
    outcome.d20_stance !== undefined ||
    outcome.save !== undefined ||
    outcome.heals !== undefined ||
    outcome.target_flags !== undefined;
  // A held Heroic Inspiration makes its lone grant a no-op, but must not discard a mixed outcome.
  if (inspirationAlreadyHeld && !hasOtherEffect) return [];
  const what = outcome.feature ?? outcome.text;
  const log: CombatLogEntry[] = [];
  for (const cost of outcome.spend ? (Array.isArray(outcome.spend) ? outcome.spend : [outcome.spend]) : []) {
    log.push(spendFeatureCost(db, encounter, on, sheet, cost, what));
  }
  if (outcome.flags) {
    on.flags = { ...on.flags, ...outcome.flags };
    // One more action costs none of this turn's own, exactly as Action Surge is written.
    if (outcome.flags.action_surged) {
      on.action_used = false;
      on.flags = { ...on.flags, attacks_used: 0, surge_action_pending: true };
    }
    saveCombatant(db, on);
    who.flags = on.flags;
  }
  if (outcome.movement_ft) {
    on.movement_left += outcome.movement_ft;
    saveCombatant(db, on);
  }
  const healed = outcome.heal_amount ?? (outcome.heal_expr ? rollHealing(outcome.heal_expr, sheet).total : 0);
  if (healed > 0) {
    healCombatant(db, encounter, on, healed);
    on = getCombatant(db, encounter.id, on.id);
  }
  const temp = outcome.temp_hp_amount ?? (outcome.temp_hp_expr ? rollDamage(outcome.temp_hp_expr, false).total : null);
  if (temp !== null && on.character_id) {
    setPcTempHp(db, {
      campaign_id: encounter.campaign_id,
      character_id: on.character_id,
      amount: temp,
      mirror: false,
    });
    mirrorCharacter(db, on);
    saveCombatant(db, on);
  }
  for (const condition of outcome.remove_conditions ?? []) {
    if (!on.conditions.includes(condition)) continue;
    dropCondition(db, encounter, on, condition);
  }
  // A condition the feature leaves on its own holder, for the rounds its text gives it.
  if (outcome.self_condition) {
    const created = attachEffect(db, encounter, {
      name: outcome.self_condition.name,
      kind: 'condition',
      source_id: on.id,
      tick: 'end',
      ends: 'rounds',
      remaining_rounds: outcome.self_condition.rounds,
      target_id: on.id,
    });
    on.conditions = getCombatant(db, encounter.id, on.id).conditions;
    log.push(created.entry, ...created.landed);
  }
  if (outcome.restore_resource && on.character_id) {
    restoreFeatureResource(db, {
      campaign_id: encounter.campaign_id,
      character_id: on.character_id,
      resource: outcome.restore_resource.key,
      amount: outcome.restore_resource.amount,
    });
  }
  if (outcome.grant_inspiration && !inspirationAlreadyHeld && on.kind === 'pc') {
    grantInspiration(db, { campaign_id: encounter.campaign_id, character_id: on.character_id ?? undefined });
  }
  log.push(
    logCombat(db, encounter, {
      actor_id: on.id,
      kind: 'feature_note',
      payload: {
        feature: outcome.text,
        ...(temp === null ? {} : { temp_hp: temp }),
        ...(outcome.restore_resource ? { resource: outcome.restore_resource } : {}),
      },
      text: outcome.text,
    }),
  );
  // What the clause said and the engine could not run: a fight-log line, never the player's feed.
  for (const line of outcome.notes ?? []) {
    log.push(
      logCombat(db, encounter, {
        actor_id: on.id,
        kind: 'reminder',
        payload: { feature: outcome.feature ?? '', reason: reasonOf(line) },
        text: line,
      }),
    );
  }
  refreshVitals(db, encounter, who);
  return log;
}

/** The clauses a hook could not run, gathered off what it applied, for the reply the DM reads. */
function remindersOf(applied: Array<Record<string, unknown>>): Array<{ feature: string; text: string; reason: string }> {
  return applied
    .filter((one) => typeof one.reminder === 'string')
    .map((one) => ({ feature: String(one.feature), text: String(one.note ?? ''), reason: String(one.reminder) }));
}

/**
 * The effect row for a rider window, which is a question of whose turn edge closes it. "Until the end of
 * its next turn" runs off the target's own turn, which tickEffects already counts down. The two "your
 * next turn" windows run off the source's, and expireSourceRiders counts those: such a row waits on
 * ends 'manual' with the source turn edges still to pass left in remaining_rounds, and tick saying which
 * edge. A rider laid on the source's own turn has this turn's end to get past before the next one's.
 */
function riderWindow(ends: RiderWindow): Pick<EffectInput, 'tick' | 'ends' | 'remaining_rounds'> {
  switch (ends) {
    case 'end_of_its_next_turn':
      return { tick: 'end', ends: 'rounds', remaining_rounds: 1 };
    case 'start_of_your_next_turn':
      return { tick: 'start', ends: 'manual', remaining_rounds: 1 };
    case 'end_of_your_next_turn':
      return { tick: 'end', ends: 'manual', remaining_rounds: 2 };
    case 'minute':
      return { tick: 'end', ends: 'rounds', remaining_rounds: 10 };
    default:
      return { tick: 'end', ends: 'manual' };
  }
}

/** How long a rider's condition stays on, in the effect row's own words. */
function riderEnds(rider: Extract<HitRider, { kind: 'save' }>, attacker: Combatant): Omit<EffectInput, 'target_id'> {
  const base = { name: rider.condition, kind: 'condition' as const, source_id: attacker.id };
  if (rider.ends === 'minute') {
    return { ...base, tick: 'end', ends: 'save', save_ability: rider.ability, save_dc: rider.dc, remaining_rounds: 10 };
  }
  return { ...base, ...riderWindow(rider.ends) };
}

/**
 * The riders whose window the SRD keys to their source's turn rather than their target's: Stunning
 * Strike's Stunned to the start of the Monk's next turn, Hurl Through Hell's Incapacitated to the end of
 * the Warlock's. Each source turn edge takes one off the count riderWindow left on the row.
 */
function expireSourceRiders(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  when: 'start' | 'end',
): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  for (const effect of listEffects(db, encounter.id)) {
    if (effect.source_id !== actor.id || effect.ends !== 'manual' || effect.remaining_rounds === null) continue;
    if (effect.tick !== when) continue;
    const remaining = effect.remaining_rounds - 1;
    db.prepare('UPDATE effect SET remaining_rounds = ? WHERE id = ?').run(remaining, effect.id);
    if (remaining > 0) continue;
    const target = getCombatant(db, encounter.id, effect.target_id);
    endEffect(db, encounter, effect);
    entries.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'effect_end',
        payload: { effect_id: effect.id, name: effect.name },
        text: `${effect.name} ends on ${target.name}: ${actor.name}'s turn ${when === 'start' ? 'begins' : 'ends'}.`,
      }),
    );
  }
  return entries;
}

/** A rolled rider, kept whole so a stance can come off the attack's total before any of it lands. */
type RiderRoll = { total: number; expr: string; output: string };

/** A flat negative damage rider, the only kind that folds into the damage instead of landing on its own. */
function flatRider(rider: HitRider): number | null {
  if (rider.kind !== 'damage' || !/^-?\d+$/.test(rider.dice)) return null;
  const value = Number(rider.dice);
  return value < 0 ? value : null;
}

/**
 * Every damage rider rolled ahead of the blow, keyed by the rider it belongs to. When the player rolls
 * their own damage each rider's dice go on their own card exactly as spell damage does, and a card left
 * to time out still comes back as a server roll.
 */
async function rollRiderDamage(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  riders: HitRider[],
  critical: boolean,
  tool: string,
): Promise<Map<HitRider, RiderRoll>> {
  const rolled = new Map<HitRider, RiderRoll>();
  for (const rider of riders) {
    if (rider.kind !== 'damage') continue;
    const flat = flatRider(rider);
    if (flat !== null) {
      // A negative flat rider is never rolled or offered to the player: it folds into the damage parts.
      rolled.set(rider, { total: flat, expr: rider.dice, output: rider.dice });
      continue;
    }
    const expr = critical ? criticalExpr(rider.dice) : rider.dice;
    const pre = await askPlayer(db, encounter, attacker, 'damage', {
      tool,
      expr,
      purpose: `Damage: ${expr}${rider.damage_type ? ` (${rider.damage_type})` : ''}`,
      roll_type: 'damage',
      target_id: target.id,
    });
    rolled.set(rider, rollDamage(rider.dice, critical, pre));
  }
  return rolled;
}

/**
 * A negative flat rider folds into the damage instance instead of landing as a part of its own: its
 * magnitude comes off the part of the same type first, then the others in order, no part below 0.
 * Returns the lines logged and the riders folded away, which the caller must not apply again but must
 * still charge for.
 */
function foldNegativeRiders(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  parts: Array<{ type: string | null; amount: number }>,
  riderRolls: Map<HitRider, RiderRoll>,
): { log: CombatLogEntry[]; folded: Set<HitRider> } {
  const log: CombatLogEntry[] = [];
  const folded = new Set<HitRider>();
  for (const [rider, rolled] of riderRolls) {
    if (rider.kind !== 'damage' || rolled.total >= 0) continue;
    const requested = -rolled.total;
    const order = [
      ...parts.filter((part) => part.type === rider.damage_type),
      ...parts.filter((part) => part.type !== rider.damage_type),
    ];
    let left = requested;
    const changes: string[] = [];
    for (const part of order) {
      if (left <= 0) break;
      const before = part.amount;
      const off = Math.min(left, before);
      part.amount = before - off;
      left -= off;
      if (off > 0) changes.push(`${before} ${part.type ?? 'untyped'} becomes ${part.amount}`);
    }
    folded.add(rider);
    riderRolls.delete(rider);
    const removed = requested - left;
    const payload = { feature: rider.feature, folded: removed, ...(removed !== requested ? { requested } : {}) };
    const note = rider.note.trimEnd().replace(/\.$/, '');
    // A miss carries no part to reduce: say the rider fired rather than let it vanish.
    if (order.length === 0) {
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_note',
          payload,
          text: `${note}: nothing to reduce.`,
        }),
      );
      continue;
    }
    // Nothing could come off (the part was already 0): name it rather than let the rider vanish.
    if (changes.length === 0) changes.push(`0 ${order[0]!.type ?? 'untyped'} becomes 0`);
    // "(floored)" only when part of the rider is still left over once every part has hit 0.
    if (left > 0) changes[changes.length - 1] += ' (floored)';
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'feature_note',
        payload,
        text: `${note}, ${changes.join(', ')}.`,
      }),
    );
  }
  return { log, folded };
}

/**
 * When a half-on-save, Evasion or Potent Cantrip reduces a spell's roll, a positive rider of the spell's
 * own type folds into the damage before that reduction, and one of another type is reduced on its own.
 * Returns the lines logged and the riders folded away, which the caller must still charge for.
 */
function foldPositiveRidersForHalving(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  parts: Array<{ type: string | null; amount: number }>,
  riderRolls: Map<HitRider, RiderRoll>,
  damageType: string | null,
  /** The clause that says why the roll is reduced, printed where "the save" used to be assumed. */
  reduced: string,
  /** True when Evasion takes a successful save to nothing, so another type's rider becomes 0 too. */
  takesNothing: boolean,
): { log: CombatLogEntry[]; folded: Set<HitRider> } {
  const log: CombatLogEntry[] = [];
  const folded = new Set<HitRider>();
  for (const [rider, rolled] of riderRolls) {
    if (rider.kind !== 'damage' || rolled.total <= 0) continue;
    const note = rider.note.trimEnd().replace(/\.$/, '');
    if (rider.damage_type != null && rider.damage_type !== damageType) {
      const after = takesNothing ? 0 : Math.floor(rolled.total / 2);
      // The odd point this rider's own floor loses is carried into the spell's part, so the instance
      // halves once in total: floor((base + sum(rider)) / 2) === floor((base + sum(odd)) / 2) + sum(floor(rider / 2)).
      const carried = takesNothing ? 0 : rolled.total % 2;
      if (carried > 0) parts[0]!.amount += carried;
      riderRolls.set(rider, { ...rolled, total: after });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_note',
          payload: { feature: rider.feature, halved: rolled.total, to: after, ...(carried > 0 ? { carried: 1 } : {}) },
          text:
            carried > 0
              ? `${note}: ${rolled.total} ${rider.damage_type} becomes ${after} because ${reduced}, its odd point carried into the ${damageType ?? 'untyped'} roll before the halving.`
              : `${note}: ${rolled.total} ${rider.damage_type} becomes ${after} because ${reduced}.`,
        }),
      );
      continue;
    }
    parts[0]!.amount += rolled.total;
    folded.add(rider);
    riderRolls.delete(rider);
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'feature_note',
        payload: { feature: rider.feature, folded: rolled.total },
        text: `${rider.feature}: +${rolled.total} ${damageType ?? 'untyped'} folded into the roll before ${reduced}.`,
      }),
    );
  }
  return { log, folded };
}

/** Everything a feature adds to a hit, resolved in the order the registry returned it. */
async function applyHitRiders(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  sheet: CombatSheet,
  riders: HitRider[],
  rolls: Map<HitRider, RiderRoll>,
  critical: boolean,
  /** True when the caller sums this rider damage with the rest of the hit and makes one concentration save. */
  deferAfterDamage = false,
): Promise<{ log: CombatLogEntry[]; applied: Array<Record<string, unknown>>; damage: number }> {
  const log: CombatLogEntry[] = [];
  const applied: Array<Record<string, unknown>> = [];
  let damageDealt = 0;
  // A creature that already dropped takes no more riders, and one line names what the blow left unspent.
  const suppressed: string[] = [];
  for (const rider of riders) {
    if (!target.alive) {
      suppressed.push(rider.feature);
      continue;
    }
    if (rider.spend) log.push(spendFeatureCost(db, encounter, attacker, sheet, rider.spend, rider.feature));
    // A rider that burns a spell slot: Eldritch Smite, and nothing else.
    if (rider.spend_slot !== undefined && attacker.character_id) {
      const spent = useSpellSlot(db, {
        campaign_id: encounter.campaign_id,
        character_id: attacker.character_id,
        level: rider.spend_slot,
      });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          kind: 'spell_slot',
          payload: { feature: rider.feature, level: rider.spend_slot, remaining: spent.remaining },
          text: `${attacker.name} spends a level ${rider.spend_slot} Pact Magic slot on ${rider.feature} (${spent.remaining} left).`,
        }),
      );
    }
    if (rider.kind === 'condition') {
      const immune = immuneTo(db, encounter, target, rider.condition);
      if (immune) {
        log.push(
          logCombat(db, encounter, {
            actor_id: attacker.id,
            target_id: target.id,
            kind: 'note',
            payload: { condition: rider.condition, immune: true },
            text: `${immune} ${rider.feature} leaves no ${rider.condition} on it.`,
          }),
        );
        continue;
      }
      const created = attachEffect(db, encounter, {
        name: rider.condition,
        kind: 'condition',
        source_id: attacker.id,
        // "for N rounds" counts its own rounds; every other window is a turn edge the engine knows.
        ...(rider.rounds === undefined
          ? riderWindow(rider.ends)
          : { tick: 'end' as const, ends: 'rounds' as const, remaining_rounds: rider.rounds }),
        target_id: target.id,
      });
      target.conditions = getCombatant(db, encounter.id, target.id).conditions;
      applied.push({ feature: rider.feature, condition: rider.condition, applied: true });
      log.push(created.entry, ...created.landed);
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_note',
          payload: { feature: rider.feature, condition: rider.condition },
          text: rider.note,
        }),
      );
      continue;
    }
    if (rider.kind === 'temp_hp') {
      if (attacker.character_id) {
        setPcTempHp(db, {
          campaign_id: encounter.campaign_id,
          character_id: attacker.character_id,
          amount: rider.amount,
          mirror: false,
        });
        mirrorCharacter(db, attacker);
        saveCombatant(db, attacker);
      }
      applied.push({ feature: rider.feature, temp_hp: rider.amount });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          kind: 'temp_hp',
          payload: { feature: rider.feature, amount: rider.amount },
          text: rider.note,
        }),
      );
      continue;
    }
    if (rider.kind === 'damage') {
      const rolled = rolls.get(rider) ?? rollDamage(rider.dice, critical);
      const boon = irresistibleOffense(sheet);
      const physical = ['bludgeoning', 'piercing', 'slashing'].includes((rider.damage_type ?? '').toLowerCase());
      const result = damageCombatant(db, encounter, target, {
        amount: rolled.total,
        type: rider.damage_type,
        source: `${attacker.name}'s ${rider.feature}`,
        critical,
        ...(boon && physical ? { ignore_resistance: true } : {}),
      });
      applied.push({
        feature: rider.feature,
        damage: result.applied,
        expr: rolled.expr,
        type: rider.damage_type,
        note: rider.note,
      });
      damageDealt += result.applied;
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_damage',
          payload: { feature: rider.feature, ...result, type: rider.damage_type, expr: rolled.expr },
          text: `${rider.note} ${target.name} takes ${result.applied} more (${rolled.output})${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      if (!deferAfterDamage) log.push(...(await afterDamage(db, encounter, target, result.applied, 'attack')));
      if (result.dead) log.push(...afterKill(db, encounter, target, attacker, `${attacker.name}'s ${rider.feature}`));
      else if (!deferAfterDamage && isDowned(db, encounter, target.id)) log.push(...droppedToZero(db, encounter, target, attacker));
      continue;
    }
    if (rider.kind === 'save') {
      const immune = immuneTo(db, encounter, target, rider.condition);
      const save = await rollSave(db, encounter, target, rider.ability, rider.dc, { tool: 'attack' });
      applied.push({ feature: rider.feature, save, condition: rider.condition, applied: !save.success && !immune });
      if (save.success || immune) {
        log.push(
          logCombat(db, encounter, {
            actor_id: attacker.id,
            target_id: target.id,
            kind: 'feature_save',
            payload: { feature: rider.feature, save, applied: false },
            text: immune
              ? `${immune} (${rider.ability.toUpperCase()} save ${save.total} vs DC ${rider.dc}.)`
              : `${target.name} shrugs off ${rider.feature} (${rider.ability.toUpperCase()} save ${save.total} vs DC ${rider.dc})${
                  rider.on_success ? `: ${rider.on_success}` : ''
                }.`,
          }),
        );
        continue;
      }
      // A failed save that also hurts: Hurl Through Hell's 8d10, which a Fiend does not feel.
      if (rider.damage) {
        const spared = rider.damage.unless_type
          ? new RegExp(rider.damage.unless_type, 'i').test(target.stat_block?.type ?? '')
          : false;
        if (spared) {
          log.push(
            logCombat(db, encounter, {
              actor_id: attacker.id,
              target_id: target.id,
              kind: 'note',
              payload: { feature: rider.feature, spared: rider.damage.unless_type },
              text: `${target.name} is ${rider.damage.unless_type} and takes no ${rider.damage.type} damage from ${rider.feature}.`,
            }),
          );
        } else {
          const rolled = rollDamage(rider.damage.expr, false);
          const result = damageCombatant(db, encounter, target, {
            amount: rolled.total,
            type: rider.damage.type,
            source: `${attacker.name}'s ${rider.feature}`,
          });
          applied.push({ feature: rider.feature, damage: result.applied, expr: rolled.expr, type: rider.damage.type });
          damageDealt += result.applied;
          log.push(
            logCombat(db, encounter, {
              actor_id: attacker.id,
              target_id: target.id,
              kind: 'feature_damage',
              payload: { feature: rider.feature, ...result, type: rider.damage.type, expr: rolled.expr },
              text: `${target.name} takes ${result.applied} ${rider.damage.type} damage (${rolled.output})${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
            }),
          );
          if (!deferAfterDamage) log.push(...(await afterDamage(db, encounter, target, result.applied, 'attack')));
          if (result.dead) log.push(...afterKill(db, encounter, target, attacker, `${attacker.name}'s ${rider.feature}`));
          else if (!deferAfterDamage && isDowned(db, encounter, target.id)) log.push(...droppedToZero(db, encounter, target, attacker));
        }
      }
      const created = attachEffect(db, encounter, { ...riderEnds(rider, attacker), target_id: target.id });
      target.conditions = getCombatant(db, encounter.id, target.id).conditions;
      log.push(created.entry, ...created.landed);
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_save',
          payload: { feature: rider.feature, save, applied: true, condition: rider.condition },
          text: `${rider.note} ${target.name} fails (${rider.ability.toUpperCase()} save ${save.total} vs DC ${rider.dc}) and is ${rider.condition}.`,
        }),
      );
      continue;
    }
    if (rider.kind === 'stance') {
      const on = rider.on === 'self' ? attacker : getCombatant(db, encounter.id, target.id);
      // "You can have only one creature under the effect of this feature at a time": the new one replaces it.
      const dropped = rider.flags.quivering_palm ? clearOtherPalms(db, encounter, attacker, on) : null;
      // Divine Smite's dice double on a critical hit, so the armed flag remembers the hit's criticality.
      const flags = rider.flags.smite_ready
        ? { ...rider.flags, smite_ready: { ...rider.flags.smite_ready, critical } }
        : rider.flags;
      on.flags = { ...on.flags, ...flags };
      saveCombatant(db, on);
      if (rider.on === 'target') target.flags = on.flags;
      applied.push({ feature: rider.feature, stance: flags, ...(dropped ? { replaced: dropped.name } : {}) });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: rider.on === 'target' ? target.id : null,
          kind: 'feature_note',
          payload: { feature: rider.feature, flags, ...(dropped ? { replaced: dropped.name } : {}) },
          text: dropped
            ? `${rider.note} The vibrations leave ${dropped.name}: only one creature carries them at a time.`
            : rider.note,
        }),
      );
      continue;
    }
    if (rider.kind === 'push') {
      const moved = pushToken(db, encounter, attacker, target, rider.ft);
      applied.push({ feature: rider.feature, pushed_ft: moved });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_note',
          payload: { feature: rider.feature, pushed_ft: moved },
          text: `${rider.note} ${target.name} lands at (${target.x},${target.y}), ${moved} ft back.`,
        }),
      );
      continue;
    }
    if (rider.kind === 'move') {
      attacker.movement_left += rider.ft;
      saveCombatant(db, attacker);
      applied.push({ feature: rider.feature, movement_ft: rider.ft });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          kind: 'feature_note',
          payload: { feature: rider.feature, movement_ft: rider.ft },
          text: `${rider.note} ${attacker.name} has ${attacker.movement_left} ft of movement.`,
        }),
      );
      continue;
    }
    applied.push({ feature: rider.feature, note: rider.note, ...(rider.reminder ? { reminder: rider.reminder } : {}) });
    log.push(
      logCombat(db, encounter, {
        // A reminder is a fight-log line and nothing else: it never reaches the player's story feed.
        kind: rider.reminder ? 'reminder' : 'feature_note',
        actor_id: attacker.id,
        target_id: target.id,
        payload: { feature: rider.feature, ...(rider.reminder ? { reason: rider.reminder } : {}) },
        text: rider.note,
      }),
    );
  }
  // The dead take no riders: name what was left unspent so the DM can read the blow for what it was.
  if (suppressed.length > 0) {
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'note',
        payload: { already_down: target.name, suppressed },
        text: `${suppressed.join(', ')} ${suppressed.length === 1 ? 'is' : 'are'} not applied: ${target.name} already dropped.`,
      }),
    );
  }
  return { log, applied, damage: damageDealt };
}

/** Quivering Palm takes its vibrations off whoever carried them before, so one Monk sets only one. */
function clearOtherPalms(db: Db, encounter: EncounterRow, monk: Combatant, keeping: Combatant): Combatant | null {
  for (const other of listCombatants(db, encounter.id)) {
    if (other.id === keeping.id || other.flags.quivering_palm?.monk_id !== monk.id) continue;
    other.flags = { ...other.flags, quivering_palm: undefined };
    saveCombatant(db, other);
    return other;
  }
  return null;
}

/** Uncanny Dodge and Deflect Attacks, both declared before the blow: what they take off it. */
function mitigateHit(
  db: Db,
  encounter: EncounterRow,
  target: Combatant,
  damageType: string | null,
): { halve: boolean; reduce: number; log: CombatLogEntry[] } | null {
  const sheet = sheetOf(db, target);
  if (!sheet) return null;
  const physical = ['bludgeoning', 'piercing', 'slashing'];
  const deflects =
    target.flags.deflect_ready === true &&
    (damageType === null || physical.includes(damageType.toLowerCase()) || hasFeature(sheet, 'monk-deflect-energy'));
  const dodges = target.flags.uncanny_dodge_ready === true;
  // Superior Hunter's Defense: Resistance to this blow, and to that type for the rest of the turn.
  const braced = target.flags.hunters_defense_ready === true;
  if (!deflects && !dodges && !braced) return null;
  const log: CombatLogEntry[] = [];
  let reduce = 0;
  if (deflects) {
    const rolled = rollDamage(`1d10+${sheetAbilityMod(sheet, 'dex') + sheet.level}`, false);
    reduce = rolled.total;
    log.push(
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'feature_note',
        payload: { feature: 'Deflect Attacks', reduce },
        text: `${target.name} deflects the blow: ${reduce} off the damage (${rolled.output}).`,
      }),
    );
  }
  if (dodges) {
    log.push(
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'feature_note',
        payload: { feature: 'Uncanny Dodge' },
        text: `${target.name} rolls with it: Uncanny Dodge halves the damage.`,
      }),
    );
  }
  if (braced) {
    log.push(
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'feature_note',
        payload: { feature: "Superior Hunter's Defense", damage_type: damageType },
        text: `${target.name} takes the blow head on: Resistance to ${
          damageType ?? 'that damage'
        } now and for the rest of the turn (Superior Hunter's Defense).`,
      }),
    );
  }
  const fresh = getCombatant(db, encounter.id, target.id);
  fresh.flags = {
    ...fresh.flags,
    deflect_ready: undefined,
    uncanny_dodge_ready: undefined,
    hunters_defense_ready: undefined,
    ...(braced && damageType ? { resisting: { type: damageType.toLowerCase(), rounds_left: 1 } } : {}),
  };
  saveCombatant(db, fresh);
  target.flags = fresh.flags;
  return { halve: dodges || braced, reduce, log };
}

const CUTTING_WORDS_FT = 60;

/**
 * Cutting Words, declared ahead of the roll it spoils: the Bardic Inspiration die a bard within 60 ft
 * already spent comes off this attack roll, and the declaration goes with it.
 */
function cuttingWords(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  combatants: Combatant[],
): { amount: number; note: string; log: CombatLogEntry[] } | null {
  const bard = combatants.find(
    (c) =>
      c.flags.cutting_words_ready !== undefined &&
      c.team !== attacker.team &&
      c.alive &&
      c.hp_current > 0 &&
      distanceBetween(c, attacker) <= CUTTING_WORDS_FT,
  );
  if (!bard) return null;
  const rolled = rollDamage(`1d${bard.flags.cutting_words_ready!.die}`, false);
  const fresh = getCombatant(db, encounter.id, bard.id);
  fresh.flags = { ...fresh.flags, cutting_words_ready: undefined };
  saveCombatant(db, fresh);
  return {
    amount: rolled.total,
    note: `Cutting Words from ${bard.name}: -${rolled.total}`,
    log: [
      logCombat(db, encounter, {
        actor_id: bard.id,
        target_id: attacker.id,
        kind: 'feature_note',
        payload: { feature: 'Cutting Words', amount: rolled.total },
        text: `${bard.name} cuts ${attacker.name} down with a word: ${rolled.total} off the attack roll (${rolled.output}).`,
      }),
    ],
  };
}

/** The bards who may still spoil this attacker's next roll, as offers on the result of this one. */
function cuttingWordsOffers(db: Db, encounter: EncounterRow, attacker: Combatant): ReactionOffer[] {
  const out: ReactionOffer[] = [];
  for (const combatant of listCombatants(db, encounter.id)) {
    if (!combatant.character_id || combatant.team === attacker.team) continue;
    if (!combatant.alive || combatant.hp_current === 0 || combatant.reaction_used) continue;
    if (combatant.flags.cutting_words_ready || distanceBetween(combatant, attacker) > CUTTING_WORDS_FT) continue;
    const sheet = combatSheet(db, combatant.character_id);
    if (!hasFeature(sheet, 'lore-cutting-words')) continue;
    const left = resourceSpec(sheet, 'bardic_inspiration');
    const row = sheet.features.find((f) => f.mechanics?.resource === 'bardic_inspiration');
    if ((left?.max ?? 0) - (row?.mechanics?.used ?? 0) <= 0) continue;
    out.push({
      action: 'cutting_words',
      name: 'Cutting Words',
      hint: `${combatant.name} may spend their reaction and a use of Bardic Inspiration to take a d${bardicDie(
        sheet,
      )} off ${attacker.name}'s next attack roll: use_action {actor_id: ${combatant.id}, action_name: "cutting_words", out_of_turn: true, reason: "Cutting Words"}.`,
    });
  }
  return out;
}

/** Rage lasts until the end of your next turn, and attacking or forcing a save pushes that out again. */
function extendRage(db: Db, encounter: EncounterRow, actor: Combatant): void {
  const raging = actor.flags.raging;
  if (!raging || raging.extended_round >= encounter.round) return;
  actor.flags = { ...actor.flags, raging: { ...raging, extended_round: encounter.round } };
  saveCombatant(db, actor);
}

/** Hunter's Mark: the spell rides on every weapon hit its caster lands on the marked creature. */
function huntersMarkRider(
  effects: Effect[],
  attacker: Combatant,
  target: Combatant,
  sheet: CombatSheet,
): HitRider | null {
  const mark = effects.find(
    (e) => e.active && e.target_id === target.id && e.source_id === attacker.id && /hunter.s mark/i.test(e.name),
  );
  if (!mark) return null;
  const die = huntersMarkDie(sheet);
  return {
    kind: 'damage',
    feature: "Hunter's Mark",
    dice: `1d${die}`,
    damage_type: 'force',
    note: `Hunter's Mark: 1d${die} force damage to ${target.name}.`,
  };
}

/** The mastery property Tactical Master swings instead of the weapon's own. */
const swappedMastery = (index: 'push' | 'sap' | 'slow'): srd.WeaponPropertyData | undefined =>
  srd.weaponMasteryProperties().find((property) => property.index === index);

/**
 * The options a player put on one attack, refused before anything is written: a feature the character
 * does not have, a resource with nothing left, a Flurry strike that was never bought.
 */
function requireAttackOptions(
  sheet: CombatSheet,
  attacker: Combatant,
  action: StatBlockAction,
  options: AttackOptions,
  masteryProperty: 'push' | 'sap' | 'slow' | undefined,
  heldDie: number | null,
): void {
  const missing = (what: string, feature: string): never => {
    throw new Error(`${attacker.name} has no ${feature}, so ${what} is not an option on this attack.`);
  };
  if (options.reckless && !hasFeature(sheet, 'barbarian-reckless-attack')) missing('reckless', 'Reckless Attack');
  if (options.brutal_strike) {
    if (!hasFeature(sheet, 'barbarian-brutal-strike')) missing('brutal_strike', 'Brutal Strike');
    if (!attacker.flags.reckless && !options.reckless) {
      throw new Error(
        'Brutal Strike is bought by giving up the Advantage of Reckless Attack: pass reckless true on the same attack.',
      );
    }
  }
  if (options.brutal_strike) {
    const chosen = Array.isArray(options.brutal_strike) ? options.brutal_strike : [options.brutal_strike];
    const improved = hasFeature(sheet, 'barbarian-improved-brutal-strike-1');
    const newer = chosen.filter((option) => option === 'staggering' || option === 'sundering');
    if (newer.length > 0 && !improved) {
      throw new Error(
        `${newer.join(' and ')} comes with Improved Brutal Strike at Barbarian level 13; ${attacker.name} has Forceful Blow ("forceful") and Hamstring Blow ("hamstring").`,
      );
    }
    const allowed = hasFeature(sheet, 'barbarian-improved-brutal-strike-2') ? 2 : 1;
    if (chosen.length > allowed) {
      throw new Error(
        `Brutal Strike carries ${allowed} effect${allowed === 1 ? '' : 's'} at this level, and ${chosen.length} were named. Two of them need Improved Brutal Strike at level 17.`,
      );
    }
    if (new Set(chosen).size !== chosen.length) {
      throw new Error('Improved Brutal Strike uses two different effects, not the same one twice.');
    }
  }
  if (options.cunning_strike?.length) {
    if (!hasFeature(sheet, 'rogue-cunning-strike')) missing('cunning_strike', 'Cunning Strike');
    const legal = cunningStrikeOptions(sheet);
    const unknown = options.cunning_strike.filter((effect) => !legal.includes(effect));
    if (unknown.length > 0) {
      throw new Error(
        `${attacker.name} has no Cunning Strike effect called ${unknown.join(' or ')}. They may use: ${legal
          .map((effect) => `${effect} (${CUNNING_STRIKE_COST[effect]}d6)`)
          .join(', ')}.`,
      );
    }
    const most = cunningStrikeCount(sheet);
    if (options.cunning_strike.length > most) {
      throw new Error(
        `Cunning Strike carries ${most} effect${most === 1 ? '' : 's'} on one Sneak Attack at this level; Improved Cunning Strike at level 11 makes it two.`,
      );
    }
    const dice = resourceMax(sheet, 'sneak_attack_dice');
    const cost = options.cunning_strike.reduce((sum, effect) => sum + CUNNING_STRIKE_COST[effect], 0);
    if (cost > dice - 1) {
      throw new Error(
        `Those effects cost ${cost}d6 of a ${dice}d6 Sneak Attack, and at least one die has to be left to deal damage with.`,
      );
    }
  }
  if (options.quivering_palm) {
    if (!hasFeature(sheet, 'open-hand-quivering-palm')) missing('quivering_palm', 'Quivering Palm');
    if (!/unarmed strike/i.test(action.name)) {
      throw new Error(`Quivering Palm rides on an Unarmed Strike, and ${action.name} is not one.`);
    }
    if (attacker.flags.quivering_palm_used) {
      throw new Error(`${attacker.name} has already set their Quivering Palm this turn.`);
    }
    requireResource(sheet, attacker, { resource: 'focus_points', amount: 4 }, 'Quivering Palm');
  }
  if (options.hurl_through_hell) {
    if (!hasFeature(sheet, 'fiend-patron-hurl-through-hell')) missing('hurl_through_hell', 'Hurl Through Hell');
    if (attacker.flags.hurl_through_hell_used) {
      throw new Error(`${attacker.name} has already used Hurl Through Hell this turn; it is once per turn.`);
    }
    // The use a long rest, or the Pact Magic slot that buys it back when the use is gone.
    const spec = resourceSpec(sheet, 'hurl_through_hell');
    const row = sheet.features.find((entry) => entry.mechanics?.resource === 'hurl_through_hell');
    const left = (spec?.max ?? 0) - (row?.mechanics?.used ?? 0);
    if (left <= 0) {
      const slot = pactSlotLevel(sheet);
      if (slot <= 0) throw new Error(`${attacker.name} has no Pact Magic slot to buy Hurl Through Hell back with.`);
      requireSlot(sheet, attacker, slot, 'Hurl Through Hell');
    }
  }
  if (options.empowered_strike && !hasFeature(sheet, 'monk-empowered-strikes')) {
    missing('empowered_strike', 'Empowered Strikes');
  }
  if (options.stunning_strike) {
    if (!hasFeature(sheet, 'monk-stunning-strike')) missing('stunning_strike', 'Stunning Strike');
    if (attacker.flags.stunning_strike_used) {
      throw new Error(`${attacker.name} has already tried a Stunning Strike this turn; it is once per turn.`);
    }
    requireResource(sheet, attacker, { resource: 'focus_points', amount: 1 }, 'a Stunning Strike');
  }
  if (options.flurry) {
    if ((attacker.flags.flurry_strikes ?? 0) <= 0) {
      throw new Error(
        `${attacker.name} has no Flurry of Blows strikes left: take the bonus action first with use_action {action_name: "flurry_of_blows"}.`,
      );
    }
    if (!/unarmed strike/i.test(action.name)) {
      throw new Error(`Flurry of Blows throws Unarmed Strikes; ${action.name} is not one.`);
    }
  }
  if (options.sacred_weapon) {
    if (!hasFeature(sheet, 'devotion-sacred-weapon')) missing('sacred_weapon', 'Sacred Weapon');
    if (action.kind !== 'melee_weapon_attack') {
      throw new Error(`Sacred Weapon blesses a Melee weapon, and ${action.name} is not one.`);
    }
    requireResource(sheet, attacker, { resource: 'channel_divinity', amount: 1 }, 'Sacred Weapon');
  }
  if (masteryProperty && !hasFeature(sheet, 'fighter-tactical-master')) {
    missing('mastery_property', 'Tactical Master');
  }
  if (options.eldritch_smite) {
    if (!hasInvocation(sheet, 'Eldritch Smite')) missing('eldritch_smite', 'Eldritch Smite invocation');
    if (!hasInvocation(sheet, 'Pact of the Blade')) {
      throw new Error('Eldritch Smite rides on a pact weapon, and Pact of the Blade is the invocation that makes one.');
    }
    if (attacker.flags.eldritch_smite_used) {
      throw new Error(`${attacker.name} has already used Eldritch Smite this turn; it is once per turn.`);
    }
    const slot = pactSlotLevel(sheet);
    if (slot <= 0) throw new Error(`${attacker.name} has no Pact Magic slots to spend on Eldritch Smite.`);
    requireSlot(sheet, attacker, slot, 'Eldritch Smite');
  }
  if (options.inspiration && heldDie === null) {
    throw new Error(
      `${attacker.name} is holding no Bardic Inspiration die. A Bard hands one out with use_action {action_name: "bardic_inspiration", target_id}.`,
    );
  }
  if (options.peerless_aim) {
    if (!hasBoon(sheet, 'Boon of Combat Prowess')) missing('peerless_aim', 'Boon of Combat Prowess');
    if (attacker.flags.peerless_aim_used) {
      throw new Error(
        `${attacker.name} has already used Peerless Aim; it comes back at the start of their next turn.`,
      );
    }
  }
}

// --- attacks ----------------------------------------------------------------

export async function attack(db: Db, input: Parameters<typeof runAttack>[1]) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'attack', () => runAttack(db, input));
}

async function runAttack(
  db: Db,
  input: {
    campaign_id: number;
    attacker_id: number;
    target_id: number;
    action_name: string;
    advantage?: Advantage;
    roll?: PreRoll;
    /** A versatile weapon swings two-handed unless a shield says otherwise; one_hand takes the smaller die. */
    grip?: 'one_hand' | 'two_hands';
    /** Pull the blow: a melee hit that would drop the target leaves it unconscious and stable instead. */
    knock_out?: boolean;
    /** Cleave: the creature just hit, whose neighbour this swing carries on into, free of the Attack action. */
    cleave_from?: number;
    /** Push: leave the target where it stands instead of driving it 10 ft back. */
    no_push?: boolean;
    /** Barbarian: attack recklessly, for Advantage on Strength attacks and Advantage on attacks against you. */
    reckless?: boolean;
    /** Rogue: false keeps the turn's one Sneak Attack back for a better swing. */
    sneak_attack?: boolean;
    /** Monk: spend a Focus Point on this hit to try to stun. */
    stunning_strike?: boolean;
    /** Barbarian 9: give up the Advantage on this swing for the dice and a Brutal Strike effect. */
    brutal_strike?: BrutalStrikeOption | BrutalStrikeOption[];
    /** Rogue 5: Sneak Attack dice traded for these effects, at the die cost each one lists. */
    cunning_strike?: CunningStrikeOption[];
    /** Monk 17: spend 4 Focus Points on this Unarmed Strike to set Quivering Palm going. */
    quivering_palm?: boolean;
    /** Warlock 14: try to hurl the creature this hit lands on through the Lower Planes. */
    hurl_through_hell?: boolean;
    /** Ranger 11: the second creature within 30 ft of the marked one the mark's damage jumps to. */
    prey_target_id?: number;
    /** Monk 6: this Unarmed Strike deals Force damage instead of its own type. */
    empowered_strike?: boolean;
    /** Monk 2: one of the Unarmed Strikes a Flurry of Blows bought, free of the Attack action. */
    flurry?: boolean;
    /** Paladin 3: spend a Channel Divinity to bless this weapon before the swing (Sacred Weapon). */
    sacred_weapon?: boolean;
    /** Warlock: spend a Pact Magic slot on this pact-weapon hit (Eldritch Smite). */
    eldritch_smite?: boolean;
    /** Add the Bardic Inspiration die this attacker is holding, if the roll would otherwise miss. */
    inspiration?: boolean;
    /** Boon of Combat Prowess: turn this attack into a hit if it misses, once until your next turn starts. */
    peerless_aim?: boolean;
    /** Homebrew clauses the roller chose for this swing, by their boost id; each is spent before the roll. */
    boosts?: string[];
    /** Fighter 9: swing this weapon with Push, Sap or Slow instead of its own mastery property. */
    mastery_property?: 'push' | 'sap' | 'slow';
    out_of_turn?: boolean;
    reason?: string;
  },
) {
  const encounter = requireEncounter(db, input.campaign_id);
  const attacker = getCombatant(db, encounter.id, input.attacker_id);
  const target = getCombatant(db, encounter.id, input.target_id);
  if (!attacker.alive || attacker.hp_current === 0) throw new Error(`${attacker.name} is down and cannot attack.`);
  if (!target.alive) throw new Error(`${target.name} is already dead.`);
  requireTurn(db, encounter, attacker, input.out_of_turn);
  const reaction = requireReaction(attacker, input.out_of_turn, input.reason);

  refuseIfIncapacitated(attacker);
  if (charmedBy(db, encounter, attacker, target)) {
    throw new Error(
      `${attacker.name} is charmed by ${target.name} and cannot attack them; end the Charmed condition first with effect {op: end} or condition{op: set, active: false}.`,
    );
  }
  if (standardId(input.action_name)) {
    throw new Error(
      `"${input.action_name}" is a standard action, not a weapon: resolve it with use_action {actor_id, action_name: "${standardId(input.action_name)}"}.`,
    );
  }
  const sheet = sheetOf(db, attacker);
  const action = findAction(attacker, sheet, input.action_name);
  if (!isAttack(action)) {
    throw new Error(`"${action.name}" is not an attack. Use use_action for spells, areas and abilities.`);
  }
  const swings = attacksAllowed(attacker, sheet);
  const melee = action.kind === 'melee_weapon_attack';
  const options: AttackOptions = {
    ...(input.reckless === undefined ? {} : { reckless: input.reckless }),
    ...(input.sneak_attack === undefined ? {} : { sneak_attack: input.sneak_attack }),
    ...(input.stunning_strike === undefined ? {} : { stunning_strike: input.stunning_strike }),
    ...(input.brutal_strike === undefined ? {} : { brutal_strike: input.brutal_strike }),
    ...(input.cunning_strike === undefined ? {} : { cunning_strike: input.cunning_strike }),
    ...(input.quivering_palm === undefined ? {} : { quivering_palm: input.quivering_palm }),
    ...(input.hurl_through_hell === undefined ? {} : { hurl_through_hell: input.hurl_through_hell }),
    ...(input.empowered_strike === undefined ? {} : { empowered_strike: input.empowered_strike }),
    ...(input.flurry === undefined ? {} : { flurry: input.flurry }),
    ...(input.sacred_weapon === undefined ? {} : { sacred_weapon: input.sacred_weapon }),
    ...(input.eldritch_smite === undefined ? {} : { eldritch_smite: input.eldritch_smite }),
    ...(input.inspiration === undefined ? {} : { inspiration: input.inspiration }),
    ...(input.peerless_aim === undefined ? {} : { peerless_aim: input.peerless_aim }),
  };
  // The Bardic Inspiration die this attacker is holding, if any: it is read before anything is written.
  const heldDie =
    sheet && attacker.character_id ? heldInspirationDie(db, encounter.campaign_id, attacker.character_id) : null;
  if (sheet) requireAttackOptions(sheet, attacker, action, options, input.mastery_property, heldDie);
  // Cleave's extra swing is part of the attack that earned it: it spends no action and no attack of one.
  const cleaving = input.cleave_from !== undefined;
  // A Flurry of Blows strike is paid for by the Focus Point already spent on the bonus action.
  const free = cleaving || input.flurry === true;
  if (!input.out_of_turn && !free) {
    requireEconomy(attacker, action.kind === 'bonus_action' ? 'bonus' : 'action', action.name, swings);
  }
  // "When you take the Attack action": Sacred Weapon rides on one of that action's own attacks.
  if (input.sacred_weapon && (free || input.out_of_turn || action.kind === 'bonus_action')) {
    throw new Error(
      'Sacred Weapon is taken when you take the Attack action: not on a bonus action, a Flurry strike, a cleave or a swing out of turn.',
    );
  }
  const blessing: CombatLogEntry[] = [
    ...spendChosenBoosts(db, encounter, attacker, sheet, input.boosts, { kind: 'attack', target, melee }),
  ];
  if (input.sacred_weapon && sheet) {
    const blessed = sacredWeaponBlessing(sheet, action.name);
    blessing.push(
      spendFeatureCost(db, encounter, attacker, sheet, { resource: 'channel_divinity', amount: 1 }, 'Sacred Weapon'),
    );
    attacker.flags = { ...attacker.flags, sacred_weapon: blessed };
    saveCombatant(db, attacker);
    blessing.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        kind: 'feature_note',
        payload: { feature: 'Sacred Weapon', ...blessed },
        text: `${attacker.name} sanctifies ${action.name}: +${blessed.bonus} to attack rolls with it for 10 minutes, Radiant damage at will, and bright light in a 20 ft radius.`,
      }),
    );
  }
  // Reckless Attack is declared with the first swing and rides on every Strength attack until your next turn.
  if (input.reckless && !attacker.flags.reckless) {
    attacker.flags = { ...attacker.flags, reckless: true };
    saveCombatant(db, attacker);
  }
  if (input.knock_out && action.kind !== 'melee_weapon_attack') {
    throw new Error('knock_out needs a melee hit: a creature can only be knocked out by a blow within reach.');
  }
  const combatants = listCombatants(db, encounter.id);
  const map = encounterMap(encounter);
  const distance = distanceBetween(attacker, target);

  const extra: RollSource[] = [];
  const weapon = sheet ? weaponOfAction(action.name, sheet) : undefined;
  if (input.grip === 'two_hands' && sheet && shieldEquipped(sheet)) {
    throw new Error(`${attacker.name} has a shield in the other hand and cannot swing ${action.name} two-handed.`);
  }
  const own = masteryFor(sheet, action);
  // Tactical Master: a Fighter may swap the weapon's own mastery property for Push, Sap or Slow.
  const mastery = input.mastery_property ? (swappedMastery(input.mastery_property) ?? own) : own;
  if (cleaving) requireCleave(db, encounter, attacker, target, input.cleave_from!, own, action);
  // The ability behind the swing: Rage rides on it, Graze deals it, Topple saves against it.
  const ability = sheet ? weaponAbility(sheet, weapon) : 'str';
  const abilityMod = sheet ? sheetAbilityMod(sheet, ability) : 0;
  const parts = gripDamage(action, weapon, input.grip) ?? action.damage ?? [];
  const swung = cleaving ? parts.map((p) => ({ ...p, dice: withoutAbilityMod(p.dice, abilityMod) })) : parts;
  // Empowered Strikes: a Monk's Unarmed Strike may deal Force damage instead of its own type.
  const empowered =
    options.empowered_strike === true && sheet !== null && hasFeature(sheet, 'monk-empowered-strikes') && !weapon;
  const damageParts = empowered ? swung.map((p) => ({ ...p, type: 'force' })) : swung;
  // Heavy weapons need STR 13 in melee or DEX 13 at range, or they swing wild.
  if (sheet && hasProperty(weapon, 'heavy')) {
    const ability = action.kind === 'ranged_weapon_attack' ? 'dex' : 'str';
    const score = sheet.abilities[ability]?.score ?? 10;
    if (score < 13) {
      extra.push({ advantage: 'disadvantage', note: `${action.name} is heavy and ${attacker.name} has ${ability.toUpperCase()} ${score}` });
    }
  }
  if (action.kind === 'melee_weapon_attack') {
    const reach = action.reach_ft ?? 5;
    if (distance > reach) throw new Error(`${target.name} is ${distance} ft away, beyond the ${reach} ft reach of ${action.name}.`);
  } else {
    const crowded = crowdedShot(db, encounter, attacker);
    if (crowded) extra.push({ advantage: 'disadvantage', note: `${crowded}, so the shot is rushed` });
    const normal = action.range_ft ?? 30;
    const long = action.long_range_ft ?? normal;
    if (distance > long) throw new Error(`${target.name} is ${distance} ft away, beyond the ${long} ft long range of ${action.name}.`);
    // Long range imposes disadvantage, which cancels advantage instead of stacking with it.
    if (distance > normal) extra.push({ advantage: 'disadvantage', note: `${distance} ft is long range for ${action.name}` });
  }
  const effects = listEffects(db, encounter.id);
  if (sheet) {
    extra.push(
      ...featureAttackSources(sheet, {
        actor: attacker,
        target,
        action,
        weapon,
        ability,
        melee,
        distance_ft: distance,
        combatants,
        effects,
        options,
      }),
    );
  }
  // What the target's own features do to the roll: a raging Barbarian that attacked recklessly is easier to hit.
  const targetSheet = sheetOf(db, target);
  if (targetSheet) extra.push(...defenceSources(targetSheet, target));
  // The boosts this swing offers, worked out before the card goes out and again once it has been paid
  // for: the reply lists what is left, not what was on the table when the call started.
  const boostCtx: Omit<ClauseCtx, 'sheet'> = {
    kind: 'attack',
    target,
    melee,
    distance_ft: distance,
    source: weapon ? 'weapon' : 'unarmed',
    ...(sheet ? {} : {}),
  };
  const attackBoosts = sheet ? boostsFor(sheet, sheet.features, boostCtx, ATTACK_HOOKS) : [];
  const context = d20Context(db, encounter, attacker, {
    kind: 'attack',
    target,
    distance_ft: distance,
    advantage: input.advantage,
    extra,
  });
  let advantage = context.advantage;

  const cover = coverBetween(map, combatants, attacker, target);
  if (!cover.line_of_sight) {
    throw new Error(`${target.name} has total cover from ${attacker.name}: no line of sight, so move first.`);
  }
  // Smite of Protection: a paladin's aura lends Half Cover to whoever stands in it, cover or none.
  const auraCover = auraHalfCover(target, auraSources(db, encounter));
  const coverBonus = auraCover ? Math.max(cover.ac_bonus, 2) : cover.ac_bonus;
  const effectiveAc = target.ac + coverBonus;
  const blessed = sheet ? attackBonusOf(sheet, attacker, action, melee) : 0;
  // Sundering Blow: the Barbarian's last hit put +5 on the next attack roll anybody else makes.
  const sundering = target.flags.sundering_blow;
  const sundered = sundering && sundering.by_id !== attacker.id ? 5 : 0;
  // context.bonus is what a homebrew clause puts on the roll, the way a Fighting Style would.
  let bonus = (action.attack_bonus ?? 0) + context.penalty + blessed + sundered + context.bonus;
  const pre =
    input.roll ??
    (await askPlayer(db, encounter, attacker, 'attack', {
      tool: 'attack',
      expr: `1d20${signed(bonus)}`,
      purpose: `Attack: ${action.name}`,
      roll_type: 'attack',
      dc: effectiveAc,
      advantage,
      advantage_sources: context.advantage_sources,
      target_id: target.id,
      ...(attackBoosts.length ? { boosts_available: attackBoosts } : {}),
    }));
  // The player took a boost on their own card: it is spent here, inside this call's own snapshot.
  const cardBoosts = pre?.boosts_chosen?.length
    ? spendChosenBoosts(db, encounter, attacker, sheet, pre.boosts_chosen, boostCtx, ATTACK_HOOKS)
    : [];
  // The card was read after the context was worked out, so what it bought goes on the roll here: the
  // result and the log line carry the boosted Advantage and the boosted expression, not the old ones.
  const taken = attackBoosts.filter((one) => (pre?.boosts_chosen ?? []).includes(one.id) && !one.spend_on_fire);
  // A boost's Advantage is a source like any other, so it joins the list a later stance reroll re-nets.
  const advantageSources = [...context.advantage_sources];
  if (taken.some((one) => one.advantage)) {
    advantageSources.push('advantage');
    advantage = netAdvantage(advantageSources);
  }
  bonus += taken.reduce((sum, one) => sum + one.bonus, 0);
  const rolled = rollD20(
    bonus,
    { advantage, dc: effectiveAc, kind: 'attack', luck_bias: pcLuck(db, encounter, attacker) },
    pre,
  );
  // Cutting Words comes off the roll before it is read, and a Bardic Inspiration die goes on after:
  // the die is only rolled for a swing that would otherwise miss, and only spent when it turns one.
  const cut = cuttingWords(db, encounter, attacker, combatants);
  let total = rolled.total - (cut?.amount ?? 0);
  let inspired: { die: number; roll: number } | null = null;
  if (input.inspiration && heldDie !== null && rolled.natural !== 1 && total < effectiveAc) {
    const die = rollDamage(`1d${heldDie}`, false);
    if (total + die.total >= effectiveAc) {
      spendInspirationDie(db, encounter.campaign_id, attacker.character_id ?? undefined);
      inspired = { die: heldDie, roll: die.total };
      total += die.total;
    }
  }
  let natural = rolled.natural;
  let stanceNotes: string[] = [];
  if (natural !== 20 && total < effectiveAc) {
    const stance = await applyD20Stance(db, encounter, attacker, 'attack', rolled, {
      total,
      bonus,
      dc: effectiveAc,
      advantage,
      advantage_sources: advantageSources,
      tool: 'attack',
      purpose: action.name,
    });
    if (stance) {
      total = stance.total;
      natural = stance.natural;
      stanceNotes = stance.notes;
    }
  }
  let hit = natural === 20 || (natural !== 1 && total >= effectiveAc);
  // Boon of Combat Prowess: "you can hit instead" - asked for on the swing, and once until your next turn.
  let peerlessAim = false;
  if (!hit && input.peerless_aim) {
    hit = true;
    peerlessAim = true;
    attacker.flags = { ...attacker.flags, peerless_aim_used: true };
    saveCombatant(db, attacker);
  }
  if (sundered) {
    const fresh = getCombatant(db, encounter.id, target.id);
    fresh.flags = { ...fresh.flags, sundering_blow: undefined };
    saveCombatant(db, fresh);
    target.flags = fresh.flags;
  }
  // A hit on a paralyzed or unconscious target from within 5 ft is a critical hit.
  const helpless = distance <= 5 && rulesOf(target.conditions).some((r) => r.crit_within_5ft);
  // Improved Critical widens the range a natural die crits on; everyone else crits on a 20.
  const critRange = sheet ? critRangeOf(sheet) : 20;
  const critical = natural === 20 || (hit && natural !== null && natural >= critRange) || (hit && helpless);
  // Help is spent on the attack it was given for, and a hidden attacker gives itself away.
  const helped = attacker.flags.helped_by;
  if (helped && (helped.against_id === undefined || helped.against_id === target.id)) {
    attacker.flags = { ...attacker.flags, helped_by: undefined };
    saveCombatant(db, attacker);
  }
  spendSapVex(db, attacker, target);

  const swingNotes = [
    ...context.notes,
    ...(auraCover ? [auraCover] : []),
    ...(sundered ? ['Sundering Blow: +5 on this attack roll'] : []),
    ...(cut ? [cut.note] : []),
    ...(inspired ? [`Bardic Inspiration: +${inspired.roll} from the d${inspired.die} ${attacker.name} was holding`] : []),
    ...stanceNotes,
    ...(peerlessAim ? ['Boon of Combat Prowess: the miss is turned into a hit (Peerless Aim)'] : []),
  ];
  const log: CombatLogEntry[] = [
    ...cardBoosts,
    ...blessing,
    ...(cut ? cut.log : []),
    ...revealHidden(db, encounter, attacker, `attacks ${target.name}`),
    ...releaseReady(db, encounter, attacker, reaction),
    logCombat(db, encounter, {
      actor_id: attacker.id,
      target_id: target.id,
      kind: 'attack',
      payload: {
        action: action.name,
        roll: { ...rolled, total, natural },
        natural,
        advantage,
        target_ac: target.ac,
        effective_ac: effectiveAc,
        cover: cover.cover,
        hit,
        critical,
        distance_ft: distance,
        notes: swingNotes,
        ...(input.grip ? { grip: input.grip } : {}),
        ...(helpless && hit ? { auto_crit: true } : {}),
        ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
      },
      text: reactionText(
        reaction,
        `${attacker.name} attacks ${target.name} with ${action.name}: ${total} vs AC ${effectiveAc}${
          cover.cover === 'none' ? '' : ` (${cover.cover.replace('_', '-')} cover)`
        } - ${critical ? 'critical hit' : hit ? 'hit' : 'miss'}.${swingNotes.length ? ` (${swingNotes.join('; ')})` : ''}`,
      ),
    }),
  ];

  const damage: Array<DamageResult & { type: string | null; expr: string; output: string }> = [];
  // Colossus Slayer asks whether the target was already wounded, which means before this swing landed.
  const targetHpBefore = target.hp_current;

  // Every part of the swing is rolled before any of it lands. Uncanny Dodge halves the attack's damage
  // and Deflect Attacks reduces the attack's total damage, which means the riders too, so the total has
  // to exist first; what the stance takes off comes out of the parts in order, weapon damage before riders.
  const dealt: Array<{ type: string | null; amount: number; expr: string; output: string }> = [];
  if (hit) {
    for (const part of damageParts) {
      const damageExpr = critical ? criticalExpr(part.dice) : part.dice;
      const rolledDamage = rollDamage(
        part.dice,
        critical,
        await askPlayer(db, encounter, attacker, 'damage', {
          tool: 'attack',
          expr: damageExpr,
          purpose: `Damage: ${damageExpr}${part.type ? ` (${part.type})` : ''}`,
          roll_type: 'damage',
          target_id: target.id,
          ...(critical ? { dice_notes: [`Doubled on a critical hit: ${part.dice} becomes ${damageExpr}`] } : {}),
        }),
      );
      dealt.push({
        type: part.type,
        amount: rolledDamage.total + greatWeaponBonus(sheet, weapon, melee, input.grip, rolledDamage.dice),
        expr: rolledDamage.expr,
        output: rolledDamage.output,
      });
    }
  }

  // What the attacker's own features add: Sneak Attack, Rage Damage, Stunning Strike, a smite - and what
  // a miss still leaves behind, which nothing martial uses yet and R4b's Graze-like features will.
  const riderAsk = {
    actor: attacker,
    target,
    action,
    weapon,
    ability,
    melee,
    distance_ft: distance,
    combatants,
    effects,
    options,
    advantage,
    critical,
    damage_type: damageParts[0]?.type ?? null,
    target_hp_before: targetHpBefore,
    roll: { natural, total, dc: effectiveAc, success: hit },
  };
  const riders = sheet ? (hit ? hitRiders(sheet, riderAsk) : missRiders(sheet, riderAsk)) : [];
  let marked: Extract<HitRider, { kind: 'damage' }> | null = null;
  if (hit && sheet && weapon) {
    const rider = huntersMarkRider(effects, attacker, target, sheet);
    if (rider?.kind === 'damage') {
      marked = rider;
      riders.push(rider);
    }
  }
  const riderRolls = await rollRiderDamage(db, encounter, attacker, target, riders, critical, 'attack');
  // A negative flat rider comes off the parts it rides on before any of them lands, and is dropped from
  // what applyHitRiders will apply; a positive rider is unchanged.
  const foldedRiders = foldNegativeRiders(db, encounter, attacker, target, dealt, riderRolls);
  log.push(...foldedRiders.log);
  // A folded rider fired, so its use is still spent even though its damage never lands on its own.
  if (sheet) {
    for (const rider of foldedRiders.folded) {
      if (rider.spend) log.push(spendFeatureCost(db, encounter, attacker, sheet, rider.spend, rider.feature));
    }
  }
  const ridersToApply = riders.filter((rider) => !foldedRiders.folded.has(rider));

  // Uncanny Dodge and Deflect Attacks are declared ahead of the blow, and come off its whole damage.
  const mitigation = hit ? mitigateHit(db, encounter, target, damageParts[0]?.type ?? null) : null;
  let redirect: { attacker_id: number; within_ft: number } | null = null;
  if (mitigation) {
    log.push(...mitigation.log);
    const total =
      dealt.reduce((sum, part) => sum + part.amount, 0) +
      [...riderRolls.values()].reduce((sum, rolled) => sum + rolled.total, 0);
    const kept = Math.max(0, (mitigation.halve ? Math.floor(total / 2) : total) - mitigation.reduce);
    let loss = total - kept;
    for (const part of dealt) {
      const off = Math.min(loss, part.amount);
      part.amount -= off;
      loss -= off;
    }
    for (const [rider, rolled] of riderRolls) {
      const off = Math.min(loss, rolled.total);
      riderRolls.set(rider, { ...rolled, total: rolled.total - off });
      loss -= off;
    }
    // A Deflect Attacks that takes the blow to nothing may throw the force back for a Focus Point.
    if (mitigation.reduce > 0 && kept === 0) {
      // A melee attack is thrown back within 5 ft, a ranged one at anything within 60 ft.
      redirect = { attacker_id: attacker.id, within_ft: melee ? 5 : 60 };
      const braced = getCombatant(db, encounter.id, target.id);
      braced.flags = {
        ...braced.flags,
        deflect_redirect: { ...redirect, damage_type: damageParts[0]?.type ?? null },
      };
      saveCombatant(db, braced);
      target.flags = braced.flags;
    }
  }

  // Boon of Irresistible Offense: physical damage this character deals is never halved by Resistance.
  const irresistible = sheet ? irresistibleOffense(sheet) : null;
  const overcomes = (type: string | null): boolean =>
    irresistible !== null && type !== null && ['bludgeoning', 'piercing', 'slashing'].includes(type.toLowerCase());
  // Overwhelming Strike: a natural 20 also deals damage equal to the score the boon raised.
  if (hit && natural === 20 && irresistible && dealt.length > 0) {
    dealt.push({
      type: dealt[0]!.type,
      amount: irresistible.score,
      expr: String(irresistible.score),
      output: `${irresistible.score} (Overwhelming Strike, your ${irresistible.ability.toUpperCase()} score)`,
    });
  }
  // Every part of one hit and every rider it carries are one instance of damage, so they owe one
  // concentration save between them, against the damage they add up to.
  let instanceDamage = 0;
  for (const part of dealt) {
    // The dead are not killed twice: a blow with more than one part logs one kill, not one per part.
    const wasAlive = target.alive;
    const result = damageCombatant(db, encounter, target, {
      amount: part.amount,
      type: part.type,
      source: `${attacker.name}'s ${action.name}`,
      critical,
      ...(overcomes(part.type) ? { ignore_resistance: true } : {}),
      ...(input.knock_out ? { knock_out: true } : {}),
    });
    damage.push({ ...result, type: part.type, expr: part.expr, output: part.output });
    instanceDamage += result.applied;
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'damage',
        payload: { action: action.name, ...result, type: part.type, expr: part.expr },
        text: `${target.name} takes ${result.applied} ${part.type ?? ''} damage (${part.output}${
          result.resistance ? `, ${result.resistance}` : ''
        })${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
      }),
    );
    if (wasAlive && result.dead) log.push(...afterKill(db, encounter, target, attacker, `${attacker.name}'s ${action.name}`));
  }

  let featureEffects: Array<Record<string, unknown>> = [];
  if (sheet && ridersToApply.length > 0) {
    const resolved = await applyHitRiders(db, encounter, attacker, target, sheet, ridersToApply, riderRolls, critical, true);
    log.push(...resolved.log);
    featureEffects = resolved.applied;
    instanceDamage += resolved.damage;
  }
  // A miss that dealt nothing calls nothing: only a landed blow or damage a rider landed on a miss
  // owes the concentration save.
  if (hit || instanceDamage > 0) log.push(...(await afterDamage(db, encounter, target, instanceDamage, 'attack')));
  // Relentless Rage can stand a Barbarian back up inside afterDamage, so a drop to 0 is read from the
  // row as it now stands: a blow whose 0 HP was undone is no drop and triggers nothing keyed to one.
  if (targetHpBefore > 0 && isDowned(db, encounter, target.id)) {
    log.push(
      logCombat(db, encounter, {
        target_id: target.id,
        kind: 'downed',
        payload: { name: target.name },
        text: `${target.name} drops to 0 HP and falls unconscious.`,
      }),
      ...droppedToZero(db, encounter, target, attacker),
    );
  }

  // Superior Hunter's Prey: once a turn, the Hunter's Mark damage also lands on a creature beside the marked one.
  if (marked && sheet && hasFeature(sheet, 'hunter-superior-hunters-prey') && !attacker.flags.superior_prey_used) {
    const second = input.prey_target_id === undefined ? null : getCombatant(db, encounter.id, input.prey_target_id);
    if (second && second.id !== target.id) {
      const away = distanceBetween(target, second);
      if (away > 30) {
        throw new Error(
          `Superior Hunter's Prey reaches a creature within 30 ft of ${target.name}, and ${second.name} is ${away} ft away.`,
        );
      }
      const rolled = rollDamage(marked.dice, false);
      const result = damageCombatant(db, encounter, second, {
        amount: rolled.total,
        type: 'force',
        source: `${attacker.name}'s Superior Hunter's Prey`,
      });
      attacker.flags = { ...attacker.flags, superior_prey_used: true };
      saveCombatant(db, attacker);
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: second.id,
          kind: 'feature_damage',
          payload: { feature: "Superior Hunter's Prey", ...result, type: 'force', expr: rolled.expr },
          text: `Superior Hunter's Prey: the mark's power leaps to ${second.name} for ${result.applied} force damage (${rolled.output})${partyHp(second, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      log.push(...(await afterDamage(db, encounter, second, result.applied, 'attack')));
      if (result.dead) log.push(...afterKill(db, encounter, second, attacker, `${attacker.name}'s Superior Hunter's Prey`));
      else if (isDowned(db, encounter, second.id)) log.push(...droppedToZero(db, encounter, second, attacker));
    } else if (!second) {
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          kind: 'feature_note',
          payload: { feature: "Superior Hunter's Prey" },
          text: `Superior Hunter's Prey: the mark's extra damage may also land on a creature within 30 ft of ${target.name} - name it with attack {prey_target_id}.`,
        }),
      );
    }
  }

  // The cleave swing spends the turn's one cleave before mastery resolves, so it offers no second one.
  if (cleaving) attacker.flags = { ...attacker.flags, cleaved: true, cleave_ready: undefined };
  let masteryEffect: MasteryEffect | null = null;
  if (mastery) {
    const resolved = await resolveMastery(db, encounter, attacker, target, {
      mastery,
      action,
      ability_mod: abilityMod,
      damage_type: damageParts[0]?.type ?? null,
      hit,
      damage_dealt: damage.reduce((sum, d) => sum + d.applied, 0),
      melee,
      reach_ft: melee ? (action.reach_ft ?? 5) : 0,
      ...(input.no_push ? { no_push: true } : {}),
    });
    masteryEffect = resolved.effect;
    log.push(...resolved.log);
  }

  if (input.flurry) {
    attacker.flags = { ...attacker.flags, flurry_strikes: Math.max(0, (attacker.flags.flurry_strikes ?? 1) - 1) };
  }
  if (!free) {
    if (!input.out_of_turn && action.kind !== 'bonus_action') {
      attacker.flags = { ...attacker.flags, attacks_used: (attacker.flags.attacks_used ?? 0) + 1 };
    }
    spendResource(attacker, action.kind === 'bonus_action' ? 'bonus' : 'action', input.out_of_turn);
  }
  // An attack roll against an enemy is one of the three things that keep a Rage going another round.
  extendRage(db, encounter, attacker);
  // Dropping a creature may have paid the attacker in temporary hit points: keep what the row says.
  refreshVitals(db, encounter, attacker);
  saveCombatant(db, attacker);

  const after = getCombatant(db, encounter.id, target.id);
  const afterSheet = sheetOf(db, after);
  const damageTaken = damage.reduce((sum, d) => sum + d.applied, 0);
  const damageOutcomes = hit && afterSheet && after.alive && damageTaken > 0
    ? damageTakenOutcomes(afterSheet, {
        actor: after, attacker, damage: damageTaken, damage_type: damageParts[0]?.type ?? null, distance_ft: distance,
      })
    : [];
  for (const outcome of damageOutcomes) log.push(...applyOutcome(db, encounter, after, afterSheet!, outcome));
  // What is still on offer after everything this call spent; the sheet has followed every spend.
  const leftToSpend = sheet ? boostsFor(sheet, sheet.features, boostCtx, ATTACK_HOOKS) : [];
  // The reactions the one who was hit may still take; a stance is declared before the next blow lands.
  const reactions: ReactionOffer[] =
    hit && afterSheet && after.alive && after.hp_current > 0
      ? reactionOffers(afterSheet, {
          actor: after,
          attacker,
          damage: damage.reduce((sum, d) => sum + d.applied, 0),
          damage_type: damageParts[0]?.type ?? null,
          distance_ft: distance,
        })
      : [];
  // Cutting Words is taken by a bard watching, not by the one who was hit, so its offer is found here.
  reactions.push(...cuttingWordsOffers(db, encounter, attacker));
  return finish(db, encounter, 'attack', `${attacker.name} attacks ${target.name}.`, log, {
    attacker_id: attacker.id,
    target_id: target.id,
    action: action.name,
    roll: { ...rolled, total, natural },
    advantage,
    cover: cover.cover,
    effective_ac: effectiveAc,
    hit,
    critical,
    damage,
    notes: swingNotes,
    ...(cut ? { cutting_words: cut.amount } : {}),
    ...(inspired ? { bardic_inspiration_spent: inspired } : {}),
    ...(!inspired && heldDie !== null && !hit
      ? {
          bardic_inspiration_available: {
            die: heldDie,
            hint: `${attacker.name} is holding a d${heldDie} of Bardic Inspiration: pass inspiration true on the next attack and it is added when the swing would otherwise miss.`,
          },
        }
      : {}),
    attacks_used: attacker.flags.attacks_used ?? 0,
    attacks_per_action: swings,
    total_damage: damage.reduce((sum, d) => sum + d.applied, 0),
    target_hp: { current: after.hp_current, max: after.hp_max, alive: after.alive },
    ...(masteryEffect ? { mastery: masteryEffect } : {}),
    ...(masteryEffect?.cleave_targets ? { cleave_available: { targets: masteryEffect.cleave_targets } } : {}),
    ...(cleaving ? { cleave_from: input.cleave_from } : {}),
    ...(featureEffects.length ? { features: featureEffects } : {}),
    ...(remindersOf(featureEffects).length ? { reminders: remindersOf(featureEffects) } : {}),
    ...(leftToSpend.length ? { boosts_available: leftToSpend } : {}),
    ...(reactions.length ? { reactions_available: reactions } : {}),
    ...(attacker.flags.smite_ready ? { smite_ready: attacker.flags.smite_ready } : {}),
    ...(redirect
      ? {
          deflect_redirect_available: {
            ...redirect,
            hint: `${after.name} took the blow to 0 and may spend 1 Focus Point to throw the force back: use_action {action_name: "deflect_redirect", target_id, out_of_turn: true, reason: "Deflect Attacks"} before the next turn.`,
          },
        }
      : {}),
    ...(attacker.flags.flurry_strikes ? { flurry_strikes_left: attacker.flags.flurry_strikes } : {}),
    ...(sheet ? { class_features: classFeatures(sheet, attacker) } : {}),
    ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
  });
}

// --- the standard actions and the Unarmed Strike options ---------------------

/** Nothing at all happens on a turn a creature is incapacitated: no action, bonus action or reaction. */
function refuseIfIncapacitated(actor: Combatant): void {
  if (!isIncapacitated(actor.conditions)) return;
  const why = actor.conditions.filter((c) => conditionRule(c)?.incapacitated);
  throw new Error(
    `${actor.name} is ${why.join(' and ')} and takes no action, bonus action or reaction. End the condition first with condition{op: set, active: false} or effect {op: end}.`,
  );
}

const STANDARD_ALIASES: Record<string, string> = {
  stand_up: 'stand',
  escape: 'escape_grapple',
  escape_the_grapple: 'escape_grapple',
  'break_free': 'escape_grapple',
};

/** The standard action a name asks for, or null when it is a spell, a weapon or a stat-block action. */
function standardId(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const id = STANDARD_ALIASES[key] ?? key;
  return id in STANDARD_ACTIONS ? id : null;
}

/** Attacking, casting or making noise ends a Hide, and the Invisible it granted goes with it. */
function revealHidden(db: Db, encounter: EncounterRow, actor: Combatant, doing: string): CombatLogEntry[] {
  if (!actor.flags.hidden) return [];
  const hide = listEffects(db, encounter.id).find(
    (e) => e.kind === 'condition' && e.name === 'invisible' && e.target_id === actor.id && e.source_id === actor.id,
  );
  if (hide) endEffect(db, encounter, hide);
  const fresh = getCombatant(db, encounter.id, actor.id);
  fresh.flags = { ...fresh.flags, hidden: false };
  saveCombatant(db, fresh);
  actor.conditions = fresh.conditions;
  actor.flags = fresh.flags;
  return [
    logCombat(db, encounter, {
      actor_id: actor.id,
      kind: 'hide_end',
      payload: { reason: doing },
      text: `${actor.name} is seen again: ${doing}.`,
    }),
  ];
}

/** An out-of-turn action by a combatant holding a readied one is that readied action going off. */
function releaseReady(db: Db, encounter: EncounterRow, actor: Combatant, reaction: string | null): CombatLogEntry[] {
  const ready = actor.flags.ready;
  if (!reaction || !ready) return [];
  actor.flags = { ...actor.flags, ready: undefined };
  saveCombatant(db, actor);
  return [
    logCombat(db, encounter, {
      actor_id: actor.id,
      kind: 'ready_release',
      payload: { trigger: ready.trigger, action: ready.action },
      text: `${actor.name} releases the readied ${ready.action} (trigger: ${ready.trigger}).`,
    }),
  ];
}

const strModOf = (db: Db, combatant: Combatant): number => {
  const sheet = sheetOf(db, combatant);
  return sheet ? sheetAbilityMod(sheet, 'str') : abilityMod(combatant.stat_block?.abilities.str ?? 10);
};

/** 8 + STR modifier + proficiency bonus: the DC an Unarmed Strike's grapple or shove is saved against. */
const unarmedDc = (db: Db, combatant: Combatant): number => 8 + strModOf(db, combatant) + profBonusOf(db, combatant);

/** Pushes a token straight away from another, cell by cell, stopping at whatever blocks it. */
function pushToken(db: Db, encounter: EncounterRow, from: Combatant, target: Combatant, feet: number): number {
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

/** What a standard action answers with; the web reads these straight off the tool result. */
export interface StandardActionData {
  movement_left?: number;
  cost_ft?: number;
  disengaged?: boolean;
  dodging?: boolean;
  utilized?: boolean;
  ally_id?: number;
  against_id?: number;
  trigger?: string;
  readied_action?: string;
  hidden?: boolean;
  dc?: number;
  check?: { total: number; natural: number | null; bonus: number; success: boolean; advantage: Advantage; notes: string[] };
  effect_id?: number;
  grappler_id?: number;
  escaped?: boolean;
  target_id?: number;
  save?: SaveResult;
  applied?: boolean;
  escape_dc?: number;
  prone?: boolean;
  pushed_ft?: number;
  to?: Point;
  ruling?: string;
}

export interface StandardActionInput {
  target_id?: number;
  ally_target_id?: number;
  trigger?: string;
  readied_action?: string;
  shove_prone?: boolean;
  ruling?: { reason: string; push_ft?: number; advantage?: boolean };
  rolls?: Record<string, PreRoll>;
}

const SHOVE_FT = 5;
const HIDE_DC = 15;

/**
 * Grapple and Shove, the 2024 Unarmed Strike options: the target saves with the better of STR and DEX
 * against 8 + the attacker's STR modifier + its proficiency bonus.
 */
async function grappleOrShove(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  id: 'grapple' | 'shove',
  input: StandardActionInput,
): Promise<{ log: CombatLogEntry[]; data: StandardActionData }> {
  if (input.target_id === undefined) throw new Error(`${id} needs target_id: who ${actor.name} takes hold of.`);
  const target = getCombatant(db, encounter.id, input.target_id);
  const reach = reachOf(db, actor);
  const distance = distanceBetween(actor, target);
  if (distance > reach) {
    throw new Error(`${target.name} is ${distance} ft away, beyond ${actor.name}'s ${reach} ft reach; move closer first.`);
  }
  if (footprintSizes(target.size) - footprintSizes(actor.size) > 1) {
    throw new Error(`${target.name} is ${target.size} and more than one size larger than ${actor.name}: too big to ${id}.`);
  }
  const ruling = input.ruling?.reason.trim();
  if (input.ruling && !ruling) throw new Error('A DM ruling needs a reason: what the player did to earn it.');
  const dc = unarmedDc(db, actor);
  // The target picks the save it is better at, so the engine rolls the better of the two.
  const ability: Ability = saveBonus(db, target, 'dex') > saveBonus(db, target, 'str') ? 'dex' : 'str';
  const save = await rollSave(db, encounter, target, ability, dc, {
    ...(input.ruling?.advantage ? { advantage: 'disadvantage' as Advantage } : {}),
    roll: input.rolls?.[String(target.id)],
    tool: 'use_action',
  });
  const log: CombatLogEntry[] = [];
  const data: StandardActionData = { target_id: target.id, dc, save, ...(ruling ? { ruling } : {}) };

  if (save.success) {
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: id,
        payload: { ...data, applied: false },
        text: `${ruling ? `DM ruling: ${ruling}. ` : ''}${target.name} resists ${actor.name}'s ${id} (${ability.toUpperCase()} save ${save.total} vs DC ${dc}).`,
      }),
    );
    return { log, data: { ...data, applied: false } };
  }

  if (id === 'grapple') {
    const created = attachEffect(db, encounter, {
      target_id: target.id,
      source_id: actor.id,
      name: 'grappled',
      kind: 'condition',
      tick: 'end',
      ends: 'manual',
    });
    const held = getCombatant(db, encounter.id, target.id);
    held.flags = { ...held.flags, grappled_by: actor.id };
    held.movement_left = 0;
    saveCombatant(db, held);
    actor.flags = { ...actor.flags, grappling: [...(actor.flags.grappling ?? []), target.id] };
    log.push(created.entry);
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'grapple',
        payload: { ...data, applied: true, escape_dc: dc },
        text: `${actor.name} grapples ${target.name} (${ability.toUpperCase()} save ${save.total} vs DC ${dc}): speed 0 until it escapes with a DC ${dc} STR (Athletics) or DEX (Acrobatics) check.`,
      }),
    );
    return { log, data: { ...data, applied: true, escape_dc: dc, effect_id: created.effect.id } };
  }

  if (input.shove_prone) {
    const created = attachEffect(db, encounter, {
      target_id: target.id,
      source_id: actor.id,
      name: 'prone',
      kind: 'condition',
      tick: 'end',
      ends: 'manual',
    });
    log.push(created.entry);
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'shove',
        payload: { ...data, applied: true, prone: true },
        text: `${ruling ? `DM ruling: ${ruling}. ` : ''}${actor.name} shoves ${target.name} to the ground (${ability.toUpperCase()} save ${save.total} vs DC ${dc}).`,
      }),
    );
    return { log, data: { ...data, applied: true, prone: true } };
  }

  const wanted = input.ruling?.push_ft ?? SHOVE_FT;
  const pushed = pushToken(db, encounter, actor, target, wanted);
  log.push(
    logCombat(db, encounter, {
      actor_id: actor.id,
      target_id: target.id,
      kind: 'shove',
      payload: { ...data, applied: true, pushed_ft: pushed, to: { x: target.x, y: target.y } },
      text: `${ruling ? `DM ruling: ${ruling}. ` : ''}${actor.name} shoves ${target.name} ${pushed} ft back to (${target.x},${target.y}) (${ability.toUpperCase()} save ${save.total} vs DC ${dc}).`,
    }),
  );
  return { log, data: { ...data, applied: true, pushed_ft: pushed } };
}

/** Dash, Disengage, Dodge, Help, Hide, Ready, Utilize, standing up, grappling and escaping one. */
async function standardAction(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  id: string,
  input: StandardActionInput,
): Promise<{ log: CombatLogEntry[]; data: StandardActionData }> {
  const log: CombatLogEntry[] = [];
  let data: StandardActionData = {};
  const note = (text: string, payload: StandardActionData = {}): void => {
    log.push(
      logCombat(db, encounter, { actor_id: actor.id, kind: 'action', payload: { action: id, ...payload }, text }),
    );
  };

  switch (id) {
    case 'dash': {
      actor.movement_left += actor.speed;
      actor.flags = { ...actor.flags, dashed: true };
      data = { movement_left: actor.movement_left };
      note(`${actor.name} dashes: ${actor.speed} ft more, ${actor.movement_left} ft of movement left.`, data);
      break;
    }
    case 'disengage': {
      actor.flags = { ...actor.flags, disengaged: true };
      data = { disengaged: true };
      note(`${actor.name} disengages: leaving reach draws no opportunity attack for the rest of this turn.`, data);
      break;
    }
    case 'dodge': {
      const stuck = speedZeroBy(actor.conditions);
      if (stuck.length > 0) throw new Error(`${actor.name} is ${stuck.join(' and ')} at speed 0, so Dodge does nothing.`);
      actor.flags = { ...actor.flags, dodging: true };
      data = { dodging: true };
      note(`${actor.name} dodges: attacks against them have disadvantage and their DEX saves advantage until their next turn.`, data);
      break;
    }
    case 'help': {
      if (input.target_id === undefined) throw new Error('help needs target_id: the ally being helped.');
      const ally = getCombatant(db, encounter.id, input.target_id);
      if (!ally.alive) throw new Error(`${ally.name} is out of the fight and cannot be helped.`);
      let against: Combatant | null = null;
      if (input.ally_target_id !== undefined) {
        against = getCombatant(db, encounter.id, input.ally_target_id);
        const away = distanceBetween(actor, against);
        if (away > 5) {
          throw new Error(
            `Helping with an attack needs the enemy within 5 ft of ${actor.name}; ${against.name} is ${away} ft away. Help with a check instead by leaving ally_target_id out.`,
          );
        }
      }
      ally.flags = {
        ...ally.flags,
        helped_by: { id: actor.id, name: actor.name, ...(against ? { against_id: against.id } : {}) },
      };
      saveCombatant(db, ally);
      data = { ally_id: ally.id, ...(against ? { against_id: against.id } : {}) };
      note(
        `${actor.name} helps ${ally.name}: advantage on their next ${against ? `attack against ${against.name}` : 'ability check'}.`,
        data,
      );
      break;
    }
    case 'hide': {
      const map = encounterMap(encounter);
      const combatants = listCombatants(db, encounter.id);
      // 2024: hiding needs Three-Quarters or Total Cover from everyone who could see you; half is not enough.
      const seen = combatants.filter((c) => {
        if (!c.alive || c.team === actor.team) return false;
        const cover = coverBetween(map, combatants, c, actor).cover;
        return cover !== 'three_quarters' && cover !== 'total';
      });
      if (seen.length > 0) {
        throw new Error(
          `${actor.name} is in plain sight of ${seen.map((c) => c.name).join(', ')}: hiding needs three-quarters cover, total cover or heavy obscurement. Move behind something first - find_position with cover_from finds the cell.`,
        );
      }
      const check = await rollCheck(db, encounter, actor, {
        ability: 'dex',
        skill: 'stealth',
        dc: HIDE_DC,
        purpose: 'Stealth check to hide',
        tool: 'use_action',
      });
      data = { check, dc: HIDE_DC, hidden: check.success };
      if (check.success) {
        const created = attachEffect(db, encounter, {
          target_id: actor.id,
          source_id: actor.id,
          name: 'invisible',
          kind: 'condition',
          tick: 'end',
          ends: 'manual',
        });
        log.push(created.entry);
        const fresh = getCombatant(db, encounter.id, actor.id);
        actor.conditions = fresh.conditions;
        actor.flags = { ...actor.flags, hidden: true };
        data = { ...data, effect_id: created.effect.id };
        note(`${actor.name} hides: Stealth ${check.total} against DC ${HIDE_DC} - unseen until they attack, cast or make noise.`, data);
      } else {
        note(`${actor.name} fails to hide: Stealth ${check.total} against DC ${HIDE_DC}.`, data);
      }
      break;
    }
    case 'ready': {
      const trigger = input.trigger?.trim();
      const readied = input.readied_action?.trim();
      if (!trigger || !readied) {
        throw new Error('ready needs trigger ("when the goblin steps into the doorway") and readied_action ("Shortbow").');
      }
      actor.flags = { ...actor.flags, ready: { trigger, action: readied } };
      data = { trigger, readied_action: readied };
      note(`${actor.name} readies ${readied}, triggered by: ${trigger}. Release it out of turn; it spends the reaction.`, data);
      break;
    }
    case 'utilize': {
      data = { utilized: true };
      note(`${actor.name} uses an object.`, data);
      break;
    }
    case 'stand': {
      if (!actor.conditions.includes('prone')) throw new Error(`${actor.name} is not prone.`);
      const cost = Math.floor(actor.speed / 2);
      if (actor.movement_left < cost) {
        throw new Error(`Standing up costs ${cost} ft of movement and ${actor.name} has ${actor.movement_left} ft left.`);
      }
      actor.movement_left -= cost;
      dropCondition(db, encounter, actor, 'prone');
      data = { cost_ft: cost, movement_left: actor.movement_left };
      note(`${actor.name} stands up for ${cost} ft of movement, ${actor.movement_left} ft left.`, data);
      break;
    }
    case 'escape_grapple': {
      const grapplerId = actor.flags.grappled_by;
      if (grapplerId === undefined) throw new Error(`${actor.name} is not grappled.`);
      const grappler = getCombatant(db, encounter.id, grapplerId);
      const dc = unarmedDc(db, grappler);
      // The escaper picks Athletics or Acrobatics, so the engine rolls whichever it is better at.
      const sheet = sheetOf(db, actor);
      const athleticsBonus = sheet
        ? sheetSkillBonus(sheet, 'athletics', 'str')
        : (actor.stat_block?.skills.athletics ?? abilityMod(actor.stat_block?.abilities.str ?? 10));
      const acrobaticsBonus = sheet
        ? sheetSkillBonus(sheet, 'acrobatics', 'dex')
        : (actor.stat_block?.skills.acrobatics ?? abilityMod(actor.stat_block?.abilities.dex ?? 10));
      const better: { ability: Ability; skill: string } =
        acrobaticsBonus > athleticsBonus ? { ability: 'dex', skill: 'acrobatics' } : { ability: 'str', skill: 'athletics' };
      const athletics = await rollCheck(db, encounter, actor, {
        ...better,
        dc,
        purpose: `Escape ${grappler.name}'s grapple: ${better.skill}`,
        tool: 'use_action',
      });
      data = { grappler_id: grappler.id, dc, check: athletics, escaped: athletics.success };
      if (athletics.success) {
        releaseGrapple(db, encounter, grappler, actor);
        note(`${actor.name} breaks free of ${grappler.name} (check ${athletics.total} vs DC ${dc}).`, data);
      } else {
        note(`${actor.name} stays in ${grappler.name}'s grip (check ${athletics.total} vs DC ${dc}).`, data);
      }
      break;
    }
    case 'grapple':
    case 'shove': {
      const done = await grappleOrShove(db, encounter, actor, id, input);
      log.push(...done.log);
      data = done.data;
      break;
    }
    default:
      throw new Error(`"${id}" is not a standard action.`);
  }

  saveCombatant(db, actor);
  return { log, data };
}

/** Unhooks a grapple from both sides: the condition, the grappled flag and the grappler's list. */
function releaseGrapple(db: Db, encounter: EncounterRow, grappler: Combatant, target: Combatant): void {
  dropCondition(db, encounter, target, 'grappled');
  const held = getCombatant(db, encounter.id, target.id);
  held.flags = { ...held.flags, grappled_by: undefined };
  saveCombatant(db, held);
  const holder = getCombatant(db, encounter.id, grappler.id);
  holder.flags = { ...holder.flags, grappling: (holder.flags.grappling ?? []).filter((id) => id !== target.id) };
  saveCombatant(db, holder);
  if (grappler.id === target.id) return;
  grappler.flags = holder.flags;
  target.flags = held.flags;
  target.conditions = held.conditions;
}

// --- generic actions, areas and effects ------------------------------------

// --- a spell read off its SRD entry -----------------------------------------

const SAVE_ABILITY: Record<string, Ability> = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
};

/** What one casting costs the caster's turn; "long" is anything a fight has no room for. */
export type CastingEconomy = 'action' | 'bonus_action' | 'reaction' | 'long';

export interface SpellFill {
  name: string;
  level: number;
  /** The school the entry files it under, which Sculpt Spells and Empowered Evocation read. */
  school: string;
  /** The class lists it is on, as the SRD entry carries them ("srd-2024_wizard"). */
  classes: string[];
  /** The entry's own casting time, as the SRD writes it: "action", "bonus-action", "reaction", "1minute". */
  casting_time: string;
  /** The action economy that casting time spends. */
  economy: CastingEconomy;
  /** Cast with a spell attack roll rather than a saving throw. */
  attack_roll: boolean;
  /** The slot this casting spends; null for a cantrip. */
  slot_level: number | null;
  damage_expr?: string;
  damage_type?: string;
  heal_expr?: string;
  save_ability?: Ability;
  save_dc?: number;
  half_on_save?: boolean;
  shape?: AoeShape;
  concentration: boolean;
  range_ft: number | null;
  duration_rounds: number | null;
  /** What the engine did and did not scale, said out loud so the DM is never guessing. */
  notes: string[];
}

/** "8d6" plus 2d6 is "10d6"; dice of another size are added on the end instead. */
function addDice(expr: string, count: number, faces: number): string {
  if (count <= 0) return expr;
  const match = expr.match(/^(\d*)d(\d+)/);
  if (match && Number(match[2]) === faces) {
    return expr.replace(/^(\d*)d(\d+)/, `${Number(match[1] || '1') + count}d${faces}`);
  }
  return `${expr} + ${count}d${faces}`;
}

/** The plain "increases by 1dX for each spell slot level above N" scaling, and nothing cleverer. */
function upcastDice(higher: string | null, expr: string, slotLevel: number): { expr: string; note: string | null } {
  const text = (higher ?? '').trim();
  if (!text) return { expr, note: null };
  const match = text.match(/increases by (\d*)d(\d+) for each spell slot level above (\d+)/i);
  if (!match) return { expr, note: `${text} - the engine does not scale that; apply it yourself.` };
  const steps = slotLevel - Number(match[3]);
  if (steps <= 0) return { expr, note: null };
  const count = Number(match[1] || '1') * steps;
  return { expr: addDice(expr, count, Number(match[2])), note: `upcast to level ${slotLevel}: +${count}d${match[2]}` };
}

const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * Magic Missile's shape: "three glowing darts", each dealing the entry's dice, "one more dart for each
 * spell slot level above 1", no attack roll. All of them go at the one target, so the dice multiply.
 */
function projectileDarts(entry: { desc: string; higher_level: string | null; attack_roll: boolean }, slotLevel: number): number | null {
  // Chain Lightning's "three bolts" and Storm of Vengeance's "six bolts" each strike a different creature
  // once; only a spell that grows by "one more dart per slot level" pours its darts into one target.
  const more = (entry.higher_level ?? '').match(/one (?:more|additional) (?:dart|beam|ray|bolt) for each spell slot level above (\d+)/i);
  if (!more || entry.attack_roll) return null;
  const base = entry.desc.match(/\b(two|three|four|five|six|\d+)\b[\w\s]{0,20}?\b(darts|beams|rays|bolts)\b/i);
  if (!base) return null;
  const count = COUNT_WORDS[base[1]!.toLowerCase()] ?? Number(base[1]);
  if (!Number.isInteger(count) || count < 2) return null;
  return count + Math.max(0, slotLevel - Number(more[1]));
}

/** "1d4 + 1" three times over is "3d4 + 3": every term of the expression scaled by the dart count. */
function multiplyDice(expr: string, times: number): string {
  return expr.replace(/(\d*)d(\d+)|\d+/g, (term, count: string | undefined, faces: string | undefined) =>
    faces === undefined ? String(Number(term) * times) : `${Number(count || '1') * times}d${faces}`,
  );
}

/** Cantrips grow with the caster's level at the 2024 tiers, when the entry says they do. */
function cantripDice(higher: string | null, expr: string, casterLevel: number): { expr: string; note: string | null } {
  const match = (higher ?? '').match(/increases by (\d*)d(\d+) when you reach level/i);
  if (!match) return { expr, note: null };
  const tier = casterLevel >= 17 ? 3 : casterLevel >= 11 ? 2 : casterLevel >= 5 ? 1 : 0;
  if (tier === 0) return { expr, note: null };
  const count = Number(match[1] || '1') * tier;
  return { expr: addDice(expr, count, Number(match[2])), note: `cantrip at level ${casterLevel}: +${count}d${match[2]}` };
}

const SHAPE_WORDS: Record<string, AoeShape['kind']> = {
  sphere: 'sphere',
  emanation: 'sphere',
  cylinder: 'sphere',
  cone: 'cone',
  cube: 'cube',
  line: 'line',
};

/** "a 20-foot-radius Sphere", "a 15-foot Cone": the area the description spells out. */
function areaOf(desc: string): AoeShape | undefined {
  const match = desc.match(/(\d+)-foot(?:-radius)?[- ](Sphere|Cone|Cube|Line|Emanation|Cylinder)/i);
  if (!match) return undefined;
  return { kind: SHAPE_WORDS[match[2]!.toLowerCase()]!, size_ft: Number(match[1]) };
}

function rangeOf(text: string): number | null {
  if (/^self/i.test(text)) return null;
  if (/^touch/i.test(text)) return 5;
  const match = text.match(/^(\d+)\s*(?:feet|foot|ft)/i);
  return match ? Number(match[1]) : null;
}

/**
 * The action a casting time spends. The SRD entries carry slugs ("action", "bonus-action", "reaction",
 * "1minute", "10minutes", "1hour"); a spell the DM wrote carries prose ("1 bonus action"). Anything
 * longer than an action is "long" and has no place in a fight.
 */
export function castingEconomy(text: string): CastingEconomy {
  const slug = text.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (slug.includes('bonus-action')) return 'bonus_action';
  if (slug.includes('reaction')) return 'reaction';
  if (slug.includes('action')) return 'action';
  return 'long';
}

const ROUNDS_PER: Record<string, number> = { round: 1, minute: 10, hour: 600 };

function durationRounds(text: string): number | null {
  const match = text.match(/^(\d+)\s*(round|minute|hour)/i);
  return match ? Number(match[1]) * ROUNDS_PER[match[2]!.toLowerCase()]! : null;
}

/** Everything use_action needs about an SRD spell, at the slot it is cast with. */
export function spellFill(
  name: string,
  sheet: CombatSheet | null,
  slotLevel?: number,
): SpellFill | null {
  const entry = findSpell(name);
  if (!entry) return null;
  const notes: string[] = [];
  const slot = entry.level === 0 ? null : (slotLevel ?? entry.level);
  if (slot !== null && slot < entry.level) {
    throw new Error(`${entry.name} is a level ${entry.level} spell and cannot be cast with a level ${slot} slot.`);
  }
  const healing =
    entry.damage_roll !== null &&
    entry.damage_roll !== '' &&
    entry.damage_types.length === 0 &&
    /regains?|hit points/i.test(entry.desc);
  let dice = entry.damage_roll ?? '';
  const darts = dice && !healing && entry.level > 0 ? projectileDarts(entry, slot ?? entry.level) : null;
  if (dice && darts) {
    notes.push(`${darts} darts x (${dice}) at level ${slot ?? entry.level}, all at the target`);
    dice = multiplyDice(dice, darts);
  } else if (dice) {
    const scaled =
      entry.level === 0
        ? cantripDice(entry.higher_level, dice, sheet?.level ?? 1)
        : upcastDice(entry.higher_level, dice, slot ?? entry.level);
    dice = scaled.expr;
    if (scaled.note) notes.push(scaled.note);
  } else if (entry.higher_level) {
    notes.push(`${entry.higher_level} - the engine does not scale that; apply it yourself.`);
  }
  const save = entry.saving_throw_ability ? SAVE_ABILITY[entry.saving_throw_ability.toLowerCase()] : undefined;
  return {
    name: entry.name,
    level: entry.level,
    school: entry.school,
    classes: entry.classes,
    casting_time: entry.casting_time,
    economy: castingEconomy(entry.casting_time),
    attack_roll: entry.attack_roll,
    slot_level: slot,
    ...(dice && !healing ? { damage_expr: dice } : {}),
    ...(entry.damage_types[0] ? { damage_type: entry.damage_types[0] } : {}),
    ...(dice && healing ? { heal_expr: dice } : {}),
    ...(save ? { save_ability: save } : {}),
    ...(save && sheet?.spells.save_dc ? { save_dc: sheet.spells.save_dc } : {}),
    ...(save ? { half_on_save: /half as much damage/i.test(entry.desc) } : {}),
    ...(areaOf(entry.desc) ? { shape: areaOf(entry.desc) } : {}),
    concentration: entry.concentration,
    range_ft: rangeOf(entry.range_text),
    duration_rounds: durationRounds(entry.duration),
    notes,
  };
}

/** Refuses a casting whose slot is not there, before a single sorcery point has been spent on it. */
function requireSlotFor(caster: Combatant, sheet: CombatSheet | null, spell: SpellFill): void {
  if (spell.slot_level === null || !sheet || caster.character_id === null) return;
  const slot = sheet.spell_slots[String(spell.slot_level)];
  if (slot && slotsLeft(slot) > 0) return;
  const open = Object.entries(sheet.spell_slots)
    .filter(([, entry]) => slotsLeft(entry) > 0)
    .map(([level, entry]) => `level ${level} (${slotsLeft(entry)} left)`);
  throw new Error(
    `${sheet.name} has no level ${spell.slot_level} spell slot left for ${spell.name}. Slots remaining: ${
      open.length > 0 ? open.join(', ') : 'none'
    }.`,
  );
}

/** Spends the slot the casting costs, on the caster's own sheet, and says what is left. */
function spendSlotFor(
  db: Db,
  encounter: EncounterRow,
  caster: Combatant,
  sheet: CombatSheet | null,
  spell: SpellFill,
): CombatLogEntry | null {
  if (spell.slot_level === null) return null;
  if (!sheet || caster.character_id === null) return null;
  // Boon of Spell Recall: roll 1d4 on a level 1-4 slot, and on the slot's own level it is not expended.
  if (hasBoon(sheet, 'Boon of Spell Recall') && spell.slot_level <= 4) {
    const rolled = rollDice('1d4', { roll_type: 'other' });
    if (rolled.total === spell.slot_level) {
      return logCombat(db, encounter, {
        actor_id: caster.id,
        kind: 'spell_slot',
        payload: { spell: spell.name, level: spell.slot_level, feature: 'Boon of Spell Recall', kept: true },
        text: `${caster.name} casts ${spell.name} and the slot is not expended at all: Boon of Spell Recall rolled a ${rolled.total} (${rolled.output}).`,
      });
    }
  }
  const spent = useSpellSlot(db, {
    campaign_id: encounter.campaign_id,
    character_id: caster.character_id,
    level: spell.slot_level,
  });
  return logCombat(db, encounter, {
    actor_id: caster.id,
    kind: 'spell_slot',
    payload: { spell: spell.name, level: spell.slot_level, remaining: spent.remaining },
    text: `${caster.name} spends a level ${spell.slot_level} slot on ${spell.name} (${spent.remaining} left at that level).`,
  });
}

/** The castings a class feature pays for instead of a spell slot, by the spell's own name. */
const FREE_CASTS: Record<string, { resource: string; feature: string }> = {
  'divine smite': { resource: 'paladins_smite', feature: "Paladin's Smite" },
  "hunter's mark": { resource: 'favored_enemies', feature: 'Favored Enemy' },
};

/** What is left of a class resource on this sheet. */
function resourceLeft(sheet: CombatSheet, resource: string): number {
  const spec = resourceSpec(sheet, resource);
  const row = sheet.features.find((f) => f.mechanics?.resource === resource);
  const max = spec?.max ?? row?.mechanics?.max ?? 0;
  return max - (row?.mechanics?.used ?? 0);
}

/**
 * The class feature that would pay for this casting instead of a spell slot: a feature with uses left
 * (Paladin's Smite, Favored Enemy), or an Eldritch Invocation that simply casts it free.
 */
function freeCastOf(sheet: CombatSheet, spellName: string): { resource?: string; feature: string } | null {
  const wanted = spellName.trim().toLowerCase();
  const free = FREE_CASTS[wanted];
  if (free && resourceLeft(sheet, free.resource) > 0) return free;
  for (const held of heldInvocations(sheet)) {
    const mechanics = srd.findInvocation(held)?.mechanics;
    if (mechanics?.free_spell?.toLowerCase() !== wanted) continue;
    // Gift of the Depths counts its free castings; the rest are as often as the warlock likes.
    if (!mechanics.free_spell_resource) return { feature: held };
    if (resourceLeft(sheet, mechanics.free_spell_resource) > 0) return { feature: held, resource: mechanics.free_spell_resource };
  }
  return null;
}

/** The feature a free_cast names as paying for the whole casting. */
type NamedFreeCast =
  | 'divine_intervention'
  | 'natural_recovery'
  | 'wild_companion'
  | 'pact_of_the_chain'
  | 'mystic_arcanum'
  | 'spell_mastery'
  | 'signature_spell';

/** The free casts that give the spell a casting time of their own; both of these are a Magic action. */
const FREE_CAST_ECONOMY: Partial<Record<NamedFreeCast, CastingEconomy>> = {
  wild_companion: 'action',
  pact_of_the_chain: 'action',
};

/** The Find Familiar forms the spell names that the bundled creature data carries a stat block for. */
const FAMILIAR_FORMS = ['Bat', 'Cat', 'Frog', 'Hawk', 'Lizard', 'Octopus', 'Owl', 'Rat', 'Raven', 'Spider', 'Weasel'];

/**
 * Wild Companion and Pact of the Chain both cast Find Familiar as a Magic action: the Druid pays a use of
 * Wild Shape for it, the Warlock pays nothing at all, and the form the familiar takes is named with option.
 */
function planFamiliarCast(
  actor: Combatant,
  sheet: CombatSheet,
  spell: SpellFill,
  which: 'wild_companion' | 'pact_of_the_chain',
  option: string | undefined,
): { cost?: FeatureCost; feature: string; familiar: string } {
  const chain = which === 'pact_of_the_chain';
  const feature = chain ? 'Pact of the Chain' : 'Wild Companion';
  const held = chain ? hasInvocation(sheet, 'Pact of the Chain') : hasFeature(sheet, 'druid-wild-companion');
  if (!held) {
    throw new Error(
      `${actor.name} has no ${feature}; it is ${chain ? 'an Eldritch Invocation' : 'a Druid feature taken at level 2'}.`,
    );
  }
  if (!/^find familiar$/i.test(spell.name)) {
    throw new Error(`${feature} casts Find Familiar and nothing else; ${spell.name} is a different spell.`);
  }
  const form = FAMILIAR_FORMS.find((name) => name.toLowerCase() === (option ?? '').trim().toLowerCase());
  if (!form) {
    throw new Error(
      `Find Familiar needs the animal form to take: pass option with one of ${FAMILIAR_FORMS.join(', ')}.`,
    );
  }
  spell.slot_level = null;
  spell.notes.push(
    `${feature}: Find Familiar cast as a Magic action with no spell slot${chain ? '' : ' and no Material components'}.`,
  );
  if (chain) return { feature, familiar: form };
  requireResource(sheet, actor, { resource: 'wild_shape', amount: 1 }, feature);
  return { cost: { resource: 'wild_shape', amount: 1 }, feature, familiar: form };
}

/**
 * Divine Intervention and Natural Recovery pay for a whole casting out of their own once-a-rest use, and
 * neither has a spell of its own: the DM names the spell and the feature with free_cast. This settles
 * what the casting costs and refuses it outright; the use itself is spent once nothing can refuse it.
 */
function planNamedFreeCast(
  actor: Combatant,
  sheet: CombatSheet,
  spell: SpellFill,
  which: NamedFreeCast,
  option: string | undefined,
): { cost?: FeatureCost; feature: string; familiar?: string } {
  if (which === 'wild_companion' || which === 'pact_of_the_chain') {
    return planFamiliarCast(actor, sheet, spell, which, option);
  }
  if (which === 'mystic_arcanum') {
    if (!hasFeature(sheet, 'warlock-mystic-arcanum')) {
      throw new Error(`${actor.name} has no Mystic Arcanum; it is a Warlock feature taken at level 11.`);
    }
    const levels = mysticArcanumLevels(sheet.level);
    if (!levels.includes(spell.level)) {
      throw new Error(
        `A Mystic Arcanum is a Warlock spell of level ${levels.join(', ')} at this level, and ${spell.name} is level ${spell.level}.`,
      );
    }
    if (!spell.classes.some((entry) => entry.endsWith('_warlock'))) {
      throw new Error(`A Mystic Arcanum is chosen from the Warlock list, and ${spell.name} is not on it.`);
    }
    const chosen = chosenOptions(sheet, 'Mystic Arcanum');
    if (chosen.length > 0 && !chosen.some((name) => name.toLowerCase() === spell.name.toLowerCase())) {
      throw new Error(`${actor.name}'s Mystic Arcanum is ${chosen.join(' and ')}, not ${spell.name}.`);
    }
    const cost = { resource: `mystic_arcanum_${spell.level}`, amount: 1 };
    requireResource(sheet, actor, cost, `the level ${spell.level} Mystic Arcanum`);
    spell.slot_level = null;
    spell.notes.push(`Mystic Arcanum: ${spell.name} is cast without a spell slot, once a long rest.`);
    return { cost, feature: `Mystic Arcanum (level ${spell.level})` };
  }
  if (which === 'spell_mastery') {
    if (!hasFeature(sheet, 'wizard-spell-mastery')) {
      throw new Error(`${actor.name} has no Spell Mastery; it is a Wizard feature taken at level 18.`);
    }
    const chosen = chosenOptions(sheet, 'Spell Mastery');
    if (chosen.length > 0 && !chosen.some((name) => name.toLowerCase() === spell.name.toLowerCase())) {
      throw new Error(`Spell Mastery covers ${chosen.join(' and ')}, not ${spell.name}.`);
    }
    if (spell.level < 1 || spell.level > 2) {
      throw new Error(`Spell Mastery masters a level 1 and a level 2 spell; ${spell.name} is level ${spell.level}.`);
    }
    if (spell.slot_level !== null && spell.slot_level > spell.level) {
      throw new Error(`Spell Mastery casts ${spell.name} at its lowest level for nothing; a higher slot is spent as usual.`);
    }
    spell.slot_level = null;
    spell.notes.push(`Spell Mastery: ${spell.name} is cast at level ${spell.level} at will, with no slot.`);
    return { feature: 'Spell Mastery' };
  }
  if (which === 'signature_spell') {
    if (!hasFeature(sheet, 'wizard-signature-spells')) {
      throw new Error(`${actor.name} has no Signature Spells; it is a Wizard feature taken at level 20.`);
    }
    const chosen = chosenOptions(sheet, 'Signature Spells');
    if (chosen.length > 0 && !chosen.some((name) => name.toLowerCase() === spell.name.toLowerCase())) {
      throw new Error(`${actor.name}'s signature spells are ${chosen.join(' and ')}, not ${spell.name}.`);
    }
    if (spell.level !== 3) {
      throw new Error(`A signature spell is a level 3 spell; ${spell.name} is level ${spell.level}.`);
    }
    const cost = { resource: signatureKey(spell.name), amount: 1 };
    requireResource(sheet, actor, cost, `${spell.name} as a signature spell`);
    spell.slot_level = null;
    spell.notes.push(`Signature Spells: ${spell.name} is cast at level 3 with no slot, once before a rest.`);
    return { cost, feature: 'Signature Spells' };
  }
  if (which === 'divine_intervention') {
    if (!hasFeature(sheet, 'cleric-divine-intervention')) {
      throw new Error(`${actor.name} has no Divine Intervention; it is a Cleric feature taken at level 10.`);
    }
    // Greater Divine Intervention, at level 20, is the one thing that reaches past the Cleric list: Wish.
    const wish = /^wish$/i.test(spell.name) && hasFeature(sheet, 'cleric-greater-divine-intervention');
    if (!wish && !spell.classes.some((entry) => entry.endsWith('_cleric'))) {
      throw new Error(`Divine Intervention casts a Cleric spell, and ${spell.name} is not on the Cleric list.`);
    }
    if (spell.level > 5 && !wish) {
      throw new Error(
        `Divine Intervention casts a Cleric spell of level 5 or lower; ${spell.name} is level ${spell.level}.${
          hasFeature(sheet, 'cleric-greater-divine-intervention') ? ' Only Wish is excepted, at level 20.' : ''
        }`,
      );
    }
    if (wish) {
      spell.notes.push('Greater Divine Intervention: Divine Intervention cannot be used again until 2d4 Long Rests have passed.');
    }
    requireResource(sheet, actor, { resource: 'divine_intervention', amount: 1 }, 'Divine Intervention');
    spell.slot_level = null;
    spell.notes.push('Divine Intervention: no spell slot and no Material components.');
    return { cost: { resource: 'divine_intervention', amount: 1 }, feature: 'Divine Intervention' };
  }
  if (!hasFeature(sheet, 'land-natural-recovery')) {
    throw new Error(`${actor.name} has no Natural Recovery; it is a Circle of the Land feature taken at level 6.`);
  }
  if (spell.level < 1) {
    throw new Error(`Natural Recovery casts one of your prepared Circle spells of level 1 or higher; ${spell.name} is a cantrip.`);
  }
  requireResource(sheet, actor, { resource: 'natural_recovery', amount: 1 }, 'Natural Recovery');
  spell.slot_level = null;
  spell.notes.push('Natural Recovery: this Circle spell costs no spell slot.');
  return { cost: { resource: 'natural_recovery', amount: 1 }, feature: 'Natural Recovery' };
}

/** What a casting comes out as once Metamagic and the caster's own features have had their say. */
interface CastPlan {
  modifiers: CastModifier[];
  economy: CastingEconomy;
  range_ft: number | null;
  save_dc: number | undefined;
  damage_type: string | null;
  /** Creatures Careful Spell or Sculpt Spells carved out: they succeed and take nothing. */
  auto_success: Set<number>;
  /** Creatures Heightened Spell leaves saving with Disadvantage. */
  save_disadvantage: Set<number>;
  attack_advantage: boolean;
  /** A flat bonus on this casting's attack roll: what `bonus {to: spell_attack}` is worth. */
  attack_bonus: number;
  reroll_attack: boolean;
  reroll_damage: number;
  slot_increase: number;
  duration_multiplier: number;
  /** Extended Spell: Advantage on the Constitution saves that keep this casting's Concentration up. */
  concentration_advantage: boolean;
  extra_targets: Array<{ id: number; feature: string; within_ft?: number }>;
  /** What the casting's own features charge for it, each under the name of the feature that asked. */
  costs: Array<FeatureCost & { feature: string }>;
  /** Arcane Apotheosis paid for one Metamagic option of this turn, and the turn remembers it. */
  free_metamagic?: boolean;
  notes: string[];
}

/** The spell as the registry is told about it. */
const spellInfoOf = (spell: SpellFill): SpellInfo => ({
  name: spell.name,
  level: spell.level,
  slot_level: spell.slot_level,
  school: spell.school,
  damage_type: spell.damage_type ?? null,
  attack_roll: spell.attack_roll,
  ...(spell.save_ability ? { save_ability: spell.save_ability } : {}),
  concentration: spell.concentration,
  range_ft: spell.range_ft,
  classes: spell.classes,
});

/**
 * Metamagic is refused before anything is written: an option this Sorcerer does not know, more options
 * than the text allows on one casting, or more sorcery points than they have.
 */
function requireMetamagic(sheet: CombatSheet, actor: Combatant, names: string[], damageExpr?: string): void {
  if (names.length === 0) return;
  // Empowered Spell rerolls dice, so a fixed total cannot ride with it: refuse before anything is spent.
  if (
    damageExpr !== undefined &&
    /^\s*\d+\s*$/.test(damageExpr) &&
    names.some((name) => name.trim().toLowerCase() === 'empowered spell')
  ) {
    throw new Error(
      `Empowered Spell rerolls dice, and damage_expr "${damageExpr}" carries none: drop damage_expr and let the engine roll, or drop Empowered Spell.`,
    );
  }
  const known = heldMetamagic(sheet);
  if (known.length === 0) {
    throw new Error(`${actor.name} knows no Metamagic; it is a Sorcerer feature taken at level 2.`);
  }
  for (const name of names) {
    if (!known.some((held) => held.toLowerCase() === name.trim().toLowerCase())) {
      throw new Error(`${actor.name} does not know ${name}. They know: ${known.join(', ')}.`);
    }
  }
  // "Only one Metamagic option on a spell unless otherwise noted": Empowered and Seeking say otherwise,
  // and Sorcery Incarnate allows a second while Innate Sorcery runs.
  const counted = names.filter((name) => !STACKING_METAMAGIC.some((free) => free.toLowerCase() === name.toLowerCase()));
  const allowed = hasFeature(sheet, 'sorcerer-sorcery-incarnate') && actor.flags.innate_sorcery ? 2 : 1;
  if (counted.length > allowed) {
    throw new Error(
      `Only ${allowed} Metamagic option${allowed === 1 ? '' : 's'} may ride on one casting${
        allowed === 1 ? ' unless the option says otherwise' : ''
      }; ${counted.join(', ')} is ${counted.length}. Empowered Spell and Seeking Spell may always come along.`,
    );
  }
  const total = names.reduce((sum, name) => sum + metamagicCost(name), 0);
  requireResource(sheet, actor, { resource: 'sorcery_points', amount: total }, `${names.join(' and ')}`);
}

/** Folds everything the caster's features do to this casting into one plan the spell path then follows. */
function planCast(
  sheet: CombatSheet,
  actor: Combatant,
  spell: SpellFill,
  targets: Combatant[],
  options: CastOptions,
  base: { save_dc: number | undefined; damage_type: string | null },
): CastPlan {
  const modifiers = castModifiers(sheet, {
    actor,
    spell: spellInfoOf(spell),
    targets,
    options,
  });
  const plan: CastPlan = {
    modifiers,
    economy: spell.economy,
    range_ft: spell.range_ft,
    save_dc: base.save_dc,
    damage_type: base.damage_type,
    auto_success: new Set<number>(),
    save_disadvantage: new Set<number>(),
    attack_advantage: false,
    attack_bonus: 0,
    reroll_attack: false,
    reroll_damage: 0,
    slot_increase: 0,
    duration_multiplier: 1,
    concentration_advantage: false,
    extra_targets: [],
    costs: [],
    notes: [],
  };
  // Arcane Apotheosis: the first Metamagic option of the turn is free while Innate Sorcery runs.
  let freeMetamagic = arcaneApotheosisFree(sheet, actor);
  for (const modifier of modifiers) {
    if (modifier.spend && freeMetamagic && modifier.spend.resource === 'sorcery_points') {
      freeMetamagic = false;
      plan.free_metamagic = true;
      plan.notes.push(`Arcane Apotheosis: ${modifier.feature} costs no Sorcery Points this turn.`);
      plan.notes.push(modifier.note);
      continue;
    }
    if (modifier.spend) plan.costs.push({ ...modifier.spend, feature: modifier.feature });
    plan.notes.push(modifier.note);
    switch (modifier.kind) {
      case 'economy':
        plan.economy = modifier.economy === 'bonus_action' ? 'bonus_action' : 'action';
        break;
      case 'range':
        plan.range_ft =
          plan.range_ft === null
            ? (modifier.least_ft ?? null)
            : Math.max(plan.range_ft * (modifier.multiplier ?? 1), modifier.least_ft ?? 0);
        break;
      case 'save_dc':
        if (plan.save_dc !== undefined) plan.save_dc += modifier.bonus;
        break;
      case 'attack_advantage':
        plan.attack_advantage = true;
        break;
      case 'attack_bonus':
        plan.attack_bonus += modifier.bonus;
        break;
      case 'reroll_attack':
        plan.reroll_attack = true;
        break;
      case 'extra_target':
        plan.extra_targets.push({
          id: modifier.target_id,
          feature: modifier.feature,
          ...(modifier.within_ft === undefined ? {} : { within_ft: modifier.within_ft }),
        });
        break;
      case 'slot_level':
        plan.slot_increase += modifier.increase;
        break;
      case 'duration':
        plan.duration_multiplier *= modifier.multiplier;
        if (modifier.concentration_advantage) plan.concentration_advantage = true;
        break;
      case 'save_disadvantage':
        plan.save_disadvantage.add(modifier.target_id);
        break;
      case 'auto_success':
        for (const id of modifier.target_ids) plan.auto_success.add(id);
        break;
      case 'damage_type':
        plan.damage_type = modifier.to;
        break;
      case 'reroll_damage':
        plan.reroll_damage = Math.max(plan.reroll_damage, modifier.dice);
        break;
      default:
        break;
    }
  }
  return plan;
}

/**
 * Empowered Spell: damage dice below the die's average are rolled again, lowest first, and the new
 * rolls stand. A roll the player made themselves comes back as a total with no dice to reread, so it says so instead.
 */
function rerollLowest(
  expr: string,
  dice: number[],
  count: number,
): { delta: number; note: string } {
  const faces = Number(/d(\d+)/i.exec(expr)?.[1] ?? 0);
  if (faces === 0 || dice.length === 0) {
    return { delta: 0, note: 'Empowered Spell: the dice were rolled elsewhere, so reroll them yourself.' };
  }
  const belowAverage = dice.filter((value) => value < (faces + 1) / 2).sort((a, b) => a - b);
  if (belowAverage.length === 0) {
    return { delta: 0, note: 'Empowered Spell: every die is already above average, nothing rerolled.' };
  }
  // "A number of those dice up to your Charisma modifier (minimum of one)": only a die below its average is worth rerolling.
  let delta = 0;
  const swapped: string[] = [];
  for (const die of belowAverage.slice(0, Math.max(count, 1))) {
    const again = rollDice(`1d${faces}`, { roll_type: 'damage' });
    delta += again.total - die;
    swapped.push(`${die} -> ${again.total}`);
  }
  return { delta, note: `Empowered Spell: ${swapped.join(', ')}.` };
}

/** The Beast whose statistics Wild Shape takes, refused when the Druid's level does not allow that one. */
function beastForm(name: string, limits: { max_cr: number; fly: boolean }): CreatureStatBlock {
  const block = statBlockFor(name);
  if (!/beast/i.test(block.type)) {
    throw new Error(`${block.name} is a ${block.type}, and Wild Shape takes the form of a Beast.`);
  }
  if (block.cr > limits.max_cr) {
    throw new Error(
      `${block.name} is CR ${block.cr}, and Wild Shape reaches CR ${limits.max_cr} at this level. Name a smaller Beast.`,
    );
  }
  if (!limits.fly && (block.speed.fly ?? 0) > 0) {
    throw new Error(`${block.name} has a Fly Speed, and Wild Shape takes no flying form until Druid level 8.`);
  }
  return block;
}

/** Wild Shape: the Beast's game statistics go on the combatant row, and the Druid's own are kept to come back to. */
function enterWildShape(db: Db, encounter: EncounterRow, actor: Combatant, sheet: CombatSheet, block: CreatureStatBlock): void {
  const fresh = getCombatant(db, encounter.id, actor.id);
  fresh.flags = {
    ...fresh.flags,
    wild_shape: {
      form: block.name,
      base_ac: fresh.ac,
      base_speed: fresh.speed,
      rounds_left: wildShapeRounds(sheet.level),
    },
  };
  fresh.ac = block.ac;
  fresh.speed = block.speed.walk ?? fresh.speed;
  fresh.movement_left = Math.min(fresh.movement_left, fresh.speed);
  setCombatantStatBlock(db, fresh.id, block);
  saveCombatant(db, fresh);
  actor.flags = fresh.flags;
  actor.ac = fresh.ac;
  actor.speed = fresh.speed;
  actor.stat_block = block;
}

/** Out of the Beast form and back into the Druid's own, however it ended. */
function revertWildShape(db: Db, encounter: EncounterRow, actor: Combatant, why: string): CombatLogEntry[] {
  const fresh = getCombatant(db, encounter.id, actor.id);
  const shape = fresh.flags.wild_shape;
  if (!shape) return [];
  fresh.flags = { ...fresh.flags, wild_shape: undefined };
  fresh.ac = shape.base_ac;
  fresh.speed = shape.base_speed;
  fresh.movement_left = Math.min(fresh.movement_left, fresh.speed);
  setCombatantStatBlock(db, fresh.id, null);
  saveCombatant(db, fresh);
  actor.flags = fresh.flags;
  actor.ac = fresh.ac;
  actor.speed = fresh.speed;
  actor.stat_block = null;
  return [
    logCombat(db, encounter, {
      actor_id: fresh.id,
      kind: 'feature_note',
      payload: { feature: 'Wild Shape', ended: true, form: shape.form, reason: why },
      text: `${fresh.name} drops the ${shape.form} form: ${why}.`,
    }),
  ];
}

/** Find Familiar through Wild Companion or Pact of the Chain: the familiar joins the fight as a companion. */
async function summonFamiliar(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  form: string,
  feature: string,
): Promise<CombatLogEntry[]> {
  const created = createCompanion(db, {
    campaign_id: encounter.campaign_id,
    name: `${actor.name}'s ${form}`,
    source: { creature: form },
  });
  const sheet = combatSheet(db, created.companion!.id);
  const token = addToEncounter(db, encounter, {
    kind: 'companion',
    name: sheet.name,
    team: actor.team,
    sheet,
    preferX: actor.x,
  });
  const roll = await rollOwnInitiative(db, encounter, token, initiativeBonus(token, sheet), 'use_action');
  token.initiative = roll.total;
  saveCombatant(db, token);
  reorderInitiative(db, encounter, token.id);
  return [
    logCombat(db, encounter, {
      actor_id: actor.id,
      target_id: token.id,
      kind: 'join',
      payload: { feature, familiar: form, combatant_id: token.id, character_id: sheet.id, initiative: roll.total },
      text: `${sheet.name} appears at (${token.x},${token.y}) and joins the fight on initiative ${roll.total} (${feature}).`,
    }),
  ];
}

/** A class feature with an action of its own: Rage, Second Wind, Flurry of Blows, Lay On Hands. */
async function runFeatureActionCall(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet,
  found: { handler: FeatureHandler; action: FeatureAction; option?: string },
  input: {
    target_id?: number;
    amount?: number;
    option?: string;
    slot_level?: number;
    point?: Point;
    rolls?: Record<string, PreRoll>;
    roll?: PreRoll;
    advantage?: Advantage;
    out_of_turn?: boolean;
    reason?: string;
  } & StandardActionInput,
  reaction: string | null,
) {
  const { handler, action } = found;
  // A homebrew clause that is out of uses is off the legal-actions list; naming it anyway is refused by
  // name, the way a class resource is, rather than resolving to a no-op that hides the reason.
  if (handler.index.startsWith('homebrew:') && action.cost) requireResource(sheet, actor, action.cost, action.name);
  const combatants = listCombatants(db, encounter.id);
  const target = input.target_id === undefined ? null : getCombatant(db, encounter.id, input.target_id);
  // Rage is entered once and extended after that, so a second use spends nothing.
  const extending = handler.index === 'barbarian-rage' && isRaging(actor);
  const outcome: FeatureOutcome = extending
    ? {
        economy: 'bonus_action',
        text: `${actor.name} keeps the Rage going for another round.`,
        flags: { raging: { ...actor.flags.raging!, extended_round: encounter.round } },
      }
    : handler.resolve!({
        sheet,
        actor,
        feature: sheet.features.find((f) => f.name === handler.name) ?? { name: handler.name },
        target,
        combatants,
        round: encounter.round,
        action_id: action.id,
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.slot_level === undefined ? {} : { slot_level: input.slot_level }),
        ...(input.point === undefined ? {} : { point: input.point }),
        ...(found.option ?? input.option ? { option: found.option ?? input.option! } : {}),
      });

  if (outcome.action_effect) {
    return runGenericUseAction(db, {
      campaign_id: encounter.campaign_id,
      actor_id: actor.id,
      action_name: action.name,
      ...(input.target_id === undefined ? {} : { target_id: input.target_id }),
      ...(input.point === undefined ? {} : { point: input.point }),
      ...(input.rolls === undefined ? {} : { rolls: input.rolls }),
      ...(input.roll === undefined ? {} : { roll: input.roll }),
      ...(input.advantage === undefined ? {} : { advantage: input.advantage }),
      ...(input.out_of_turn === undefined ? {} : { out_of_turn: input.out_of_turn }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      _feature_effect: { outcome, handler, action },
    }, encounter, actor, sheet, reaction, undefined);
  }

  // Nothing is written before the refusals: the economy first, then the resource.
  if (outcome.economy === 'action' || outcome.economy === 'bonus_action') {
    if (!input.out_of_turn) requireEconomy(actor, outcome.economy === 'bonus_action' ? 'bonus' : 'action', action.name);
  }
  if (outcome.economy === 'reaction' && actor.reaction_used) {
    throw new Error(
      `${actor.name} has already used their reaction this round, so ${action.name} has to wait for their next turn.`,
    );
  }
  const costs = outcome.spend ? (Array.isArray(outcome.spend) ? outcome.spend : [outcome.spend]) : [];
  for (const cost of costs) requireResource(sheet, actor, cost, action.name);
  // A stance spends nothing here: the refusal happens now so the declaration cannot promise what is gone.
  if (outcome.d20_stance?.spend) requireResource(sheet, actor, outcome.d20_stance.spend, action.name);
  // A spell slot the feature burns is refused before anything is written, as a resource is.
  if (outcome.spend_slot !== undefined) requireSlot(sheet, actor, outcome.spend_slot, action.name);
  // And one it creates: Font of Magic and Wild Resurgence pay only once the slot is certain to appear.
  if (outcome.gain_slot !== undefined) requireSlotLevel(sheet, actor, outcome.gain_slot, action.name);
  // The Beast is looked up before the use is spent, so a form this Druid cannot take costs nothing.
  const shape = outcome.shape && 'form' in outcome.shape ? beastForm(outcome.shape.form, outcome.shape) : null;

  const log: CombatLogEntry[] = [];
  // A Rage holds no Concentration: entering one drops whatever the Barbarian was holding.
  if (handler.index === 'barbarian-rage' && !extending && actor.concentration) {
    log.push(...endConcentration(db, encounter, actor, `${actor.name} rages and cannot concentrate`));
  }
  for (const cost of costs) log.push(spendFeatureCost(db, encounter, actor, sheet, cost, action.name));
  if (outcome.d20_stance) {
    actor.flags = { ...actor.flags, d20_stance: outcome.d20_stance };
    saveCombatant(db, actor);
  }
  if (outcome.flags) {
    actor.flags = { ...actor.flags, ...outcome.flags };
    // Action Surge buys a whole second action, Extra Attack and all - but never the Magic action.
    if (outcome.flags.action_surged) {
      actor.action_used = false;
      actor.flags = { ...actor.flags, attacks_used: 0, surge_action_pending: true };
    }
    saveCombatant(db, actor);
  }
  const data: StandardActionData & Record<string, unknown> = { feature: handler.index, action: action.id };
  if (outcome.d20_stance) data.d20_stance = outcome.d20_stance;

  for (const id of outcome.standard ?? []) {
    const done = await standardAction(db, encounter, actor, id, input);
    log.push(...done.log);
    Object.assign(data, done.data);
  }
  if (outcome.movement_ft) {
    actor.movement_left += outcome.movement_ft;
    saveCombatant(db, actor);
    data.movement_left = actor.movement_left;
  }
  // Steady Aim buys its Advantage with the rest of the turn's movement.
  if (handler.index === 'rogue-steady-aim') {
    actor.movement_left = 0;
    saveCombatant(db, actor);
    data.movement_left = 0;
  }
  // The same row twice would let the stale actor overwrite the healing, so healing the self heals actor.
  const healed = target && target.id !== actor.id ? target : actor;
  const heal = outcome.heal_amount ?? (outcome.heal_expr ? rollHealing(outcome.heal_expr, sheet).total : 0);
  if (heal > 0) {
    healCombatant(db, encounter, healed, Math.max(1, heal));
    const after = getCombatant(db, encounter.id, healed.id);
    data.healed = Math.max(1, heal);
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: healed.id,
        kind: 'heal',
        payload: { action: action.name, amount: Math.max(1, heal), hp_current: after.hp_current },
        text: `${healed.name} regains ${Math.max(1, heal)} HP${partyHp(healed, ` (${after.hp_current}/${after.hp_max})`)}.`,
      }),
    );
  }
  if (outcome.temp_hp_expr && healed.character_id) {
    const rolled = rollDamage(outcome.temp_hp_expr, false);
    setPcTempHp(db, {
      campaign_id: encounter.campaign_id,
      character_id: healed.character_id,
      amount: rolled.total,
      mirror: false,
    });
    mirrorCharacter(db, healed);
    saveCombatant(db, healed);
    data.temp_hp = rolled.total;
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: healed.id,
        kind: 'temp_hp',
        payload: { action: action.name, amount: rolled.total },
        text: `${healed.name} gains ${rolled.total} temporary hit points (${rolled.output}).`,
      }),
    );
  }
  for (const condition of outcome.remove_conditions ?? []) {
    if (!healed.conditions.includes(condition)) continue;
    dropCondition(db, encounter, healed, condition);
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: healed.id,
        kind: 'condition',
        payload: { condition, active: false, feature: handler.name },
        text: `${healed.name} is no longer ${condition} (${handler.name}).`,
      }),
    );
  }
  // A condition the feature puts on its taker, for the rounds its own text gives it: Nature's Veil.
  if (outcome.self_condition) {
    const created = attachEffect(db, encounter, {
      name: outcome.self_condition.name,
      kind: 'condition',
      source_id: actor.id,
      tick: 'end',
      ends: 'rounds',
      remaining_rounds: outcome.self_condition.rounds,
      target_id: actor.id,
    });
    actor.conditions = getCombatant(db, encounter.id, actor.id).conditions;
    log.push(created.entry, ...created.landed);
  }
  // The slot a feature burns and the one it hands back: Font of Magic, Font of Inspiration, Wild Resurgence.
  if (outcome.spend_slot !== undefined && actor.character_id) {
    const spent = useSpellSlot(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      level: outcome.spend_slot,
    });
    data.spell_slots = spent.spell_slots;
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'spell_slot',
        payload: { feature: handler.name, level: outcome.spend_slot, remaining: spent.remaining },
        text: `${actor.name} burns a level ${outcome.spend_slot} slot on ${action.name} (${spent.remaining} left at that level).`,
      }),
    );
  }
  if (outcome.gain_slot !== undefined && actor.character_id) {
    const back = restoreSpellSlot(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      level: outcome.gain_slot,
    });
    data.spell_slots = back.spell_slots;
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'spell_slot',
        payload: { feature: handler.name, level: outcome.gain_slot, remaining: back.remaining, gained: true },
        text: `${actor.name} gains a level ${outcome.gain_slot} spell slot (${back.remaining} open at that level).`,
      }),
    );
  }
  // Uses handed back to another class resource: Font of Inspiration, Wild Resurgence.
  if (outcome.restore_resource && actor.character_id) {
    const back = restoreFeatureResource(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      resource: outcome.restore_resource.key,
      amount: outcome.restore_resource.amount,
    });
    if (back) {
      data.resource = { resource: back.resource, left: back.left, max: back.max };
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          kind: 'feature_resource',
          payload: { feature: handler.name, resource: back.resource, left: back.left, max: back.max },
          text: `${actor.name} gets ${outcome.restore_resource.amount} ${back.name} back: ${back.left} of ${back.max}.`,
        }),
      );
    }
  }
  // Wild Shape: into the Beast's own statistics, or back out of them.
  if (shape) {
    enterWildShape(db, encounter, actor, sheet, shape);
    data.wild_shape = { form: shape.name, ac: shape.ac, speed: shape.speed, attacks: shape.actions.map((a) => a.name) };
  }
  if (outcome.shape && 'revert' in outcome.shape) {
    log.push(...revertWildShape(db, encounter, actor, 'they drop it as a Bonus Action'));
    data.wild_shape = null;
  }
  if (outcome.temp_hp_amount !== undefined && actor.character_id) {
    setPcTempHp(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      amount: outcome.temp_hp_amount,
      mirror: false,
    });
    mirrorCharacter(db, actor);
    saveCombatant(db, actor);
    data.temp_hp = outcome.temp_hp_amount;
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'temp_hp',
        payload: { action: action.name, amount: outcome.temp_hp_amount },
        text: `${actor.name} gains ${outcome.temp_hp_amount} temporary hit points.`,
      }),
    );
  }
  // A Bardic Inspiration die is held on the sheet of whoever was inspired, not on the bard's.
  if (outcome.inspire) {
    const held = grantInspirationDie(db, {
      campaign_id: encounter.campaign_id,
      character_id: getCombatant(db, encounter.id, outcome.inspire.target_id).character_id!,
      die: outcome.inspire.die,
      from: actor.name,
    });
    data.inspiration_die = held;
  }
  if (outcome.target_flags && target) {
    const on = getCombatant(db, encounter.id, target.id);
    on.flags = { ...on.flags, ...outcome.target_flags };
    saveCombatant(db, on);
    target.flags = on.flags;
  }
  // Hit points poured into named creatures: Preserve Life, Land's Aid, Divine Spark.
  const healedRows: Array<Record<string, unknown>> = [];
  for (const pour of outcome.heals ?? []) {
    const who = getCombatant(db, encounter.id, pour.target_id);
    const rolled = pour.expr ? rollHealing(pour.expr, sheet) : null;
    const amount = Math.max(0, pour.amount ?? rolled?.total ?? 0);
    if (amount <= 0) continue;
    healCombatant(db, encounter, who, amount);
    const after = getCombatant(db, encounter.id, who.id);
    healedRows.push({ target_id: who.id, name: who.name, healed: amount, hp_current: after.hp_current });
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: who.id,
        kind: 'heal',
        payload: { action: action.name, amount, hp_current: after.hp_current },
        text: `${who.name} regains ${amount} HP${rolled ? ` (${rolled.output})` : ''}${partyHp(who, ` (${after.hp_current}/${after.hp_max})`)}.`,
      }),
    );
  }
  if (healedRows.length) data.healed_targets = healedRows;
  // The saving throw a feature's action forces: Divine Spark, Turn Undead, Land's Aid.
  const saveRows: Array<Record<string, unknown>> = [];
  for (const id of outcome.save?.target_ids ?? []) {
    const forced = outcome.save!;
    const who = getCombatant(db, encounter.id, id);
    const save = await rollSave(db, encounter, who, forced.ability, forced.dc, {
      roll: input.rolls?.[String(id)],
      tool: 'use_action',
    });
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: who.id,
        kind: 'save',
        payload: { action: action.name, save },
        text: `${who.name} rolls ${save.total} on a ${forced.ability.toUpperCase()} save vs DC ${forced.dc}: ${
          save.success ? 'success' : 'failure'
        }.`,
      }),
    );
    const row: Record<string, unknown> = { target_id: who.id, name: who.name, save };
    if (forced.damage_expr && (!save.success || forced.half_on_save)) {
      const rolled = rollDamage(forced.damage_expr, false);
      const amount = save.success ? Math.floor(rolled.total / 2) : rolled.total;
      const result = damageCombatant(db, encounter, who, {
        amount,
        type: forced.damage_type ?? null,
        source: `${actor.name}'s ${action.name}`,
      });
      row.damage = result;
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: who.id,
          kind: 'damage',
          payload: { action: action.name, ...result, type: forced.damage_type ?? null, expr: rolled.expr },
          text: `${who.name} takes ${result.applied} ${forced.damage_type ?? ''} damage (${rolled.output})${partyHp(who, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      log.push(...(await afterDamage(db, encounter, who, result.applied, 'use_action')));
      if (result.dead) log.push(...afterKill(db, encounter, who, actor, `${actor.name}'s ${action.name}`));
    }
    if (!save.success && forced.extra_expr) {
      const rolled = rollDamage(forced.extra_expr, false);
      const result = damageCombatant(db, encounter, who, {
        amount: rolled.total,
        type: forced.extra_type ?? null,
        source: `${actor.name}'s ${forced.extra_note ?? action.name}`,
      });
      row.extra_damage = result;
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: who.id,
          kind: 'feature_damage',
          payload: { feature: forced.extra_note ?? action.name, ...result, type: forced.extra_type ?? null, expr: rolled.expr },
          text: `${forced.extra_note ?? action.name}: ${who.name} takes ${result.applied} ${forced.extra_type ?? ''} damage (${rolled.output})${partyHp(who, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      if (result.dead) log.push(...afterKill(db, encounter, who, actor, `${actor.name}'s ${forced.extra_note ?? action.name}`));
    }
    if (!save.success) {
      const laid: number[] = [];
      for (const condition of forced.conditions ?? []) {
        const immune = immuneTo(db, encounter, who, condition);
        if (immune) {
          log.push(
            logCombat(db, encounter, {
              actor_id: actor.id,
              target_id: who.id,
              kind: 'note',
              payload: { condition, immune: true },
              text: `${immune} ${action.name} leaves no ${condition} on it.`,
            }),
          );
          continue;
        }
        const created = attachEffect(db, encounter, {
          name: condition,
          kind: 'condition',
          source_id: actor.id,
          tick: 'end',
          // A minute is a minute: Turn Undead's own text gives no repeat save, only the end on damage.
          // Intimidating Presence and its like say otherwise, and ask for the save at each turn's end.
          ...(forced.ends === 'minute'
            ? forced.repeat_save
              ? {
                  ends: 'save' as const,
                  save_ability: forced.ability,
                  save_dc: forced.dc,
                  remaining_rounds: 10,
                }
              : { ends: 'rounds' as const, remaining_rounds: 10 }
            : forced.ends === 'start_of_next_turn'
              ? { tick: 'start' as const, ends: 'rounds' as const, remaining_rounds: 1 }
              : { ends: 'manual' as const }),
          target_id: who.id,
        });
        laid.push(created.effect.id);
        log.push(created.entry, ...created.landed);
      }
      if (forced.ends_on_damage && laid.length > 0) {
        const fresh = getCombatant(db, encounter.id, who.id);
        fresh.flags = { ...fresh.flags, turned: { effect_ids: laid, feature: action.name } };
        saveCombatant(db, fresh);
      }
    }
    saveRows.push(row);
  }
  if (saveRows.length) data.save_targets = saveRows;

  if (outcome.restore_focus && actor.character_id) {
    const back = restoreFeatureResource(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      resource: 'focus_points',
    });
    if (back) data.focus_points = back.max;
  }
  if (outcome.grant_inspiration && actor.kind === 'pc') {
    grantInspiration(db, { campaign_id: encounter.campaign_id, character_id: actor.character_id ?? undefined });
    data.inspiration = 1;
  }
  if (outcome.read_traits && target) {
    const lines = damageLinesOf(db, target);
    data.traits = {
      name: target.name,
      resistances: lines?.damage_resistances ?? '',
      immunities: lines?.damage_immunities ?? '',
      vulnerabilities: lines?.damage_vulnerabilities ?? '',
    };
  }

  log.push(
    logCombat(db, encounter, {
      actor_id: actor.id,
      ...(target ? { target_id: target.id } : {}),
      kind: 'feature_action',
      payload: { feature: handler.index, action: action.id, ...(outcome.notes ? { notes: outcome.notes } : {}) },
      text: reactionText(reaction, `${outcome.text}${outcome.notes?.length ? ` ${outcome.notes.join(' ')}` : ''}`),
    }),
  );

  if (outcome.economy === 'action' || outcome.economy === 'bonus_action') {
    spendResource(actor, outcome.economy === 'bonus_action' ? 'bonus' : 'action', input.out_of_turn);
  }
  if (outcome.economy === 'reaction') actor.reaction_used = true;
  // The feature may have healed or hurt its own taker: keep what the row says over what this object holds.
  refreshVitals(db, encounter, actor);
  saveCombatant(db, actor);

  return finish(db, encounter, 'use_action', `${actor.name} uses ${action.name}.`, log, {
    actor_id: actor.id,
    action: action.id,
    targets: [] as Array<Record<string, unknown>>,
    ...data,
    ...(outcome.notes ? { notes: outcome.notes } : {}),
    class_features: classFeatures(sheet, getCombatant(db, encounter.id, actor.id)),
    ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
  });
}

/**
 * Deflect Attacks, second half: a hit the Monk took to 0 may have its force thrown back for 1 Focus
 * Point. It is part of the reaction the deflection already spent, so it asks for no second one.
 */
async function runDeflectRedirect(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet | null,
  input: { target_id?: number; roll?: PreRoll },
) {
  if (!sheet || !hasFeature(sheet, 'monk-deflect-attacks')) {
    throw new Error(`${actor.name} has no Deflect Attacks, so there is nothing to redirect.`);
  }
  const window = actor.flags.deflect_redirect;
  if (!window) {
    throw new Error(
      `${actor.name} has no deflected attack to throw back: the redirect is offered under Offers on a hit Deflect Attacks took to 0, and only until the next turn.`,
    );
  }
  const cost: FeatureCost = { resource: 'focus_points', amount: 1 };
  requireResource(sheet, actor, cost, 'the Deflect Attacks redirect');
  const target = getCombatant(db, encounter.id, input.target_id ?? window.attacker_id);
  if (!target.alive) throw new Error(`${target.name} is already dead.`);
  const away = distanceBetween(actor, target);
  if (away > window.within_ft) {
    throw new Error(
      `The deflected force reaches ${window.within_ft} ft and ${target.name} is ${away} ft away. Name a creature within ${window.within_ft} ft with target_id.`,
    );
  }
  // The redirect needs a creature the Monk can see: total cover is no line of sight at all.
  const seen = coverBetween(encounterMap(encounter), listCombatants(db, encounter.id), actor, target);
  if (!seen.line_of_sight) {
    throw new Error(
      `${target.name} has total cover from ${actor.name}, and the deflected force needs a creature you can see. Name another with target_id.`,
    );
  }
  const dc = 8 + sheetAbilityMod(sheet, 'wis') + sheet.proficiency_bonus;
  const expr = `2d${resourceMax(sheet, 'martial_arts_die')}${signed(sheetAbilityMod(sheet, 'dex'))}`;
  const log: CombatLogEntry[] = [spendFeatureCost(db, encounter, actor, sheet, cost, 'Deflect Attacks')];
  const save = await rollSave(db, encounter, target, 'dex', dc, { roll: input.roll, tool: 'use_action' });
  let damage: DamageResult | null = null;
  if (!save.success) {
    const rolled = rollDamage(expr, false);
    damage = damageCombatant(db, encounter, target, {
      amount: rolled.total,
      type: window.damage_type,
      source: `${actor.name}'s Deflect Attacks`,
    });
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'feature_damage',
        payload: { feature: 'Deflect Attacks', ...damage, type: window.damage_type, expr: rolled.expr, save },
        text: `${actor.name} throws the deflected force at ${target.name}, who fails a DEX save (${save.total} vs DC ${dc}) and takes ${damage.applied} (${rolled.output})${partyHp(target, ` - ${damage.hp_current}/${damage.hp_max} HP`)}.`,
      }),
    );
    log.push(...(await afterDamage(db, encounter, target, damage.applied, 'use_action')));
    if (damage.dead) log.push(killEntry(db, encounter, target, `${actor.name}'s Deflect Attacks`));
  } else {
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'feature_save',
        payload: { feature: 'Deflect Attacks', save, applied: false },
        text: `${target.name} slips the deflected force (DEX save ${save.total} vs DC ${dc}).`,
      }),
    );
  }
  actor.flags = { ...actor.flags, deflect_redirect: undefined };
  saveCombatant(db, actor);
  return finish(db, encounter, 'use_action', `${actor.name} redirects a deflected attack.`, log, {
    actor_id: actor.id,
    action: 'deflect_redirect',
    targets: [{ target_id: target.id, name: target.name, save, damage }],
    class_features: classFeatures(sheet, getCombatant(db, encounter.id, actor.id)),
  });
}

export async function useAction(db: Db, input: Parameters<typeof runUseAction>[1]) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'use_action', () => runUseAction(db, input));
}

async function runUseAction(
  db: Db,
  input: {
    campaign_id: number;
    actor_id: number;
    action_name: string;
    target_id?: number;
    point?: Point;
    shape?: AoeShape;
    damage_expr?: string;
    damage_type?: string;
    save_ability?: Ability;
    save_dc?: number;
    half_on_save?: boolean;
    heal_expr?: string;
    concentration?: boolean;
    effect?: Omit<EffectInput, 'target_id'>;
    out_of_turn?: boolean;
    reason?: string;
    rolls?: Record<string, PreRoll>;
    /** The d20 for a spell attack roll, when the player rolled it themselves. */
    roll?: PreRoll;
    advantage?: Advantage;
    /** An SRD spell name: its dice, save, DC, area, range, concentration and duration are read from the entry. */
    spell?: string;
    /** The slot to cast it with; defaults to the spell's own level. */
    slot_level?: number;
    /** Lay On Hands: how many hit points to pour out of the pool. */
    amount?: number;
    /** Which of a feature's options to take: "poison" for Lay On Hands, the weapon for Sacred Weapon. */
    option?: string;
    /** Sorcerer: the Metamagic options this casting is bent with. */
    metamagic?: string[];
    /** Evoker: the creatures Sculpt Spells carves out of the evocation. */
    sculpt?: number[];
    /** Careful Spell: the creatures the caster protects from their own spell. */
    careful_targets?: number[];
    /** Twinned Spell: the second creature the spell reaches. */
    twin_target?: number;
    /** Heightened Spell: the creature that saves with Disadvantage. */
    heighten_target?: number;
    /** Transmuted Spell: the damage type the spell deals instead of its own. */
    transmute_to?: string;
    /** The feature paying for this casting instead of a spell slot. */
    free_cast?: NamedFreeCast;
    /** Evoker 14 Overchannel: a damaging Wizard spell of slot level 1 to 5 deals its maximum damage. */
    overchannel?: boolean;
    /** Homebrew clauses the actor chose for this action, by their boost id; each is spent up front. */
    boosts?: string[];
    /** Internal handoff: a feature action whose payload uses the shared custom-spell resolver below. */
    _feature_effect?: { outcome: FeatureOutcome; handler: FeatureHandler; action: FeatureAction };
  } & StandardActionInput,
) {
  const encounter = requireEncounter(db, input.campaign_id);
  const actor = getCombatant(db, encounter.id, input.actor_id);
  if (!actor.alive || actor.hp_current === 0) throw new Error(`${actor.name} is down and cannot act.`);
  refuseIfIncapacitated(actor);
  requireTurn(db, encounter, actor, input.out_of_turn);
  const sheet = sheetOf(db, actor);
  const wantedFeature = input.action_name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  // The Deflect Attacks redirect rides on the reaction already spent on the deflection, not on a new one.
  if (wantedFeature === 'deflect_redirect') return await runDeflectRedirect(db, encounter, actor, sheet, input);
  const reaction = requireReaction(actor, input.out_of_turn, input.reason);
  const known = actionsFor(actor, sheet).find((a) => a.name.toLowerCase() === input.action_name.trim().toLowerCase());
  // Dash, Dodge, Disengage, Help, Hide, Ready, Utilize, standing up, grappling, shoving and escaping.
  const standard = standardId(input.action_name);
  // A class feature with an action of its own comes first: rage, second_wind, flurry_of_blows, lay_on_hands.
  const feature = !input._feature_effect && !standard && sheet ? findFeatureAction(sheet, input.action_name) : null;
  if (feature && sheet) return await runFeatureActionCall(db, encounter, actor, sheet, feature, input, reaction);

  if (standard) {
    // Standing up costs half the speed as movement and no action, so it is legal after the Action is spent.
    const freeOfEconomy = standard === 'stand';
    if (!input.out_of_turn && !freeOfEconomy) {
      requireEconomy(actor, known?.kind === 'bonus_action' ? 'bonus' : 'action', input.action_name);
    }
    const released = releaseReady(db, encounter, actor, reaction);
    const done = await standardAction(db, encounter, actor, standard, input);
    // Standing up is movement, not the Action; out of turn it still costs the reaction.
    if (!freeOfEconomy || input.out_of_turn) spendResource(actor, 'action', input.out_of_turn);
    saveCombatant(db, actor);
    const entries = [...released, ...done.log];
    return finish(
      db,
      encounter,
      'use_action',
      `${actor.name} uses ${STANDARD_ACTIONS[standard]!.label}.`,
      entries,
      {
        actor_id: actor.id,
        action: standard,
        // The same shape a spell or an area answers with, so one caller reads both.
        targets: [] as Array<Record<string, unknown>>,
        ...(done.data as StandardActionData),
        ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
      },
    );
  }

  return runGenericUseAction(db, input, encounter, actor, sheet, reaction, known);
}

async function runGenericUseAction(
  db: Db,
  input: Parameters<typeof runUseAction>[1],
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet | null,
  reaction: string | null,
  known: ReturnType<typeof actionsFor>[number] | undefined,
) {
  const wantedFeature = input.action_name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const combatants = listCombatants(db, encounter.id);
  const map = encounterMap(encounter);

  // A spell the DM wrote is executed from its own schema; anything the caller passed still wins.
  const declaredEffect = input._feature_effect?.outcome.action_effect;
  const custom = declaredEffect
    ? {
        kind: declaredEffect.effect.kind,
        ...(declaredEffect.effect.kind === 'attack' ? { attack_roll: true } : {}),
        ...(declaredEffect.effect.damage
          ? { damage_expr: declaredEffect.effect.damage.dice, damage_type: declaredEffect.effect.damage.type }
          : {}),
        ...(declaredEffect.effect.save_ability ? { save_ability: declaredEffect.effect.save_ability } : {}),
        ...(declaredEffect.effect.save_ability && sheet?.spells.save_dc !== null
          ? { save_dc: sheet?.spells.save_dc ?? undefined }
          : {}),
        ...(declaredEffect.effect.half_on_save === undefined
          ? {}
          : { half_on_save: declaredEffect.effect.half_on_save }),
        ...(declaredEffect.effect.shape ? { shape: declaredEffect.effect.shape } : {}),
        ...(declaredEffect.effect.healing ? { heal_expr: declaredEffect.effect.healing.dice } : {}),
        ...(declaredEffect.concentration ? { concentration: true } : {}),
        ...(declaredEffect.effect.targets === undefined ? {} : { targets: declaredEffect.effect.targets }),
        ...(declaredEffect.effect.condition
          ? {
              effect: {
                name: declaredEffect.effect.condition.name.trim().toLowerCase(),
                kind: 'condition' as const,
                tick: 'end' as const,
                ends: declaredEffect.concentration
                  ? ('concentration' as const)
                  : declaredEffect.duration_rounds
                    ? ('rounds' as const)
                    : ('manual' as const),
                ...(declaredEffect.duration_rounds ? { remaining_rounds: declaredEffect.duration_rounds } : {}),
              },
            }
          : {}),
      }
    : sheet
      ? customSpellAction(db, encounter.campaign_id, input.action_name, sheet.spells.save_dc)
      : null;
  const spell = input.spell && !custom ? spellFill(input.spell, sheet, input.slot_level) : null;
  if (input.spell && !spell && !custom) {
    throw new Error(
      `No SRD spell called "${input.spell}". Look it up with srd_lookup {kind: "spell"}, or pass the dice and the DC yourself.`,
    );
  }
  if (spell && sheet?.armor_penalty.penalty) {
    throw new Error(`${actor.name} cannot cast ${spell.name}: ${sheet.armor_penalty.reason}.`);
  }
  // A raging Barbarian casts nothing and concentrates on nothing, spell or hand-written action.
  if ((spell || custom || input.concentration) && isRaging(actor)) {
    throw new Error(
      `${actor.name} is raging and cannot cast spells or hold Concentration. End the Rage first, or do something else with the action.`,
    );
  }
  // A Druid in a Beast form casts nothing either, until Beast Spells at level 18 says otherwise.
  if ((spell || custom) && isWildShaped(actor) && !(sheet && hasFeature(sheet, 'druid-beast-spells'))) {
    throw new Error(
      `${actor.name} is in the ${actor.flags.wild_shape!.form} form and cannot cast spells. Drop the form first with use_action {action_name: "wild_shape_revert"}.`,
    );
  }
  // A name shaped like a class feature action, that this character cannot take, is refused rather than
  // narrated into being: the generic path below would spend the Action on nothing at all.
  const idShaped = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(input.action_name.trim());
  if (!known && !custom && !input.spell && (idShaped || allFeatureActionIds().includes(wantedFeature))) {
    const mine = sheet ? featureActionIds(sheet) : [];
    throw new Error(
      `${actor.name} has no class feature action called "${wantedFeature}". ${
        mine.length ? `They may take: ${mine.join(', ')}.` : 'They have no class feature actions at all.'
      } Anything else is named in words, with its own dice and DC.`,
    );
  }
  // What the casting costs: the spell's own casting time, or the entry's kind for everything else.
  const customCastingTime = custom
    ? input._feature_effect
      ? input._feature_effect.outcome.economy === 'bonus_action'
        ? 'bonus action'
        : input._feature_effect.outcome.economy === 'reaction'
          ? 'reaction'
          : 'action'
      : ((findHomebrewSpell(db, encounter.campaign_id, input.action_name)?.schema as { casting_time?: string } | undefined)
          ?.casting_time ?? 'action')
    : null;
  // Wild Companion and Pact of the Chain cast Find Familiar as a Magic action, its own hour notwithstanding.
  const freeCastEconomy = input.free_cast ? FREE_CAST_ECONOMY[input.free_cast] : undefined;
  if (spell && freeCastEconomy) spell.economy = freeCastEconomy;
  const casting: CastingEconomy | 'free' | null = input._feature_effect?.outcome.economy === 'free'
    ? 'free'
    : spell
    ? spell.economy
    : customCastingTime !== null
      ? castingEconomy(customCastingTime)
      : null;
  if (casting === 'long') {
    throw new Error(
      `${spell?.name ?? input.action_name} takes ${(spell?.casting_time ?? customCastingTime ?? '').replace(
        /^(\d+)/,
        '$1 ',
      )} to cast; not in a fight - package R8 will handle long casting times. Cast it between encounters.`,
    );
  }
  if (casting === 'reaction' && !input.out_of_turn) {
    throw new Error(
      `${spell?.name ?? input.action_name} is cast as a Reaction: pass out_of_turn true with reason naming what triggered it.`,
    );
  }
  // Divine Smite rides on the melee hit that has just landed, inside the same turn.
  const smiting = spell !== null && /^divine smite$/i.test(spell.name);
  if (smiting) {
    const ready = actor.flags.smite_ready;
    if (!ready) {
      throw new Error(
        `Divine Smite is cast after hitting with a melee weapon or an Unarmed Strike; ${actor.name} has not landed one this turn. Attack first, then smite the creature the hit's log names as ready.`,
      );
    }
    if (input.target_id !== undefined && input.target_id !== ready.target_id) {
      throw new Error(
        `Divine Smite lands on the creature just hit (combatant ${ready.target_id}), not on ${input.target_id}.`,
      );
    }
    input.target_id = ready.target_id;
  }
  // Divine Smite carries the criticality of the melee hit that armed it; every other cast reads its own roll.
  const smiteCritical = smiting && actor.flags.smite_ready?.critical === true;
  // Hunter's Mark marks its quarry; the extra 1d6 rides on every later weapon hit, not on the casting.
  const marking = spell !== null && /hunter.s mark/i.test(spell.name);
  if (marking && spell) {
    spell.attack_roll = false;
    spell.damage_expr = undefined;
  }
  let damageExpr = input.damage_expr ?? custom?.damage_expr ?? spell?.damage_expr ?? known?.damage?.[0]?.dice;
  const shape = input.shape ?? custom?.shape ?? spell?.shape;
  const healExpr = input.heal_expr ?? custom?.heal_expr ?? spell?.heal_expr;
  const concentration = input.concentration ?? custom?.concentration ?? spell?.concentration;

  // The targets come first now: Metamagic and Sculpt Spells name creatures, and what the casting costs
  // is settled only once the plan below has had its say.
  let targets: Combatant[];
  if (input.point && shape) {
    const point = input.point;
    const hit = aoeTargets(combatants, { x: actor.x, y: actor.y }, point, shape);
    targets = hit.map((t) => combatants.find((c) => c.id === t.id)!);
    // A healing area reaches only the caster's team, never an enemy standing in it. A text cap such as
    // "up to six creatures" keeps the nearest allies, ties by combatant id.
    if (healExpr !== undefined && !damageExpr) {
      targets = targets.filter((c) => c.team === actor.team);
      const cap = spell
        ? findSpell(spell.name)?.desc.match(/\bup to\s+(two|three|four|five|six|\d+)\s+creatures?\b/i)
        : null;
      const limit = cap ? (COUNT_WORDS[cap[1]!.toLowerCase()] ?? Number(cap[1])) : null;
      if (limit !== null && targets.length > limit) {
        const origin = shape.kind === 'cone' || shape.kind === 'line' ? { x: actor.x, y: actor.y } : point;
        const away = (c: Combatant): number => Math.hypot(c.x - origin.x, c.y - origin.y);
        targets = [...targets].sort((a, b) => away(a) - away(b) || a.id - b.id).slice(0, limit);
      }
    }
  } else if (input.target_id !== undefined) {
    targets = [getCombatant(db, encounter.id, input.target_id)];
  } else {
    targets = [];
  }
  if (custom) {
    if (shape && !input.point) throw new Error(`${input.action_name} has a ${shape.kind} area: pass point for its origin.`);
    if (input.point && !shape) throw new Error(`${input.action_name} has no area shape, so point cannot place it.`);
    const needsTarget = custom.kind !== 'utility' || custom.effect !== undefined;
    if (needsTarget && targets.length === 0) throw new Error(`${input.action_name} needs target_id${shape ? ' or point' : ''}.`);
    if (custom?.targets !== undefined && targets.length > custom.targets) {
      throw new Error(`${input.action_name} affects at most ${custom.targets} target${custom.targets === 1 ? '' : 's'}; this point reaches ${targets.length}.`);
    }
    if (declaredEffect && !shape && (custom.targets ?? 1) > 1) {
      throw new Error(`${input.action_name} names ${custom.targets} targets, but use_action accepts one target_id.`);
    }
    if (custom.kind === 'save' && !custom.save_ability) {
      throw new Error(`${input.action_name} is a save effect and needs save_ability.`);
    }
    if (custom.kind === 'save' && custom.save_dc === undefined) {
      throw new Error(`${actor.name} has no spell save DC for ${input.action_name}.`);
    }
    if (custom.kind === 'heal' && !custom.heal_expr) {
      throw new Error(`${input.action_name} is a healing effect and needs healing dice.`);
    }
    if (
      (custom.kind === 'attack' || custom.kind === 'auto') &&
      !custom.damage_expr &&
      !custom.effect
    ) {
      throw new Error(`${input.action_name} needs damage or a condition; use utility for one that does neither.`);
    }
  }

  const options: CastOptions = {
    metamagic: input.metamagic ?? [],
    ...(input.sculpt ? { sculpt: input.sculpt } : {}),
    ...(input.careful_targets ? { careful_targets: input.careful_targets } : {}),
    ...(input.twin_target === undefined ? {} : { twin_target: input.twin_target }),
    ...(input.heighten_target === undefined ? {} : { heighten_target: input.heighten_target }),
    ...(input.transmute_to ? { transmute_to: input.transmute_to } : {}),
  };
  if (options.metamagic.length > 0 || options.sculpt?.length) {
    if (!spell || !sheet) {
      throw new Error('Metamagic and Sculpt Spells shape an SRD spell: pass spell with its name.');
    }
  }
  if (sheet) requireMetamagic(sheet, actor, options.metamagic, input.damage_expr);
  const saveAbility = input.save_ability ?? custom?.save_ability ?? spell?.save_ability;
  // The casting's own moment, so a clause narrowed to an attack or to this spell is on offer here. It is
  // read, refused and marked before the plan: what the DM took is part of what the plan works out, and
  // the use it costs rides on the modifier, paid for with everything else the casting spends.
  const castBoostCtx: Omit<ClauseCtx, 'sheet'> = {
    source: spell ? 'spell' : undefined,
    ...(spell?.attack_roll && !saveAbility ? { kind: 'attack' as const } : {}),
    ...(targets[0] ? { target: targets[0] } : {}),
    ...(spell ? { spell: { name: spell.name, school: spell.school, level: spell.level } } : {}),
    ...(spell ? { melee: (spell.range_ft ?? 0) <= 5 } : {}),
  };
  // Read before they are paid for, so what the DM took is on the roll this casting makes.
  const castTaken = sheet
    ? boostsFor(sheet, sheet.features, castBoostCtx, CAST_HOOKS).filter((one) => (input.boosts ?? []).includes(one.id))
    : [];
  const castBoostLog = spendChosenBoosts(db, encounter, actor, sheet, input.boosts, castBoostCtx, CAST_HOOKS);
  const plan =
    spell && sheet
      ? planCast(sheet, actor, spell, targets, options, {
          save_dc: input.save_dc ?? custom?.save_dc ?? spell.save_dc,
          damage_type: input.damage_type ?? custom?.damage_type ?? spell.damage_type ?? null,
        })
      : null;
  // Twinned Spell casts the spell a level higher, which is what buys the second creature.
  if (plan && plan.slot_increase > 0 && spell) {
    if (spell.slot_level === null) {
      throw new Error(
        `${spell.name} is a cantrip, and Twinned Spell raises a spell's level with a slot: name a level 1+ spell.`,
      );
    }
    const higher = spellFill(spell.name, sheet, spell.slot_level + plan.slot_increase)!;
    spell.slot_level = higher.slot_level;
    spell.damage_expr = higher.damage_expr;
    spell.notes.push(...higher.notes.filter((note) => !spell.notes.includes(note)));
    damageExpr = input.damage_expr ?? higher.damage_expr ?? damageExpr;
  }
  for (const extra of plan?.extra_targets ?? []) {
    if (targets.some((t) => t.id === extra.id)) continue;
    const second = getCombatant(db, encounter.id, extra.id);
    const first = targets[0];
    if (extra.within_ft !== undefined && first) {
      const away = distanceBetween(first, second);
      if (away > extra.within_ft) {
        throw new Error(
          `${extra.feature} reaches a second creature within ${extra.within_ft} ft of ${first.name}, and ${second.name} is ${away} ft away.`,
        );
      }
    }
    targets.push(second);
  }
  if (plan && spell && plan.duration_multiplier > 1 && spell.duration_rounds) {
    spell.duration_rounds *= plan.duration_multiplier;
  }

  const damageType = plan?.damage_type ?? input.damage_type ?? custom?.damage_type ?? spell?.damage_type ?? known?.damage?.[0]?.type ?? null;
  const saveDc = plan?.save_dc ?? input.save_dc ?? custom?.save_dc ?? spell?.save_dc;
  const halfOnSave = input.half_on_save ?? custom?.half_on_save ?? spell?.half_on_save;

  // What the casting costs, after Quickened Spell has had its say.
  const economy: CastingEconomy | 'free' | null = plan ? plan.economy : casting;
  const spends: 'action' | 'bonus' =
    economy === 'bonus_action' || (economy === null && known?.kind === 'bonus_action') ? 'bonus' : 'action';
  // Action Surge buys one more action on this turn, and the SRD excepts the Magic action from it.
  if (economy !== null && spends === 'action' && !input.out_of_turn && actor.flags.surge_action_pending) {
    throw new Error(
      `Action Surge gives ${actor.name} one more action, the Magic action excepted, so ${
        spell?.name ?? input.action_name
      } cannot be cast with it. Spend the surged action on something else, and cast on another turn.`,
    );
  }
  // Quickened Spell: no level 1+ spell before it on this turn, and none after it either.
  const quickened = plan?.modifiers.some((modifier) => modifier.feature === 'Quickened Spell') ?? false;
  const levelled = spell !== null && spell.level >= 1;
  if (quickened && actor.flags.cast_levelled_spell) {
    throw new Error(
      `${actor.name} has already cast a level 1+ spell this turn, and Quickened Spell may not follow one. Cast it plainly, or wait for your next turn.`,
    );
  }
  if (levelled && actor.flags.quickened_this_turn) {
    throw new Error(
      `${actor.name} quickened a spell this turn, and no level 1+ spell may follow it. Take another action, or wait for your next turn.`,
    );
  }
  if (!input.out_of_turn && economy !== 'free' && economy !== 'reaction') requireEconomy(actor, spends, input.action_name);

  const fromSpell: Omit<EffectInput, 'target_id'> | undefined =
    input.effect && spell && input.effect.ends === undefined
      ? {
          ...input.effect,
          ...(concentration
            ? { ends: 'concentration' as const }
            : spell.duration_rounds
              ? { ends: 'rounds' as const, remaining_rounds: input.effect.remaining_rounds ?? spell.duration_rounds }
              : {}),
        }
      : input.effect;
  const markEffect: Omit<EffectInput, 'target_id'> | undefined = marking
    ? { name: "Hunter's Mark", kind: 'buff', tick: 'end', ends: 'concentration' }
    : undefined;
  const ongoing: Omit<EffectInput, 'target_id'> | undefined = fromSpell ?? custom?.effect ?? markEffect;

  // Range is checked before the slot is spent: a cast the engine refuses must cost nothing.
  const reachOfSpell = plan?.range_ft ?? spell?.range_ft ?? null;
  if (reachOfSpell !== null && spell) {
    const reach = input.point
      ? distanceToPoint(actor, input.point)
      : input.target_id === undefined
        ? 0
        : distanceBetween(actor, getCombatant(db, encounter.id, input.target_id));
    if (reach > reachOfSpell) {
      throw new Error(`${spell.name} reaches ${reachOfSpell} ft and the target is ${reach} ft away; move closer first.`);
    }
  }
  if (declaredEffect?.range_ft !== null && declaredEffect?.range_ft !== undefined && targets.length > 0) {
    const reach = input.point ? distanceToPoint(actor, input.point) : distanceBetween(actor, targets[0]!);
    if (reach > declaredEffect.range_ft) {
      throw new Error(`${input.action_name} reaches ${declaredEffect.range_ft} ft and the target is ${reach} ft away; move closer first.`);
    }
  }

  // Overchannel: everything it needs is checked here, before a slot or a sorcery point has moved.
  const overchannel = input.overchannel === true;
  let backlash = 0;
  if (overchannel) {
    if (!sheet || !hasFeature(sheet, 'evoker-overchannel')) {
      throw new Error(`${actor.name} has no Overchannel; it is an Evoker feature taken at Wizard level 14.`);
    }
    if (!spell || spell.slot_level === null || spell.slot_level > 5) {
      throw new Error('Overchannel empowers an SRD Wizard spell cast with a slot of level 1 to 5: pass spell and slot_level.');
    }
    if (!spell.classes.some((entry) => entry.endsWith('_wizard'))) {
      throw new Error(`Overchannel empowers a Wizard spell, and ${spell.name} is not on the Wizard list.`);
    }
    if (!damageExpr) throw new Error(`${spell.name} deals no damage, so there is nothing for Overchannel to maximise.`);
    requireResource(sheet, actor, { resource: 'overchannel', amount: 1 }, 'Overchannel');
    // The first use each long rest is free; every one after it burns the Evoker, a die more each time.
    const already = sheet.features.find((entry) => entry.mechanics?.resource === 'overchannel')?.mechanics?.used ?? 0;
    backlash = already === 0 ? 0 : (1 + already) * spell.slot_level;
  }

  const prelude: CombatLogEntry[] = [];
  if (input._feature_effect && sheet) {
    const costs = input._feature_effect.outcome.spend
      ? Array.isArray(input._feature_effect.outcome.spend)
        ? input._feature_effect.outcome.spend
        : [input._feature_effect.outcome.spend]
      : [];
    for (const cost of costs) requireResource(sheet, actor, cost, input._feature_effect.action.name);
    for (const cost of costs) {
      prelude.push(spendFeatureCost(db, encounter, actor, sheet, cost, input._feature_effect.action.name));
    }
  }
  let familiar: { form: string; feature: string } | null = null;
  if (spell) {
    // Every refusal happens before a single spend: a casting the engine turns down has to cost nothing.
    // A feature that pays for the whole casting: Divine Intervention and Natural Recovery, named outright.
    const named = input.free_cast && sheet ? planNamedFreeCast(actor, sheet, spell, input.free_cast, input.option) : null;
    // Paladin's Smite and Favored Enemy pay for a casting a long rest out of their own feature, not a slot.
    const free = input.slot_level === undefined && sheet && !input.free_cast ? freeCastOf(sheet, spell.name) : null;
    if (free) {
      spell.slot_level = null;
      spell.notes.push(`${free.feature}: this casting costs no spell slot.`);
    }
    // One spell slot a turn: a cast that would spend a second one is refused, while a cantrip or a
    // feature that pays for the casting itself (slot_level null) spends nothing and stays allowed.
    if (spell.slot_level !== null && spentSlotThisTurn(actor)) {
      throw new Error(
        `${actor.name} has already expended a spell slot this turn, and a turn allows only one: ${spell.name} has to wait for their next turn.`,
      );
    }
    requireSlotFor(actor, sheet, spell);
    if (plan?.notes.length) spell.notes.push(...plan.notes);
    // Nothing can refuse the casting now, so the feature uses, the sorcery points and the slot go together.
    if (named?.cost && sheet) prelude.push(spendFeatureCost(db, encounter, actor, sheet, named.cost, named.feature));
    if (free?.resource && sheet) {
      prelude.push(spendFeatureCost(db, encounter, actor, sheet, { resource: free.resource, amount: 1 }, free.feature));
    }
    for (const { feature, ...cost } of plan?.costs ?? []) {
      if (!sheet) break;
      prelude.push(spendFeatureCost(db, encounter, actor, sheet, cost, feature));
    }
    const slotEntry = spendSlotFor(db, encounter, actor, sheet, spell);
    if (slotEntry) prelude.push(slotEntry);
    if (overchannel && sheet) {
      prelude.push(spendFeatureCost(db, encounter, actor, sheet, { resource: 'overchannel', amount: 1 }, 'Overchannel'));
      spell.notes.push(
        `Overchannel: ${spell.name} deals its maximum damage${backlash ? `, and ${backlash}d12 Necrotic comes back on the caster` : ' with no adverse effect this time'}.`,
      );
    }
    if (named?.familiar) familiar = { form: named.familiar, feature: named.feature };
    if (spell.notes.length > 0) {
      prelude.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          kind: 'spell_entry',
          payload: { spell: spell.name, level: spell.level, slot_level: spell.slot_level, notes: spell.notes },
          text: `${spell.name}: ${spell.notes.join('; ')}.`,
        }),
      );
    }
  }
  const typeNote = damageTypeNote(input.damage_type);
  if (typeNote) {
    prelude.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'note',
        payload: { damage_type: input.damage_type },
        text: typeNote,
      }),
    );
  }
  prelude.push(...castBoostLog);
  prelude.push(...revealHidden(db, encounter, actor, `casts ${input.action_name}`));
  prelude.push(...releaseReady(db, encounter, actor, reaction));
  // A second concentration spell ends the first, effects and all - the same spell recast included.
  if (concentration && actor.concentration) {
    prelude.push(...endConcentration(db, encounter, actor, `${actor.name} starts concentrating on ${input.action_name}`));
  }

  const log: CombatLogEntry[] = [
    ...prelude,
    logCombat(db, encounter, {
      actor_id: actor.id,
      kind: 'action',
      payload: {
        action: input.action_name,
        point: input.point ?? null,
        shape: shape ?? null,
        targets: targets.map((t) => t.id),
        ...(spell ? { spell: spell.name, slot_level: spell.slot_level, damage_expr: damageExpr ?? null } : {}),
        ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
      },
      text: reactionText(
        reaction,
        `${actor.name} uses ${input.action_name}${
          shape && input.point ? ` (${shape.size_ft} ft ${shape.kind} at ${input.point.x},${input.point.y})` : ''
        }${targets.length ? ` on ${targets.map((t) => t.name).join(', ')}` : ''}.`,
      ),
    }),
  ];
  // Wild Companion and Pact of the Chain conjure the familiar itself: it fights as a companion of the party.
  if (familiar) log.push(...(await summonFamiliar(db, encounter, actor, familiar.form, familiar.feature)));

  const results: Array<Record<string, unknown>> = [];
  // "One damage roll of that spell" and "the caster regains hit points" happen once, not once a target.
  const spentOnce = new Set<string>();
  // A holder's damage-taken clause applies once per cast rather than once per target, the way a
  // rationed rider does; the fit for unlimited clauses is decided per target.
  const holderOnce = new Set<string>();
  const spellFeatures: Array<Record<string, unknown>> = [];
  let healedCaster = false;
  // SRD "Saving Throws and Damage": roll the damage once for all the targets. The first target that
  // needs it rolls it and every later target of the same casting reads those numbers; Empowered
  // Spell's reroll lands on that one roll rather than on each target's own copy of it.
  const sharedDamage = new Map<string, { rolled: ReturnType<typeof rollDamage>; total: number }>();
  let empoweredLogged = false;
  const damageForCast = async (expr: string, critical: boolean): Promise<{ rolled: ReturnType<typeof rollDamage>; total: number }> => {
    const key = `${critical ? 'critical' : 'normal'}:${expr}`;
    const cached = sharedDamage.get(key);
    if (cached) return cached;
    const askExpr = critical ? criticalExpr(expr) : expr;
    // The spell's own dice notes in the player's words: the scaled dice at this level or slot, Magic
    // Missile's darts as spellFill puts them, plus the crit's doubling.
    const playerNote = (note: string): string | null => {
      const cantrip = /^cantrip at level (\d+)/.exec(note);
      if (cantrip) return `${expr} at level ${cantrip[1]}`;
      const upcast = /^upcast to level (\d+)/.exec(note);
      if (upcast) return `${expr} with a level ${upcast[1]} slot`;
      return /^\d+ darts x \(/.test(note) ? note : null;
    };
    const diceNotes = [
      ...(spell?.notes ?? []).map(playerNote).filter((note): note is string => note !== null),
      ...(critical ? [`Doubled on a critical hit: ${expr} becomes ${askExpr}`] : []),
    ];
    const rolled = overchannel
      ? maximumDamage(expr, critical)
      : rollDamage(
          expr,
          critical,
          await askPlayer(db, encounter, actor, 'damage', {
            tool: 'use_action',
            expr: askExpr,
            purpose: `Damage: ${askExpr}${damageType ? ` (${damageType})` : ''}`,
            roll_type: 'damage',
            ...(diceNotes.length ? { dice_notes: diceNotes } : {}),
          }),
        );
    const empowered = plan?.reroll_damage ? rerollLowest(rolled.expr, rolled.dice, plan.reroll_damage) : null;
    if (empowered && !empoweredLogged) {
      empoweredLogged = true;
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          kind: 'feature_note',
          payload: { feature: 'Empowered Spell', delta: empowered.delta },
          text: empowered.note,
        }),
      );
    }
    const entry = { rolled, total: Math.max(0, rolled.total + (empowered?.delta ?? 0)) };
    sharedDamage.set(key, entry);
    return entry;
  };
  // Cover is measured from the effect's own origin: the point an area bursts from, or the caster for a
  // spell aimed at one creature. A cone or line starts at the caster, so it keeps them as the origin.
  const areaCast = shape !== undefined && input.point !== undefined;
  const areaOrigin: Token | null =
    shape && input.point && shape.kind !== 'cone' && shape.kind !== 'line'
      ? { id: -1, x: input.point.x, y: input.point.y, size: 'M', alive: true }
      : null;
  for (const target of targets) {
    // Divine Smite hits a Fiend or an Undead a die harder.
    const unholy = smiting && /fiend|undead/i.test(target.stat_block?.type ?? '');
    const cover = coverBetween(map, combatants, areaOrigin ?? actor, target);
    // Careful Spell and Sculpt Spells carve creatures out: they succeed without rolling and take nothing.
    const carved = plan?.auto_success.has(target.id) ?? false;
    let save: SaveResult | null = null;
    if (saveAbility && saveDc !== undefined && carved) {
      save = {
        ability: saveAbility,
        dc: saveDc,
        total: saveDc,
        natural: null,
        bonus: 0,
        success: true,
        advantage: 'none',
        auto_fail: null,
        notes: ['carved out of the spell'],
      };
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'save',
          payload: { action: input.action_name, save, auto_success: true },
          text: `${target.name} is carved out of ${input.action_name}: the save succeeds and no damage lands.`,
        }),
      );
    } else if (saveAbility && saveDc !== undefined) {
      // Total Cover bars a spell aimed at a creature, though an area still reaches it; the snapshot
      // makes a refused casting cost nothing.
      if (!areaCast && !cover.line_of_sight) {
        throw new Error(`${target.name} has total cover from ${actor.name}: no line of sight, so move first.`);
      }
      // Smite of Protection's Half Cover lends to the save as well as to AC.
      const auraCover = auraHalfCover(target, auraSources(db, encounter));
      save = await rollSave(db, encounter, target, saveAbility, saveDc, {
        coverBonus: auraCover ? Math.max(cover.ac_bonus, 2) : cover.ac_bonus,
        roll: input.rolls?.[String(target.id)],
        tool: 'use_action',
        ...(plan?.save_disadvantage.has(target.id) ? { advantage: 'disadvantage' as Advantage } : {}),
      });
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'save',
          payload: { action: input.action_name, save },
          text: `${target.name} rolls ${save.total} on a ${saveAbility.toUpperCase()} save vs DC ${saveDc}: ${save.success ? 'success' : 'failure'}.`,
        }),
      );
    }

    // A spell cast with an attack roll: the entry says so, and the sheet carries the bonus.
    let spellAttack: { roll: RollOutcome; hit: boolean; critical: boolean; ac: number; advantage: Advantage } | null = null;
    if ((spell?.attack_roll || custom?.attack_roll) && !saveAbility) {
      // A spell attack roll needs to see its target, exactly as a weapon swing does.
      if (!cover.line_of_sight) {
        throw new Error(`${target.name} has total cover from ${actor.name}: no line of sight, so move first.`);
      }
      const away = distanceBetween(actor, target);
      // The crowded-shot rule is for ranged attack rolls; a touch spell is swung, not shot.
      const attackRange = spell?.range_ft ?? declaredEffect?.range_ft;
      const ranged = attackRange === null || attackRange === undefined || attackRange > 5;
      const crowded = ranged ? crowdedShot(db, encounter, actor) : null;
      const attackContext = d20Context(db, encounter, actor, {
        kind: 'attack',
        target,
        distance_ft: away,
        advantage: input.advantage,
        extra: [
          ...(crowded ? [{ advantage: 'disadvantage' as Advantage, note: `${crowded}, so the spell is rushed` }] : []),
          // Innate Sorcery: Advantage on the attack rolls of Sorcerer spells while it runs.
          ...(plan?.attack_advantage ? [{ advantage: 'advantage' as Advantage, note: 'Innate Sorcery' }] : []),
          // A homebrew boost the DM took for this casting rides on its attack roll.
          ...castTaken
            .filter((one) => one.advantage)
            .map((one) => ({ advantage: 'advantage' as Advantage, note: `${one.name}: ${one.describe}` })),
        ],
      });
      const attackBonus =
        (sheet?.spells.attack_bonus ?? 0) +
        attackContext.penalty +
        (plan?.attack_bonus ?? 0) +
        castTaken.reduce((sum, one) => sum + one.bonus, 0);
      // Smite of Protection's Half Cover lends to a spell attack's AC as it does to a weapon swing.
      const auraCover = auraHalfCover(target, auraSources(db, encounter));
      const ac = target.ac + (auraCover ? Math.max(cover.ac_bonus, 2) : cover.ac_bonus);
      const spellBoostCtx: Omit<ClauseCtx, 'sheet'> = { ...castBoostCtx, kind: 'attack', target };
      const spellBoosts = sheet ? boostsFor(sheet, sheet.features, spellBoostCtx, ATTACK_HOOKS) : [];
      const pre =
        input.roll ??
        (await askPlayer(db, encounter, actor, 'attack', {
          tool: 'use_action',
          expr: `1d20${signed(attackBonus)}`,
          purpose: `Spell attack: ${spell?.name ?? input.action_name}`,
          roll_type: 'attack',
          dc: ac,
          advantage: attackContext.advantage,
          advantage_sources: attackContext.advantage_sources,
          target_id: target.id,
          ...(spellBoosts.length ? { boosts_available: spellBoosts } : {}),
        }));
      if (pre?.boosts_chosen?.length) {
        log.push(...spendChosenBoosts(db, encounter, actor, sheet, pre.boosts_chosen, spellBoostCtx, ATTACK_HOOKS));
      }
      let rolled = rollD20(
        attackBonus,
        { advantage: attackContext.advantage, dc: ac, kind: 'attack', luck_bias: pcLuck(db, encounter, actor) },
        pre,
      );
      let landed = rolled.natural === 20 || (rolled.natural !== 1 && rolled.total >= ac);
      // Seeking Spell: a missed spell attack roll is rolled again once, and the new roll stands.
      if (!landed && plan?.reroll_attack) {
        const again = await askPlayer(db, encounter, actor, 'attack', {
          tool: 'use_action',
          expr: `1d20${signed(attackBonus)}`,
          purpose: `Seeking Spell: ${spell?.name ?? input.action_name} rerolled`,
          roll_type: 'attack',
          dc: ac,
          advantage: attackContext.advantage,
          advantage_sources: attackContext.advantage_sources,
          target_id: target.id,
        });
        rolled = rollD20(
          attackBonus,
          {
            advantage: attackContext.advantage,
            dc: ac,
            kind: 'attack',
            luck_bias: pcLuck(db, encounter, actor),
          },
          again,
        );
        landed = rolled.natural === 20 || (rolled.natural !== 1 && rolled.total >= ac);
        attackContext.notes.push(`Seeking Spell: the missed roll is rerolled to ${rolled.total}`);
      }
      const helpless = away <= 5 && rulesOf(target.conditions).some((r) => r.crit_within_5ft);
      spellAttack = {
        roll: rolled,
        hit: landed,
        critical: rolled.natural === 20 || (landed && helpless),
        ac,
        advantage: attackContext.advantage,
      };
      spendSapVex(db, actor, target);
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'attack',
          payload: {
            action: spell?.name ?? input.action_name,
            ...(spell ? { spell: spell.name } : {}),
            roll: rolled,
            advantage: attackContext.advantage,
            effective_ac: ac,
            cover: cover.cover,
            hit: landed,
            critical: spellAttack.critical,
            notes: attackContext.notes,
          },
          text: `${actor.name} uses ${spell?.name ?? input.action_name} at ${target.name}: spell attack ${rolled.total} vs AC ${ac} - ${
            spellAttack.critical ? 'critical hit' : landed ? 'hit' : 'miss'
          }.${attackContext.notes.length ? ` (${attackContext.notes.join('; ')})` : ''}`,
        }),
      );
    }

    let damage: DamageResult | null = null;
    const expr = damageExpr && unholy ? `${damageExpr} + 1d8` : damageExpr;
    // Potent Cantrip: a creature that saved, or was missed, still takes half a cantrip's damage.
    const mitigation =
      spell && sheet && (save?.success === true || (spellAttack !== null && !spellAttack.hit)) && !carved
        ? saveMitigation(sheet, {
            actor,
            spell: spellInfoOf(spell),
            target,
            missed: spellAttack !== null && !spellAttack.hit,
          })
        : null;
    const landedOrHalved = !(spellAttack && !spellAttack.hit) || mitigation !== null;
    const savedOut = save?.success === true && !halfOnSave && mitigation === null;
    // A Smite has no attack roll of its own, so it doubles on the critical hit it followed.
    const criticalCast = spellAttack?.critical ?? smiteCritical;
    if (expr && landedOrHalved && !savedOut && !carved) {
      const { rolled: rolledDamage, total: rolledTotal } = await damageForCast(expr, criticalCast);
      // What the caster's own features add is rolled before the damage lands, so a negative flat rider
      // can come off the part it rides on instead of being applied as a damage part of its own.
      // Riders read the target as it stood before this damage, exactly as they do on an attack.
      const riders =
        spell && sheet
          ? spellDamageRiders(sheet, { actor, spell: spellInfoOf(spell), target, damage_type: damageType }).filter(
              (rider) => !(rider.once_per_cast && spentOnce.has(rider.feature)),
            )
          : [];
      for (const rider of riders) if (rider.once_per_cast) spentOnce.add(rider.feature);
      const riderRolls =
        riders.length > 0
          ? await rollRiderDamage(db, encounter, actor, target, riders, criticalCast, 'use_action')
          : new Map<HitRider, RiderRoll>();
      const parts = [{ type: damageType, amount: rolledTotal }];
      const foldedRiders = foldNegativeRiders(db, encounter, actor, target, parts, riderRolls);
      log.push(...foldedRiders.log);
      // Evasion: a DEX save for half takes nothing at all on a success, and half on a failure.
      const dodgerSheet = sheetOf(db, target);
      const evasion = halfOnSave === true && saveAbility === 'dex' && dodgerSheet !== null && hasEvasion(dodgerSheet);
      // A successful save halves the whole damage roll, a positive rider included; so does a failed Evasion.
      const halved = save?.success === true || mitigation !== null;
      const takesNothing = halved && evasion && save?.success === true;
      const reduced =
        save?.success === true
          ? takesNothing
            ? 'Evasion took it to nothing'
            : 'the save halved it'
          : evasion
            ? 'Evasion halved it'
            : `${mitigation?.feature ?? 'the save'} halved it`;
      const foldedPositive =
        halved || evasion
          ? foldPositiveRidersForHalving(db, encounter, actor, target, parts, riderRolls, damageType, reduced, takesNothing)
          : { log: [], folded: new Set<HitRider>() };
      log.push(...foldedPositive.log);
      // A folded rider fired, so its use is still spent even though its damage never lands on its own.
      if (sheet) {
        for (const rider of [...foldedRiders.folded, ...foldedPositive.folded]) {
          if (rider.spend) log.push(spendFeatureCost(db, encounter, actor, sheet, rider.spend, rider.feature));
        }
      }
      const foldedAll = new Set([...foldedRiders.folded, ...foldedPositive.folded]);
      const ridersToApply = riders.filter((rider) => !foldedAll.has(rider));
      const foldedTotal = parts[0]!.amount;
      const amount = halved
        ? evasion && save?.success === true
          ? 0
          : Math.floor(foldedTotal / 2)
        : evasion
          ? Math.floor(foldedTotal / 2)
          : foldedTotal;
      damage = damageCombatant(db, encounter, target, {
        amount,
        type: damageType,
        source: `${actor.name}'s ${input.action_name}`,
        critical: criticalCast,
      });
      if (mitigation) {
        log.push(
          logCombat(db, encounter, {
            actor_id: actor.id,
            target_id: target.id,
            kind: 'feature_note',
            payload: { feature: mitigation.feature },
            text: mitigation.note,
          }),
        );
      }
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'damage',
          payload: { action: input.action_name, ...damage, type: damageType, expr: rolledDamage.expr },
          text: `${target.name} takes ${damage.applied} ${damageType ?? ''} damage (${rolledDamage.output}${
            damage.resistance ? `, ${damage.resistance}` : ''
          })${partyHp(target, ` - ${damage.hp_current}/${damage.hp_max} HP`)}.`,
        }),
      );
      // A spell's own damage and every rider it carries are one instance, so they owe one concentration
      // save between them, against the damage they add up to.
      let instanceDamage = damage.applied;
      if (sheet && ridersToApply.length > 0) {
        const resolved = await applyHitRiders(
          db,
          encounter,
          actor,
          getCombatant(db, encounter.id, target.id),
          sheet,
          ridersToApply,
          riderRolls,
          criticalCast,
          true,
        );
        log.push(...resolved.log);
        spellFeatures.push(...resolved.applied);
        instanceDamage += resolved.damage;
      }
      log.push(...(await afterDamage(db, encounter, target, instanceDamage, 'use_action')));
      if (damage.dead) log.push(...afterKill(db, encounter, target, actor, `${actor.name}'s ${input.action_name}`));
      else if (isDowned(db, encounter, target.id)) log.push(...droppedToZero(db, encounter, target, actor));

      // A holder's damage-taken clause rides on this damage the way it rides on a weapon hit, once
      // per cast on the first hurt creature it fits.
      const hurt = getCombatant(db, encounter.id, target.id);
      const hurtSheet = sheetOf(db, hurt);
      if (damage.applied > 0 && hurtSheet && hurt.alive && !damage.dead) {
        const raw = damageTakenOutcomes(hurtSheet, {
          actor: hurt, attacker: actor, damage: damage.applied, damage_type: damageType, distance_ft: distanceBetween(actor, target),
        });
        const outcomes = raw.filter((outcome) => {
          const cost = outcome.spend && !Array.isArray(outcome.spend) ? outcome.spend : null;
          return cost === null || !holderOnce.has(cost.resource);
        });
        for (const outcome of outcomes) {
          log.push(...applyOutcome(db, encounter, hurt, hurtSheet, outcome));
          if (outcome.spend && !Array.isArray(outcome.spend)) holderOnce.add(outcome.spend.resource);
        }
      }
    }

    if (spell && sheet && !carved && (save?.success === true || (spellAttack !== null && !spellAttack.hit))) {
      const result = save
        ? { natural: save.natural, total: save.total, dc: save.dc, success: save.success }
        : { natural: spellAttack!.roll.natural, total: spellAttack!.roll.total, dc: spellAttack!.ac, success: spellAttack!.hit };
      for (const outcome of saveSucceededOutcomes(sheet, {
        actor,
        spell: spellInfoOf(spell),
        target,
        missed: spellAttack !== null && !spellAttack.hit,
        roll: result,
      })) {
        log.push(...applyOutcome(db, encounter, actor, sheet, outcome));
      }
    }

    if (healExpr) {
      const healed = rollHealing(healExpr, sheet);
      // Disciple of Life and Blessed Healer: what the caster's features add to a spell's healing.
      const extra = (
        spell && sheet ? healRiders(sheet, { actor, spell: spellInfoOf(spell), target, amount: healed.total }) : []
      ).filter((rider) => !(rider.once_per_cast && spentOnce.has(rider.feature)));
      for (const rider of extra) if (rider.once_per_cast) spentOnce.add(rider.feature);
      const bonus = extra.reduce((sum, rider) => sum + (rider.bonus ?? 0), 0);
      for (const rider of extra) {
        if (rider.spend && sheet) log.push(spendFeatureCost(db, encounter, actor, sheet, rider.spend, rider.feature));
      }
      healCombatant(db, encounter, target, healed.total + bonus);
      const after = getCombatant(db, encounter.id, target.id);
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'heal',
          payload: {
            action: input.action_name,
            amount: healed.total + bonus,
            hp_current: after.hp_current,
            ...(extra.length ? { features: extra.map((rider) => rider.feature) } : {}),
          },
          text: `${target.name} regains ${healed.total + bonus} HP${partyHp(target, ` (${after.hp_current}/${after.hp_max})`)}${
            extra.length ? ` - ${extra.map((rider) => rider.note).join(' ')}` : ''
          }.`,
        }),
      );
      const back = extra.reduce((sum, rider) => sum + (rider.self_heal ?? 0), 0);
      if (back > 0 && !healedCaster) {
        healedCaster = true;
        const caster = getCombatant(db, encounter.id, actor.id);
        healCombatant(db, encounter, caster, back);
        const casterAfter = getCombatant(db, encounter.id, actor.id);
        log.push(
          logCombat(db, encounter, {
            actor_id: actor.id,
            kind: 'heal',
            payload: { action: input.action_name, amount: back, hp_current: casterAfter.hp_current },
            text: `${actor.name} regains ${back} HP${partyHp(caster, ` (${casterAfter.hp_current}/${casterAfter.hp_max})`)} - ${extra
              .filter((rider) => rider.self_heal)
              .map((rider) => rider.note)
              .join(' ')}`,
          }),
        );
      }
    }

    let effectId: number | null = null;
    const immune = ongoing?.kind === 'condition' ? immuneTo(db, encounter, target, ongoing.name) : null;
    if (immune) {
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'note',
          payload: { condition: ongoing?.name, immune: true },
          text: `${immune} The ${input.action_name} leaves no ${ongoing?.name} on it.`,
        }),
      );
    }
    if (ongoing && !immune && !save?.success && !(spellAttack && !spellAttack.hit)) {
      const created = attachEffect(db, encounter, {
        ...ongoing,
        target_id: target.id,
        source_id: ongoing.source_id ?? actor.id,
        concentration_of: concentration ? actor.id : (ongoing.concentration_of ?? null),
      });
      effectId = created.effect.id;
      log.push(created.entry, ...created.landed);
    }
    results.push({ target_id: target.id, name: target.name, save, attack: spellAttack, damage, effect_id: effectId });
  }

  // Overchannel's price, paid by the Evoker the moment the spell is done.
  if (backlash > 0) {
    const rolled = rollDamage(`${backlash}d12`, false);
    const hurt = damageCombatant(db, encounter, getCombatant(db, encounter.id, actor.id), {
      amount: rolled.total,
      type: 'necrotic',
      source: 'Overchannel',
      ignore_immunity: true,
      ignore_resistance: true,
    });
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'feature_damage',
        payload: { feature: 'Overchannel', ...hurt, type: 'necrotic', expr: rolled.expr },
        text: `Overchannel burns ${actor.name}: ${hurt.applied} Necrotic damage (${rolled.output}), which no Resistance or Immunity softens${partyHp(actor, ` - ${hurt.hp_current}/${hurt.hp_max} HP`)}.`,
      }),
    );
    log.push(...(await afterDamage(db, encounter, getCombatant(db, encounter.id, actor.id), hurt.applied, 'use_action')));
    refreshVitals(db, encounter, actor);
  }
  // Smite of Protection: the aura shelters the Paladin and their allies until the start of the Paladin's
  // next turn, so the flag lapses at that turn's start and the counter reads one round from now.
  if (smiting && sheet && hasFeature(sheet, 'devotion-smite-of-protection')) {
    actor.flags = { ...actor.flags, smite_protection: { rounds_left: 1 } };
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'feature_note',
        payload: { feature: 'Smite of Protection' },
        text: `${actor.name}'s smite radiates outward: everyone in their aura has Half Cover until the start of their next turn (Smite of Protection).`,
      }),
    );
  }
  // Arcane Apotheosis paid for one Metamagic option, and it is the only free one this turn.
  if (plan?.free_metamagic) actor.flags = { ...actor.flags, apotheosis_used: true };
  if (concentration) {
    actor.concentration = { name: input.action_name, ...(plan?.concentration_advantage ? { advantage: true } : {}) };
  } else {
    // attachEffect may have started a concentration for the actor; keep it rather than saving the stale null.
    actor.concentration = getCombatant(db, encounter.id, actor.id).concentration;
  }
  // The smite is spent on the hit it followed, and a spell cast on an enemy keeps a Rage alive.
  if (smiting) actor.flags = { ...actor.flags, smite_ready: undefined };
  // Quickened Spell and the level 1+ casting it may not share a turn with: both leave their mark here.
  if (levelled) actor.flags = { ...actor.flags, cast_levelled_spell: true };
  if (quickened) actor.flags = { ...actor.flags, quickened_this_turn: true };
  // The one-slot rule counts only a cast the engine actually charged a slot for: a free casting leaves
  // it clear, and so does a caster with no sheet to spend from, who would otherwise be told a untruth.
  if (spell && spell.slot_level !== null && sheet && actor.character_id !== null) {
    actor.flags = { ...actor.flags, spent_slot_this_turn: true };
  }
  if (economy !== 'free') spendResource(actor, spends, input.out_of_turn);
  // The spell may have healed or hurt the caster: keep what the row says over what this object holds.
  refreshVitals(db, encounter, actor);
  saveCombatant(db, actor);
  // What is still on offer once this call has paid for everything it took.
  const castLeftToSpend = sheet ? boostsFor(sheet, sheet.features, castBoostCtx, CAST_HOOKS) : [];

  return finish(db, encounter, 'use_action', `${actor.name} uses ${input.action_name}.`, log, {
    actor_id: actor.id,
    action: input._feature_effect?.action.id ?? input.action_name,
    targets: results,
    ...(spell ? { spell: { ...spell, damage_expr: damageExpr ?? null } } : {}),
    ...(plan && plan.modifiers.length ? { spell_modifiers: plan.modifiers.map((m) => ({ feature: m.feature, note: m.note })) } : {}),
    ...(spellFeatures.length ? { features: spellFeatures } : {}),
    ...(remindersOf(spellFeatures).length ? { reminders: remindersOf(spellFeatures) } : {}),
    ...(castLeftToSpend.length ? { boosts_available: castLeftToSpend } : {}),
    ...(sheet ? { class_features: classFeatures(sheet, getCombatant(db, encounter.id, actor.id)) } : {}),
    ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
  });
}

// --- turns ------------------------------------------------------------------

/** A new turn clears what the last one left: Dash, Dodge, Disengage and an unreleased readied action. */
const turnFlags = (flags: CombatFlags): CombatFlags => ({
  ...(flags.hidden ? { hidden: true } : {}),
  ...(flags.stable ? { stable: true } : {}),
  ...(flags.helped_by ? { helped_by: flags.helped_by } : {}),
  ...(flags.grappled_by === undefined ? {} : { grappled_by: flags.grappled_by }),
  ...(flags.grappling?.length ? { grappling: flags.grappling } : {}),
  // The mastery windows run off the attacker's turns, not this one, so they outlive it.
  ...(flags.sapped_by ? { sapped_by: flags.sapped_by } : {}),
  ...(flags.slowed_by ? { slowed_by: flags.slowed_by } : {}),
  ...(flags.vex_against ? { vex_against: flags.vex_against } : {}),
  // A Rage, a Sacred Weapon, an Innate Sorcery and a Wild Shape run for minutes or hours; everything
  // else a class feature leaves behind is for one turn.
  ...(flags.raging ? { raging: flags.raging } : {}),
  ...(flags.sacred_weapon ? { sacred_weapon: flags.sacred_weapon } : {}),
  ...(flags.innate_sorcery ? { innate_sorcery: flags.innate_sorcery } : {}),
  ...(flags.wild_shape ? { wild_shape: flags.wild_shape } : {}),
  ...(flags.pact_weapon ? { pact_weapon: flags.pact_weapon } : {}),
  // Declared and not yet spent: they wait for the roll they were bought for, as a stance does.
  ...(flags.cutting_words_ready ? { cutting_words_ready: flags.cutting_words_ready } : {}),
  ...(flags.dark_ones_luck_ready ? { dark_ones_luck_ready: true } : {}),
  ...(flags.d20_stance ? { d20_stance: flags.d20_stance } : {}),
  ...(flags.hunters_defense_ready ? { hunters_defense_ready: true } : {}),
  // Superior Defense and Holy Nimbus run for minutes; Quivering Palm's vibrations run for days.
  ...(flags.superior_defense ? { superior_defense: flags.superior_defense } : {}),
  ...(flags.holy_nimbus ? { holy_nimbus: flags.holy_nimbus } : {}),
  ...(flags.smite_protection ? { smite_protection: flags.smite_protection } : {}),
  ...(flags.quivering_palm ? { quivering_palm: flags.quivering_palm } : {}),
  // Waiting for the roll or the swing they were left for: a stagger, a sundered guard, a studied miss.
  ...(flags.staggered ? { staggered: true } : {}),
  ...(flags.sundering_blow ? { sundering_blow: flags.sundering_blow } : {}),
  ...(flags.studied_target ? { studied_target: flags.studied_target } : {}),
  // Persistent Rage was offered at Initiative and stays on offer until this turn of theirs ends.
  ...(flags.persistent_rage_offered ? { persistent_rage_offered: true } : {}),
});

/**
 * The once-a-turn features belong to a turn, not to a round: a Rogue who sneak-attacks on its own turn
 * may not sneak again on an opportunity attack during the goblin's. Every turn boundary clears them for
 * everyone, and the Deflect Attacks redirect window closes with them.
 */
function clearOncePerTurn(db: Db, encounter: EncounterRow): void {
  for (const combatant of listCombatants(db, encounter.id)) {
    const flags = combatant.flags;
    const oncePerTurn = [
      flags.sneak_attack_used,
      flags.stunning_strike_used,
      flags.colossus_slayer_used,
      flags.frenzy_used,
      flags.divine_strike_used,
      flags.primal_strike_used,
      flags.eldritch_smite_used,
      flags.lifedrinker_used,
      flags.deflect_redirect,
      flags.resisting,
      flags.quivering_palm_used,
      flags.hurl_through_hell_used,
      flags.apotheosis_used,
      flags.superior_prey_used,
      flags.cleaved,
      flags.homebrew_used,
      flags.spent_slot_this_turn,
    ];
    if (oncePerTurn.every((flag) => flag === undefined)) continue;
    combatant.flags = {
      ...flags,
      sneak_attack_used: undefined,
      stunning_strike_used: undefined,
      colossus_slayer_used: undefined,
      frenzy_used: undefined,
      divine_strike_used: undefined,
      primal_strike_used: undefined,
      eldritch_smite_used: undefined,
      lifedrinker_used: undefined,
      deflect_redirect: undefined,
      // Superior Hunter's Defense resists that damage type "until the end of the current turn".
      resisting: undefined,
      quivering_palm_used: undefined,
      hurl_through_hell_used: undefined,
      apotheosis_used: undefined,
      superior_prey_used: undefined,
      // One slot a turn means the turn in play, not the caster's own: clearing it here is what lets
      // Shield or Counterspell answer an attack on someone else's turn after a cast on your own.
      spent_slot_this_turn: undefined,
      // Cleave is one extra attack a turn; the swing spends it, the next turn gives it back.
      cleaved: undefined,
      // The once-a-turn homebrew clauses are keyed the same way, and clear on the same edge.
      homebrew_used: undefined,
    };
    saveCombatant(db, combatant);
  }
}

/**
 * The class-feature states that run on a clock rather than to the end of a turn: a Sacred Weapon's ten
 * minutes, an Innate Sorcery's minute, a Wild Shape's half-level hours. Each loses a round at the end of
 * its holder's turn and ends when the clock runs out; a Wild Shape also ends the moment it is incapacitated.
 */
function expireTimedFlags(db: Db, encounter: EncounterRow, actor: Combatant): CombatLogEntry[] {
  const fresh = getCombatant(db, encounter.id, actor.id);
  const entries: CombatLogEntry[] = [];
  const end = (feature: string, text: string): void => {
    entries.push(
      logCombat(db, encounter, {
        actor_id: fresh.id,
        kind: 'feature_note',
        payload: { feature, ended: true },
        text,
      }),
    );
  };
  let flags = fresh.flags;
  const blessed = flags.sacred_weapon;
  if (blessed) {
    const left = blessed.rounds_left - 1;
    flags = left <= 0 ? { ...flags, sacred_weapon: undefined } : { ...flags, sacred_weapon: { ...blessed, rounds_left: left } };
    if (left <= 0) end('Sacred Weapon', `The blessing on ${fresh.name}'s weapon fades: ten minutes of Sacred Weapon are up.`);
  }
  const sorcery = flags.innate_sorcery;
  if (sorcery) {
    const left = sorcery.rounds_left - 1;
    flags = left <= 0 ? { ...flags, innate_sorcery: undefined } : { ...flags, innate_sorcery: { rounds_left: left } };
    if (left <= 0) end('Innate Sorcery', `${fresh.name}'s Innate Sorcery ends: its minute is up.`);
  }
  const bolstered = flags.superior_defense;
  if (bolstered) {
    const left = bolstered.rounds_left - 1;
    const over = left <= 0 || isIncapacitated(fresh.conditions);
    flags = over ? { ...flags, superior_defense: undefined } : { ...flags, superior_defense: { rounds_left: left } };
    if (over) {
      end(
        'Superior Defense',
        `${fresh.name}'s Superior Defense ends: ${isIncapacitated(fresh.conditions) ? 'they are incapacitated' : 'its minute is up'}.`,
      );
    }
  }
  const nimbus = flags.holy_nimbus;
  if (nimbus) {
    const left = nimbus.rounds_left - 1;
    flags = left <= 0 ? { ...flags, holy_nimbus: undefined } : { ...flags, holy_nimbus: { rounds_left: left } };
    if (left <= 0) end('Holy Nimbus', `The light around ${fresh.name} fades: ten minutes of Holy Nimbus are up.`);
  }
  // Studied Attacks holds until the end of your next turn; the Resistance one blow bought holds to the turn's end.
  const studied = flags.studied_target;
  if (studied) {
    const left = studied.rounds_left - 1;
    flags = left <= 0 ? { ...flags, studied_target: undefined } : { ...flags, studied_target: { ...studied, rounds_left: left } };
  }
  const sundered = flags.sundering_blow;
  if (sundered) {
    const left = sundered.rounds_left - 1;
    flags = left <= 0 ? { ...flags, sundering_blow: undefined } : { ...flags, sundering_blow: { ...sundered, rounds_left: left } };
  }
  const shape = flags.wild_shape;
  if (shape) {
    const left = shape.rounds_left - 1;
    const why = isIncapacitated(fresh.conditions) ? `${fresh.name} is incapacitated` : left <= 0 ? 'the hours are up' : null;
    if (why) {
      entries.push(...revertWildShape(db, encounter, fresh, why));
      flags = getCombatant(db, encounter.id, fresh.id).flags;
    } else {
      flags = { ...flags, wild_shape: { ...shape, rounds_left: left } };
    }
  }
  if (flags !== fresh.flags) {
    fresh.flags = flags;
    saveCombatant(db, fresh);
    actor.flags = flags;
  }
  return entries;
}

/**
 * The upkeep a class feature asks for at the edge of its holder's turn: the Rage that has to be extended
 * or ends, and the features whose own text fires there (Heroic Warrior, Self-Restoration).
 */
function featureTurnEdge(db: Db, encounter: EncounterRow, actor: Combatant, when: 'start' | 'end'): CombatLogEntry[] {
  const sheet = sheetOf(db, actor);
  if (!sheet) return [];
  const entries: CombatLogEntry[] = [];
  const fresh = getCombatant(db, encounter.id, actor.id);

  if (when === 'end' && fresh.flags.raging) {
    const raging = fresh.flags.raging;
    const left = raging.rounds_left - 1;
    // The Rage ends when the turn it was not extended in runs out, when ten minutes pass, or when its
    // holder is incapacitated; entering heavy armour ends it too, and that shows on the sheet.
    // Persistent Rage, at level 15: nothing but falling Unconscious or the ten minutes ends it.
    const persistent = hasFeature(sheet, 'barbarian-persistent-rage');
    const why = persistent
      ? fresh.conditions.includes('unconscious')
        ? `${fresh.name} is unconscious`
        : left <= 0
          ? 'ten minutes of Rage are up'
          : null
      : isIncapacitated(fresh.conditions)
        ? `${fresh.name} is incapacitated`
        : raging.extended_round < encounter.round
          ? `${fresh.name} neither attacked nor forced a save this round`
          : left <= 0
            ? 'ten minutes of Rage are up'
            : null;
    if (why) {
      fresh.flags = { ...fresh.flags, raging: undefined };
      saveCombatant(db, fresh);
      actor.flags = fresh.flags;
      entries.push(
        logCombat(db, encounter, {
          actor_id: fresh.id,
          kind: 'feature_note',
          payload: { feature: 'Rage', ended: true, reason: why },
          text: `${fresh.name}'s Rage ends: ${why}.`,
        }),
      );
    } else {
      fresh.flags = { ...fresh.flags, raging: { ...raging, rounds_left: left } };
      saveCombatant(db, fresh);
      actor.flags = fresh.flags;
    }
  }

  if (when === 'end') entries.push(...expireTimedFlags(db, encounter, actor));

  // Smite of Protection runs to the start of the Paladin's own next turn, not the end of the turn it
  // was cast on, so its count comes off here rather than in expireTimedFlags.
  if (when === 'start' && fresh.flags.smite_protection) {
    const left = fresh.flags.smite_protection.rounds_left - 1;
    fresh.flags =
      left <= 0
        ? { ...fresh.flags, smite_protection: undefined }
        : { ...fresh.flags, smite_protection: { rounds_left: left } };
    saveCombatant(db, fresh);
    actor.flags = fresh.flags;
    if (left <= 0) {
      entries.push(
        logCombat(db, encounter, {
          actor_id: fresh.id,
          kind: 'feature_note',
          payload: { feature: 'Smite of Protection', ended: true },
          text: `The cover ${fresh.name}'s aura lent runs out: Smite of Protection lasts until the start of their next turn.`,
        }),
      );
    }
  }

  // Survivor's Heroic Rally, Self-Restoration and every clause written at a turn edge.
  for (const outcome of turnOutcomes(sheet, getCombatant(db, encounter.id, actor.id), when)) {
    entries.push(...applyOutcome(db, encounter, actor, sheet, outcome));
  }
  return entries;
}

/** Holy Nimbus: the Radiant damage an enemy takes for starting its turn inside a Paladin's aura. */
async function auraTurnDamage(db: Db, encounter: EncounterRow, actor: Combatant): Promise<CombatLogEntry[]> {
  if (!actor.alive || actor.hp_current === 0) return [];
  const burning = holyNimbusDamage(actor, auraSources(db, encounter));
  if (!burning) return [];
  const result = damageCombatant(db, encounter, actor, {
    amount: burning.amount,
    type: 'radiant',
    source: `${burning.from.name}'s Holy Nimbus`,
  });
  const entries = [
    logCombat(db, encounter, {
      actor_id: burning.from.id,
      target_id: actor.id,
      kind: 'feature_damage',
      payload: { feature: 'Holy Nimbus', ...result, type: 'radiant' },
      text: `${actor.name} starts its turn in ${burning.from.name}'s Holy Nimbus and takes ${result.applied} Radiant damage${partyHp(actor, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
    }),
  ];
  entries.push(...(await afterDamage(db, encounter, actor, result.applied, 'advance_turn')));
  if (result.dead) entries.push(...afterKill(db, encounter, actor, burning.from, `${burning.from.name}'s Holy Nimbus`));
  else if (isDowned(db, encounter, actor.id)) entries.push(...droppedToZero(db, encounter, actor, burning.from));
  return entries;
}

/** A grapple ends when the grappler is incapacitated or down, or the two are no longer within reach. */
function checkGrapples(db: Db, encounter: EncounterRow): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  for (const held of listCombatants(db, encounter.id)) {
    const grapplerId = held.flags.grappled_by;
    if (grapplerId === undefined) continue;
    const grappler = listCombatants(db, encounter.id).find((c) => c.id === grapplerId);
    if (!grappler) continue;
    const why = !grappler.alive || grappler.hp_current === 0
      ? `${grappler.name} is down`
      : isIncapacitated(grappler.conditions)
        ? `${grappler.name} is incapacitated`
        : distanceBetween(grappler, held) > reachOf(db, grappler)
          ? `${held.name} is out of ${grappler.name}'s reach`
          : null;
    if (!why) continue;
    releaseGrapple(db, encounter, grappler, held);
    entries.push(
      logCombat(db, encounter, {
        actor_id: grappler.id,
        target_id: held.id,
        kind: 'grapple_end',
        payload: { reason: why },
        text: `The grapple on ${held.name} ends: ${why}.`,
      }),
    );
  }
  return entries;
}

/** Survivor: the Champion whose death saves carry Advantage and count an 18 or better as a 20. */
function defiesDeath(db: Db, combatant: Combatant): boolean {
  const sheet = sheetOf(db, combatant);
  return sheet !== null && hasFeature(sheet, 'champion-survivor');
}

/** Defy Death's second half: an 18 or better on the die is the 20 that puts them back on their feet. */
const countsAsTwenty = (pre: PreRoll & { output: string }): PreRoll & { output: string } =>
  (pre.natural ?? pre.total) >= 18 ? { total: 20, natural: 20, output: `${pre.output} - an 18+ counts as a 20 (Survivor)` } : pre;

/**
 * Survivor's Defy Death, when the server rolls: the death save is made with Advantage, and an 18 or
 * better counts as the 20 that puts them back on their feet. The roll is handed on as a pre-roll.
 */
function defyDeath(db: Db, encounter: EncounterRow, combatant: Combatant): (PreRoll & { output: string }) | undefined {
  if (!defiesDeath(db, combatant)) return undefined;
  // Every roll handed to deathSave carries its own exhaustion, because deathSave only applies the
  // penalty to a roll it made itself.
  const tired = exhaustionPenalty(sheetOf(db, combatant)?.exhaustion ?? 0);
  const rolled = rollDice(tired ? `1d20${tired}` : '1d20', {
    advantage: 'advantage',
    dc: 10,
    roll_type: 'save',
    luck_bias: pcLuck(db, encounter, combatant),
  });
  const natural = rolled.natural_d20 ?? rolled.total;
  return countsAsTwenty({ total: rolled.total, natural, output: `${rolled.output} with Advantage (Survivor)` });
}

/** A downed PC or companion rolls a death save at the start of its turn, by the same SRD rules. */
async function rollDeathSave(db: Db, encounter: EncounterRow, combatant: Combatant): Promise<CombatLogEntry> {
  // Survivor holds whoever makes the roll: the player's card carries the Advantage and the 18+ rule too.
  const survivor = defiesDeath(db, combatant);
  // The character's death save takes exhaustion off the total, so the card has to show it or the
  // window judges the bare face and calls a failed save a success.
  const tired = exhaustionPenalty(sheetOf(db, combatant)?.exhaustion ?? 0);
  const clicked = await askPlayer(db, encounter, combatant, 'death_save', {
    tool: 'advance_turn',
    expr: tired ? `1d20${tired}` : '1d20',
    purpose: survivor ? 'Death saving throw (Survivor: Advantage, an 18+ counts as a 20)' : 'Death saving throw',
    roll_type: 'save',
    dc: 10,
    ...(survivor ? { advantage: 'advantage' as const } : {}),
  });
  const pre = clicked
    ? survivor
      ? countsAsTwenty(clicked)
      : clicked
    : defyDeath(db, encounter, combatant);
  const characterId = characterOf(combatant);
  if (characterId) {
    const result = pcDeathSave(db, {
      campaign_id: encounter.campaign_id,
      character_id: characterId,
      mirror: false,
      roll: pre && { total: pre.total, natural_d20: pre.natural ?? null },
    });
    mirrorCharacter(db, combatant);
    saveCombatant(db, combatant);
    return logCombat(db, encounter, {
      actor_id: combatant.id,
      kind: 'death_save',
      payload: result,
      text: `${combatant.name} rolls a death save: ${result.result} (${result.successes} successes, ${result.failures} failures).`,
    });
  }
  // Only the player character's death save is ever clicked, so the companion branch always rolls here.
  // Only a monster reaches here, and a monster carries no sheet, so there is no exhaustion to apply.
  const roll = rollDice('1d20', { roll_type: 'save', dc: 10, luck_bias: pcLuck(db, encounter, combatant) });
  const natural = roll.natural_d20 ?? roll.total;
  let outcome: string;
  if (natural === 20) {
    outcome = 'critical_success';
    combatant.hp_current = 1;
    combatant.death_saves = { successes: 0, failures: 0 };
    combatant.conditions = combatant.conditions.filter((c) => c !== 'unconscious');
  } else if (natural === 1) {
    outcome = 'critical_failure';
    combatant.death_saves.failures += 2;
  } else if (roll.total >= 10) {
    outcome = 'success';
    combatant.death_saves.successes += 1;
  } else {
    outcome = 'failure';
    combatant.death_saves.failures += 1;
  }
  if (combatant.death_saves.failures >= 3) combatant.alive = false;
  if (combatant.death_saves.successes >= 3) {
    combatant.death_saves = { successes: 0, failures: 0 };
    // Three successes leave it stable at 0 HP: advance_turn rolls no more death saves until damage lands.
    combatant.flags = { ...combatant.flags, stable: true };
  }
  saveCombatant(db, combatant);
  return logCombat(db, encounter, {
    actor_id: combatant.id,
    kind: 'death_save',
    payload: { roll: roll.total, natural, outcome, death_saves: combatant.death_saves, alive: combatant.alive },
    text: `${combatant.name} rolls ${roll.total} on a death save: ${outcome} (${combatant.death_saves.successes} successes, ${combatant.death_saves.failures} failures).`,
  });
}

export async function advanceTurn(db: Db, campaignId: number, rolls?: Record<string, PreRoll>) {
  return underSnapshot(db, requireEncounter(db, campaignId), 'advance_turn', () => runAdvanceTurn(db, campaignId, rolls));
}

async function runAdvanceTurn(db: Db, campaignId: number, rolls?: Record<string, PreRoll>) {
  const encounter = requireEncounter(db, campaignId);
  const combatants = listCombatants(db, encounter.id);
  if (combatants.length === 0) throw new Error('This encounter has no combatants.');
  const current = activeCombatant(combatants, encounter.turn_index);
  const log: CombatLogEntry[] = [];

  if (current) {
    log.push(...(await tickEffects(db, encounter, current.id, 'end', rolls)));
    // Help runs out when the creature it was given to has had its turn.
    const helped = getCombatant(db, encounter.id, current.id);
    if (helped.flags.helped_by || helped.flags.cleave_ready || helped.flags.persistent_rage_offered) {
      // Cleave follows a hit from this turn, so the opening it left closes with the turn; so does the
      // Persistent Rage the Barbarian was offered when Initiative was rolled.
      helped.flags = { ...helped.flags, helped_by: undefined, cleave_ready: undefined, persistent_rage_offered: undefined };
      saveCombatant(db, helped);
    }
    log.push(...expireMastery(db, encounter, helped, 'end'));
    log.push(...expireSourceRiders(db, encounter, helped, 'end'));
    log.push(...featureTurnEdge(db, encounter, helped, 'end'));
    log.push(...checkGrapples(db, encounter));
    log.push(
      logCombat(db, encounter, {
        actor_id: current.id,
        kind: 'turn_end',
        payload: { round: encounter.round },
        text: `${current.name} ends their turn.`,
      }),
    );
  }

  let index = encounter.turn_index;
  let round = encounter.round;
  let next: Combatant | null = null;
  const passedOver: Combatant[] = [];
  for (let step = 0; step < combatants.length; step += 1) {
    index += 1;
    if (index >= combatants.length) {
      index = 0;
      round += 1;
    }
    const candidate = listCombatants(db, encounter.id)[index];
    if (candidate?.alive) {
      next = candidate;
      break;
    }
    if (candidate) passedOver.push(candidate);
  }
  db.prepare('UPDATE encounter SET turn_index = ?, round = ? WHERE id = ?').run(index, round, encounter.id);
  const moved = refresh(db, encounter.id);
  clearOncePerTurn(db, moved);
  if (round !== encounter.round) {
    log.push(
      logCombat(db, moved, {
        kind: 'round',
        payload: { round },
        text: `Round ${round} begins.`,
      }),
    );
  }
  // Sap and Slow run off the attacker's turn slot, which comes round even when the attacker is dead.
  for (const gone of passedOver) log.push(...expireMastery(db, moved, gone, 'start'));
  if (!next) {
    return finish(db, moved, 'advance_turn', 'Nobody is left standing.', log, { active: null, legal_actions: [] });
  }

  // An expiry for a slot just passed over may have lifted something off the creature whose turn this is.
  next = getCombatant(db, moved.id, next.id);

  // Slow takes its 10 ft off the movement this turn opens with, until the attacker's turn comes round.
  const slowed = next.flags.slowed_by?.ft ?? 0;
  next.movement_left = speedZeroBy(next.conditions).length > 0 ? 0 : Math.max(0, next.speed - slowed);
  next.action_used = false;
  next.bonus_used = false;
  next.reaction_used = false;
  next.flags = turnFlags(next.flags);
  saveCombatant(db, next);
  log.push(...expireMastery(db, moved, next, 'start'));
  log.push(...expireSourceRiders(db, moved, next, 'start'));

  log.push(...(await tickEffects(db, moved, next.id, 'start', rolls)));
  const refreshed = getCombatant(db, moved.id, next.id);
  // A stabilised character lies there; the character package clears that flag when damage lands again.
  // A knocked-out monster carries the same flag on its own row.
  const stable = sheetOf(db, refreshed)?.stable ?? refreshed.flags.stable === true;
  if (refreshed.alive && refreshed.hp_current === 0 && !stable) log.push(await rollDeathSave(db, moved, refreshed));

  let actor = getCombatant(db, moved.id, next.id);
  log.push(...(await auraTurnDamage(db, moved, actor)));
  actor = getCombatant(db, moved.id, next.id);
  log.push(...featureTurnEdge(db, moved, actor, 'start'));
  log.push(
    logCombat(db, moved, {
      actor_id: actor.id,
      kind: 'turn_start',
      payload: { round, turn_index: index },
      text: `Round ${round}: ${actor.name}'s turn (${actor.movement_left} ft of movement).`,
    }),
  );

  const actions = legalActions(actor, sheetOf(db, actor), false);
  return finish(db, moved, 'advance_turn', `${actor.name}'s turn (round ${round}).`, log, {
    active: { id: actor.id, name: actor.name, team: actor.team, kind: actor.kind, hp_current: actor.hp_current },
    round,
    turn_index: index,
    legal_actions: actions,
  });
}

// --- taking one call back ---------------------------------------------------

/** Reverts the last mutating combat call: combatants, effects, sheets and the turn go back as they were. */
export function undoLastCombatAction(db: Db, campaignId: number) {
  const encounter = activeEncounter(db, campaignId);
  if (!encounter) {
    throw new Error(
      `Campaign ${campaignId} has no active encounter. Ending a fight cannot be undone, and neither can starting one - open a new fight with start_encounter.`,
    );
  }
  const entry = lastSnapshot(db, encounter.id);
  if (!entry) {
    throw new Error(
      `Nothing to undo in encounter ${encounter.id}: no combat tool has run since it started, and starting a fight itself cannot be undone (end_encounter closes it instead).`,
    );
  }
  const sheets = restoreSnapshot(db, encounter.id, entry.snapshot);
  dropSnapshot(db, entry.id);
  const restored = refresh(db, encounter.id);
  // What the call left in the log, named so the window can strike it through and the DM's tail can drop it.
  const lastLogId = (
    db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM combat_log WHERE encounter_id = ?').get(encounter.id) as {
      id: number;
    }
  ).id;
  const reverted =
    entry.snapshot.log_from !== undefined && lastLogId >= entry.snapshot.log_from
      ? { from: entry.snapshot.log_from, to: lastLogId }
      : null;
  const log = [
    logCombat(db, restored, {
      kind: 'undo',
      payload: {
        tool: entry.tool,
        round: restored.round,
        turn_index: restored.turn_index,
        ...(reverted ? { reverted_log_ids: reverted } : {}),
      },
      text: `Undo: ${entry.tool} is taken back; the fight stands as it did before that call.`,
    }),
  ];
  // The character tools announce every sheet change, so the undo of one announces it going back.
  for (const sheet of sheets) {
    logEvent(db, {
      campaign_id: encounter.campaign_id,
      kind: 'undo',
      text: `${sheet.name} is back at ${sheet.hp_current}/${sheet.hp_max} HP (${entry.tool} undone).`,
      payload: { character_id: sheet.id, tool: entry.tool, hp_current: sheet.hp_current, status: sheet.status },
    });
  }
  // The player's undo button reads this answer as well, so it carries the player's battle state.
  return finish(
    db,
    restored,
    'undo_last_combat_action',
    `${entry.tool} undone.`,
    log,
    {
      undone: entry.tool,
      encounter_id: encounter.id,
      ...(reverted ? { reverted_log_ids: reverted } : {}),
    },
    true,
  );
}

// --- ending -----------------------------------------------------------------

export interface CombatantSummary {
  id: number;
  name: string;
  team: Team;
  damage_dealt: number;
  damage_taken: number;
  healed: number;
  alive: boolean;
}

export function endEncounter(
  db: Db,
  input: { campaign_id: number; outcome: 'victory' | 'retreat' | 'defeat' | 'other'; summary?: string },
) {
  const encounter = requireEncounter(db, input.campaign_id);
  const combatants = listCombatants(db, encounter.id);
  // What an undo took back never happened, so the totals leave those rows out as the window already does.
  const entries = combatLog(db, encounter.id, { omitReverted: true });

  const summaries = new Map<number, CombatantSummary>(
    combatants.map((c) => [
      c.id,
      { id: c.id, name: c.name, team: c.team, damage_dealt: 0, damage_taken: 0, healed: 0, alive: c.alive },
    ]),
  );
  for (const entry of entries) {
    const payload = entry.payload as { applied?: number; amount?: number; result?: { applied?: number } } | null;
    // An effect tick carries its damage under result, and its actor is whoever left the effect behind.
    const applied = entry.kind === 'effect_tick' ? payload?.result?.applied : payload?.applied;
    if ((entry.kind === 'damage' || entry.kind === 'effect_tick') && applied) {
      if (entry.target_id) summaries.get(entry.target_id)!.damage_taken += applied;
      if (entry.actor_id) summaries.get(entry.actor_id)!.damage_dealt += applied;
    }
    if (entry.kind === 'heal' && payload?.amount && entry.target_id) {
      summaries.get(entry.target_id)!.healed += payload.amount;
    }
  }

  // Nothing outlives the fight it was cast in.
  for (const effect of listEffects(db, encounter.id)) endEffect(db, encounter, effect);
  for (const c of listCombatants(db, encounter.id)) {
    if (!c.flags.sapped_by && !c.flags.slowed_by && !c.flags.vex_against && !c.flags.cleave_ready) continue;
    c.flags = { ...c.flags, sapped_by: undefined, slowed_by: undefined, vex_against: undefined, cleave_ready: undefined };
    saveCombatant(db, c);
  }

  // Standing up costs nothing once the fight is over, so nobody walks away prone.
  const stoodUp: string[] = [];
  for (const c of listCombatants(db, encounter.id)) {
    if (c.team !== 'party' || c.character_id === null || !c.alive) continue;
    if (!c.conditions.includes('prone') || c.conditions.includes('unconscious')) continue;
    setPcCondition(db, {
      campaign_id: input.campaign_id,
      character_id: c.character_id,
      condition: 'prone',
      active: false,
      mirror: false,
    });
    stoodUp.push(c.name);
  }

  const defeated = combatants.filter((c) => c.team === 'enemy' && !c.alive);
  const xp = defeated.reduce((sum, c) => sum + xpForCr(c.stat_block?.cr ?? 0), 0);
  const ts = nowIso();
  db.prepare('UPDATE encounter SET status = ?, ended_at = ?, outcome = ? WHERE id = ?').run(
    'ended',
    ts,
    input.outcome,
    encounter.id,
  );

  const text = `Encounter ${encounter.id} ends in ${input.outcome}${input.summary ? `: ${input.summary}` : ''}.`;
  const log = [
    logCombat(db, encounter, {
      kind: 'encounter_end',
      payload: { outcome: input.outcome, xp_suggestion: xp, defeated: defeated.map((c) => c.name) },
      text,
    }),
  ];
  const ended = refresh(db, encounter.id);
  // The companion UI reads the same numbers off the event, so the payload carries the whole summary.
  const summary = {
    rounds: encounter.round,
    defeated: defeated.map((c) => ({ name: c.name, cr: c.stat_block?.cr ?? 0, xp: xpForCr(c.stat_block?.cr ?? 0) })),
    xp_suggestion: xp,
    combatants: [...summaries.values()],
  };
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'combat',
    text,
    payload: {
      tool: 'end_encounter',
      encounter_id: encounter.id,
      log: logFor(db, input.campaign_id, log),
      state: battleState(db, ended),
      summary,
    },
  });

  return {
    encounter_id: encounter.id,
    outcome: input.outcome,
    ...summary,
    stood_up: stoodUp,
    summary: input.summary ?? null,
    log,
    // The DM's copy names the gear truly; the event above keeps the player's mask.
    state: battleState(db, ended, false),
    reminder: 'XP is a suggestion: call xp {op: award} yourself if the party earned it, then checkpoint {op: save}.',
  };
}
