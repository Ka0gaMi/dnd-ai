// Combat engine: hit points, knock-outs and conditions on the character mirror.
import {
  applyDamage as applyPcDamage,
  heal as healPc,
  setCondition as setPcCondition,
} from '../core/character.js';
import { conditionNames } from '../srd/lookup.js';
import type { Db } from '../db/connection.js';
import { combatSheet } from './sheet.js';
import {
  getCombatant,
  logCombat,
  saveCombatant,
  type Combatant,
  type EncounterRow,
} from './state.js';
import { damageLinesOf, damageFactor, damageNote, type DamageResult } from './damage-math.js';

/** PCs and companions own a character row: their HP, conditions and death saves live there, not here. */
export const characterOf = (combatant: Combatant): number | null =>
  combatant.kind === 'monster' ? null : combatant.character_id;

/** Mirrors a character's own row back into the combatant after character.ts has changed it. */
export function mirrorCharacter(db: Db, combatant: Combatant): void {
  if (!combatant.character_id) return;
  const sheet = combatSheet(db, combatant.character_id);
  combatant.hp_current = sheet.hp_current;
  combatant.hp_max = sheet.hp_max;
  combatant.temp_hp = sheet.temp_hp;
  combatant.conditions = sheet.conditions;
  combatant.death_saves = sheet.death_saves;
  combatant.alive = sheet.status !== 'dead';
}

export function addCondition(combatant: Combatant, condition: string): void {
  if (!combatant.conditions.includes(condition)) combatant.conditions.push(condition);
}

/** The 2024 Unconscious condition carries Prone, and a character's sheet keeps it after waking. */
function fallUnconscious(db: Db, encounter: EncounterRow, target: Combatant): void {
  addCondition(target, 'unconscious');
  addCondition(target, 'prone');
  const characterId = characterOf(target);
  if (characterId) {
    setPcCondition(db, {
      campaign_id: encounter.campaign_id,
      character_id: characterId,
      condition: 'prone',
      active: true,
      mirror: false,
    });
  }
}

/** SRD 2024 Knock Out: the creature is left at 1 HP and Unconscious, and it starts a Short Rest. */
function logKnockOut(db: Db, encounter: EncounterRow, target: Combatant): void {
  logCombat(db, encounter, {
    target_id: target.id,
    kind: 'knock_out',
    payload: { name: target.name, hp_current: target.hp_current },
    // The SRD's "starts a Short Rest" is not modelled: a rest is refused during a fight. What has
    // teeth is the waking rule, which is the DM's to apply.
    text: `${target.name} is knocked out rather than killed: 1 HP and unconscious, until they regain any hit points or someone spends an action on first aid (DC 10 Wisdom (Medicine)).`,
  });
}

/** Whether a combatant is at 0 HP and alive right now; Relentless Rage can undo a drop inside afterDamage. */
export function isDowned(db: Db, encounter: EncounterRow, id: number): boolean {
  const now = getCombatant(db, encounter.id, id);
  return now.hp_current === 0 && now.alive;
}

/**
 * Applies damage of one type to one combatant. The PC and companions go through character.ts so their
 * sheets stay the single source of truth; monsters are resolved here against the combatant row.
 */
