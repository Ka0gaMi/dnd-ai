import type { Db } from '../db/connection.js';
import { activeEncounter } from '../combat/state.js';
import { eventsSinceCheckpoint, getCharacterDraft, pcRow } from './campaign.js';
import { XP_THRESHOLDS } from './rules.js';

/** The longest next step a reply may carry. */
export const NEXT_STEP_CHARS = 120;

/** 3 rides on every reply, 1 and 2 on replies that change state; 0 is never shown. */
export type Urgency = 0 | 1 | 2 | 3;

export interface DutyNotice {
  urgency: Urgency;
  /** At most NEXT_STEP_CHARS, naming the exact next call; no free text, so the bound holds. */
  text: string;
}

export interface Duty {
  id: string;
  check: (db: Db, campaignId: number) => DutyNotice | null;
}

export type DueDuty = DutyNotice & { id: string };

const registry = new Map<string, Duty>();

/** Adds a duty and returns the call that removes it again. */
export function registerDuty(duty: Duty): () => void {
  if (registry.has(duty.id)) throw new Error(`Duty ${duty.id} is already registered.`);
  registry.set(duty.id, duty);
  return () => void registry.delete(duty.id);
}

export const registeredDuties = (): Duty[] => [...registry.values()];

/** Every duty due for the campaign, most urgent first and ties in registration order; a check that throws is skipped. */
export function dueDuties(db: Db, campaignId: number): DueDuty[] {
  const due: DueDuty[] = [];
  for (const duty of registry.values()) {
    try {
      const notice = duty.check(db, campaignId);
      if (notice) due.push({ id: duty.id, ...notice });
    } catch {
      // A broken check must never cost the reply it rides on.
    }
  }
  return due.sort((a, b) => b.urgency - a.urgency);
}

/** The most urgent duty at `min` or above, or null. */
export function topDuty(db: Db, campaignId: number, min: Urgency = 1): DueDuty | null {
  const top = dueDuties(db, campaignId)[0];
  return top && top.urgency >= min ? top : null;
}

const NAG_AFTER_EVENTS = 25;

registerDuty({
  id: 'dying',
  check: (db, campaignId) => {
    // Inside a fight advance_turn rolls the death save itself.
    if (activeEncounter(db, campaignId)) return null;
    const down = db
      .prepare("SELECT id FROM character WHERE campaign_id = ? AND status = 'active' AND hp_current = 0 AND stable = 0 ORDER BY id LIMIT 1")
      .get(campaignId) as { id: number } | undefined;
    return down
      ? { urgency: 3, text: `condition {op: death_save, character_id: ${down.id}} - they are dying at 0 HP outside a fight.` }
      : null;
  },
});

registerDuty({
  id: 'character_draft',
  check: (db, campaignId) =>
    getCharacterDraft(db, campaignId) && !pcRow(db, campaignId)
      ? { urgency: 3, text: 'create_character from the draft the player left (load_campaign shows it) before play.' }
      : null,
});

registerDuty({
  id: 'checkpoint_overdue',
  check: (db, campaignId) => {
    // Every combat call writes an event, so the save waits until the fight is over rather than interrupting it.
    if (activeEncounter(db, campaignId)) return null;
    const events = eventsSinceCheckpoint(db, campaignId);
    return events > NAG_AFTER_EVENTS
      ? { urgency: 2, text: `checkpoint {op: save} - ${events} events since the last save.` }
      : null;
  },
});

registerDuty({
  id: 'level_up',
  check: (db, campaignId) => {
    // A prepared window waits on the player, not the DM.
    const pcs = db
      .prepare(
        "SELECT id, level, xp FROM character WHERE campaign_id = ? AND is_pc = 1 AND status = 'active' AND class IS NOT NULL AND pending_level_up_json IS NULL ORDER BY id",
      )
      .all(campaignId) as Array<{ id: number; level: number; xp: number }>;
    const ready = pcs.find((pc) => pc.xp >= (XP_THRESHOLDS[pc.level] ?? Infinity));
    return ready
      ? {
          urgency: 1,
          text: `propose_level_up_options {character_id: ${ready.id}} - they have the XP for level ${ready.level + 1}.`,
        }
      : null;
  },
});
