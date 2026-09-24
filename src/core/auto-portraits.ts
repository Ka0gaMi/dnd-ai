// Portraits nobody has to ask for. A new character gets one; a fight gets one per creature type,
// shared by every combatant of it, and one of their own for anyone with a name. Generation runs
// behind the tool call that triggered it, one at a time, and never fails into the caller.
import { activeEncounter, setCombatantPortrait } from '../combat/state.js';
import type { Db } from '../db/connection.js';
import type { CreatureStatBlock } from '../srd/data.js';
import { heraldryFor } from './heraldry.js';
import {
  creaturePortraitPaths,
  generatePortrait,
  individualPortraitPath,
  portraitsEnabled,
  type PortraitStyle,
} from './portraits.js';
import { getSettings } from './settings.js';
import { listFactions } from './world-store.js';

/** A gap between generations, so one busy encounter cannot spend the free tier in a burst. */
const QUEUE_GAP_MS = 250;
/** How much of a backstory reaches the prompt; the rest is narration the model cannot draw. */
const DESCRIPTION_LIMIT = 240;

const pending = new Set<string>();
let queue: Promise<void> = Promise.resolve();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Queues one generation behind the last. A subject already in flight is left alone. */
function enqueue(key: string, run: () => Promise<void>): void {
  if (pending.has(key)) return;
  pending.add(key);
  queue = queue.then(async () => {
    try {
      await sleep(QUEUE_GAP_MS);
      await run();
    } catch (err) {
      console.error(new Date().toISOString(), `portrait for ${key} failed: ${(err as Error).message}`);
    } finally {
      pending.delete(key);
    }
  });
}

/** Test hook: resolves once the queue has drained, work queued by that work included. */
export async function flushPortraitQueue(): Promise<void> {
  let seen: Promise<void>;
  do {
    seen = queue;
    await seen;
  } while (seen !== queue);
}

function autoPortraitsOn(db: Db, campaignId: number): boolean {
  return portraitsEnabled() && getSettings(db, campaignId).auto_portraits;
}

/** The player character, a companion or an NPC, right after they are created. */
export function scheduleCharacterPortrait(db: Db, campaignId: number, characterId: number, description: string): void {
  if (!autoPortraitsOn(db, campaignId)) return;
  enqueue(`character ${characterId}`, async () => {
    await generatePortrait({
      db,
      campaign_id: campaignId,
      subject: { character_id: characterId },
      description: description.slice(0, DESCRIPTION_LIMIT),
    });
  });
}

/** The codex row an emblem is drawn for; portrait_path marks one already handled. */
export interface EmblemRow {
  id: number;
  campaign_id: number;
  name: string;
  kind: string;
  summary: string;
  portrait_path: string | null;
}

/** The emblem prompt for a faction or deity: its heraldry when the world has any, else its own words. */
export function emblemDescription(
  db: Db,
  row: { id: number; campaign_id: number; name: string; kind: string; summary: string },
): string {
  const suffix = row.summary ? `, ${row.summary.slice(0, 160)}` : '';
  if (row.kind === 'faction') {
    const factions = listFactions(db, row.campaign_id);
    const faction =
      factions.find((f) => f.entity_id === row.id) ??
      factions.find((f) => f.name.toLowerCase() === row.name.toLowerCase());
    const heraldry = faction ? heraldryFor(db, row.campaign_id, faction) : null;
    return heraldry ? heraldry.emblem : `heraldic emblem of ${row.name}${suffix}`;
  }
  return `holy symbol of ${row.name}${suffix}`;
}

/** A coat of arms or holy symbol for a codex faction or deity that has neither yet. */
export function scheduleEntityEmblem(db: Db, row: EmblemRow): void {
  if (row.portrait_path !== null || !autoPortraitsOn(db, row.campaign_id)) return;
  enqueue(`emblem ${row.id}`, async () => {
    const portrait = await generatePortrait({
      db,
      campaign_id: row.campaign_id,
      subject: { creature: row.name, kind: 'individual' },
      description: emblemDescription(db, row),
      framing: 'emblem',
    });
    db.prepare('UPDATE entity SET portrait_path = ? WHERE id = ? AND portrait_path IS NULL').run(portrait.path, row.id);
  });
}

/** Gives every faction and deity still missing one an emblem; returns how many were queued. */
export function backfillEmblems(db: Db, campaignId: number): number {
  if (!autoPortraitsOn(db, campaignId)) return 0;
  const rows = db
    .prepare(
      `SELECT id, campaign_id, kind, name, summary, portrait_path FROM entity
        WHERE campaign_id = ? AND kind IN ('faction', 'deity') AND portrait_path IS NULL
        ORDER BY id`,
    )
    .all(campaignId) as EmblemRow[];
  for (const row of rows) scheduleEntityEmblem(db, row);
  return rows.length;
}