export function damageCombatant(
  db: Db,
  encounter: EncounterRow,
  target: Combatant,
  input: {
    amount: number;
    type?: string | null;
    source?: string;
    critical?: boolean;
    knock_out?: boolean;
    /** Boon of Irresistible Offense: this damage is not softened by Resistance. */
    ignore_resistance?: boolean;
    /** Overchannel's backlash: neither Resistance nor Immunity softens it. */
    ignore_immunity?: boolean;
  },
): DamageResult {
  const read = damageFactor(damageLinesOf(db, target), input.type ?? null);
  // Overchannel's backlash ignores Resistance and Immunity; the Boon of Irresistible Offense only
  // Resistance. Vulnerability is never cancelled by either.
  const immune = read.immune && input.ignore_immunity !== true;
  const resisted = read.resistant && input.ignore_resistance !== true && input.ignore_immunity !== true;
  const note = damageNote(read, input.ignore_resistance === true || input.ignore_immunity === true, input.ignore_immunity === true);
  // SRD 2024 order: Resistance halves and rounds down first, then Vulnerability doubles what is left.
  const adjust = (amount: number): number => {
    if (immune) return 0;
    const afterResistance = resisted ? Math.floor(amount / 2) : amount;
    return read.vulnerable ? afterResistance * 2 : afterResistance;
  };
  // Pulling the blow: the damage stops at 0 HP, so nobody is killed outright by it.
  const applied = input.knock_out ? Math.min(adjust(input.amount), target.hp_current) : adjust(input.amount);

  const characterId = characterOf(target);
  let knockedOut = false;
  if (characterId) {
    const pcResult = applyPcDamage(db, {
      campaign_id: encounter.campaign_id,
      character_id: characterId,
      amount: applied,
      type: input.type ?? undefined,
      source: input.source,
      critical: input.critical,
      mirror: false,
    });
    // 2024 Knock Out: a pulled blow that lands leaves them at 1 HP and Unconscious, not dying at 0.
    // Only a blow that lands, though - hitting someone already at 0 costs them death saves
    // (2024: an automatic critical, two failures), it does not tuck them in.
    knockedOut = input.knock_out === true && applied > 0 && pcResult.hp_current === 0 && pcResult.status !== 'dead';
    if (knockedOut) {
      // Healing to 1 HP clears the Unconscious the blow just gave them, so it goes back on the sheet.
      healPc(db, { campaign_id: encounter.campaign_id, character_id: characterId, amount: 1, mirror: false });
      setPcCondition(db, {
        campaign_id: encounter.campaign_id,
        character_id: characterId,
        condition: 'unconscious',
        active: true,
        mirror: false,
      });
      fallUnconscious(db, encounter, target);
    } else if (pcResult.hp_current === 0 && pcResult.status !== 'dead') {
      // A character dropped to 0 has the Unconscious condition, which brings Prone with it; a dead one
      // is a corpse and keeps neither.
      fallUnconscious(db, encounter, target);
    }
    mirrorCharacter(db, target);
    saveCombatant(db, target);
    if (knockedOut) logKnockOut(db, encounter, target);
    return {
      rolled: input.amount,
      applied,
      absorbed_by_temp_hp: pcResult.absorbed_by_temp_hp,
      resistance: note,
      hp_current: target.hp_current,
      hp_max: target.hp_max,
      downed: target.hp_current === 0 && target.alive,
      dead: !target.alive,
    };
  }

  const absorbed = Math.min(target.temp_hp, applied);
  target.temp_hp -= absorbed;
  const remaining = applied - absorbed;
  if (remaining > 0) {
    const after = target.hp_current - remaining;
    if (after <= 0) {
      target.hp_current = 0;
      if (input.knock_out) {
        // 2024 Knock Out: 1 HP and Unconscious, and it starts a Short Rest; no stable flag is needed.
        target.hp_current = 1;
        fallUnconscious(db, encounter, target);
        target.death_saves = { successes: 0, failures: 0 };
        target.flags = { ...target.flags, stable: undefined };
        knockedOut = true;
      } else if (target.kind === 'monster' || -after >= target.hp_max) target.alive = false;
      else {
        fallUnconscious(db, encounter, target);
        target.death_saves = { successes: 0, failures: 0 };
      }
    } else {
      target.hp_current = after;
    }
  }
  // A corpse is dead, not unconscious: it keeps neither the Unconscious nor the Prone a fall would add.
  if (!target.alive) target.conditions = target.conditions.filter((c) => c !== 'unconscious' && c !== 'prone');
  saveCombatant(db, target);
  if (knockedOut) logKnockOut(db, encounter, target);
  return {
    rolled: input.amount,
    applied,
    absorbed_by_temp_hp: absorbed,
    resistance: note,
    hp_current: target.hp_current,
    hp_max: target.hp_max,
    downed: target.hp_current === 0 && target.alive,
    dead: !target.alive,
  };
}

/**
 * Reads the hit points back into a combatant object the caller is still holding. Anything that heals or
 * hurts the actor itself writes the stored row, and saving the stale object afterwards would undo it.
 */
export function refreshVitals(db: Db, encounter: EncounterRow, combatant: Combatant): void {
  const fresh = getCombatant(db, encounter.id, combatant.id);
  combatant.hp_current = fresh.hp_current;
  combatant.hp_max = fresh.hp_max;
  combatant.temp_hp = fresh.temp_hp;
  combatant.conditions = fresh.conditions;
  combatant.death_saves = fresh.death_saves;
  combatant.alive = fresh.alive;
}

export function healCombatant(db: Db, encounter: EncounterRow, target: Combatant, amount: number): void {
  const characterId = characterOf(target);
  if (characterId) {
    healPc(db, { campaign_id: encounter.campaign_id, character_id: characterId, amount, mirror: false });
    mirrorCharacter(db, target);
  } else {
    target.hp_current = Math.min(target.hp_max, target.hp_current + amount);
    if (target.hp_current > 0) {
      target.conditions = target.conditions.filter((c) => c !== 'unconscious');
      target.death_saves = { successes: 0, failures: 0 };
    }
  }
  saveCombatant(db, target);
}

/** Takes one condition off a combatant and its sheet, and ends the effects that were holding it there. */
export function dropCondition(db: Db, encounter: EncounterRow, target: Combatant, condition: string): void {
  const fresh = getCombatant(db, encounter.id, target.id);
  fresh.conditions = fresh.conditions.filter((c) => c !== condition);
  db.prepare(
    "UPDATE effect SET active = 0 WHERE encounter_id = ? AND target_id = ? AND kind = 'condition' AND name = ?",
  ).run(encounter.id, fresh.id, condition);
  saveCombatant(db, fresh);
  const characterId = characterOf(fresh);
  if (characterId && conditionNames().includes(condition)) {
    setPcCondition(db, {
      campaign_id: encounter.campaign_id,
      character_id: characterId,
      condition,
      active: false,
      mirror: false,
    });
    mirrorCharacter(db, fresh);
    saveCombatant(db, fresh);
  }
  target.conditions = fresh.conditions;
}