/** What the model is told a generic creature looks like: the stat block's own words. */
export function creatureLook(block: CreatureStatBlock): string {
  return [`${block.size} ${block.type}`.toLowerCase(), block.alignment].filter(Boolean).join(', ');
}

export interface CombatantPortraitTarget {
  id: number;
  /** The name on the token, which may be the creature type, "Goblin Warrior 2" or "Grask the Bloody". */
  name: string;
  /** The SRD creature it is, e.g. "Goblin Warrior". */
  creature: string;
  description: string;
  /** The DM said this one is somebody, whatever it is called. */
  unique?: boolean;
}

/**
 * A combatant called something other than its creature type is somebody - "Grask the Bloody", and so is
 * any named humanoid, which is the same test. "Goblin Warrior 2" is still one of the goblins.
 */
function isIndividual(target: { name: string; creature: string; unique?: boolean }): boolean {
  if (target.unique) return true;
  return target.name.replace(/\s+\d+$/, '').trim().toLowerCase() !== target.creature.trim().toLowerCase();
}

function statBlockName(json: string | null): string | null {
  if (!json) return null;
  try {
    return (JSON.parse(json) as CreatureStatBlock).name;
  } catch {
    return null;
  }
}

/**
 * Hands the type's portraits round-robin, in id order, to every combatant of it still without one, so
 * the goblins of a fight keep the faces they were dealt even when reinforcements arrive.
 */
export function dealCreatureVariants(db: Db, campaignId: number, creature: string): void {
  const paths = creaturePortraitPaths(db, campaignId, creature);
  const encounter = activeEncounter(db, campaignId);
  if (paths.length === 0 || !encounter) return;
  const rows = db
    .prepare('SELECT id, name, stat_block_json, portrait_path FROM combatant WHERE encounter_id = ? ORDER BY id')
    .all(encounter.id) as Array<{ id: number; name: string; stat_block_json: string | null; portrait_path: string | null }>;
  rows
    .filter(
      (row) =>
        statBlockName(row.stat_block_json)?.toLowerCase() === creature.trim().toLowerCase() &&
        !isIndividual({ name: row.name, creature }),
    )
    .forEach((row, index) => {
      if (row.portrait_path === null) setCombatantPortrait(db, row.id, paths[index % paths.length]!);
    });
}

function scheduleIndividual(db: Db, campaignId: number, target: CombatantPortraitTarget): void {
  const existing = individualPortraitPath(db, campaignId, target.name);
  if (existing) {
    setCombatantPortrait(db, target.id, existing);
    return;
  }
  enqueue(`individual ${target.name}`, async () => {
    const portrait = await generatePortrait({
      db,
      campaign_id: campaignId,
      subject: { creature: target.name, kind: 'individual' },
      description: target.description.slice(0, DESCRIPTION_LIMIT),
    });
    setCombatantPortrait(db, target.id, portrait.path);
  });
}

/** The enemies of a fight: one portrait per creature type that has none, one per individual. */
export function scheduleCombatantPortraits(db: Db, campaignId: number, targets: CombatantPortraitTarget[]): void {
  if (!autoPortraitsOn(db, campaignId)) return;
  const generic = new Map<string, CombatantPortraitTarget>();
  for (const target of targets) {
    if (isIndividual(target)) scheduleIndividual(db, campaignId, target);
    else generic.set(target.creature.trim().toLowerCase(), target);
  }
  for (const target of generic.values()) {
    const creature = target.creature;
    if (creaturePortraitPaths(db, campaignId, creature).length > 0) {
      dealCreatureVariants(db, campaignId, creature);
      continue;
    }
    enqueue(`creature ${creature}`, async () => {
      await generatePortrait({
        db,
        campaign_id: campaignId,
        subject: { creature },
        description: target.description,
      });
      dealCreatureVariants(db, campaignId, creature);
    });
  }
}

/** generate_portrait with combatant_id: the DM draws one fighter the way they describe them. */
export async function generateCombatantPortrait(input: {
  db: Db;
  campaign_id: number;
  combatant_id: number;
  description: string;
  style?: PortraitStyle;
}): Promise<{ name: string; path: string; prompt: string; style: PortraitStyle }> {
  const row = input.db
    .prepare(
      `SELECT c.id, c.name FROM combatant c JOIN encounter e ON e.id = c.encounter_id
        WHERE c.id = ? AND e.campaign_id = ?`,
    )
    .get(input.combatant_id, input.campaign_id) as { id: number; name: string } | undefined;
  if (!row) {
    throw new Error(
      `Campaign ${input.campaign_id} has no combatant ${input.combatant_id}. Call get_battle_state for the ids.`,
    );
  }
  const portrait = await generatePortrait({
    db: input.db,
    campaign_id: input.campaign_id,
    subject: { creature: row.name, kind: 'individual' },
    description: input.description,
    style: input.style,
  });
  setCombatantPortrait(input.db, row.id, portrait.path);
  return portrait;
}
