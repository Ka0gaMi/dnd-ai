// Combat engine: concentration, timed effects and their ending.
import {
  countFeatureUse,
  concentrationSaveDc,
  setCondition as setPcCondition,
} from '../core/character.js';
import { type Advantage } from '../core/dice.js';
import { type Ability } from '../core/rules.js';
import { conditionNames } from '../srd/lookup.js';
import type { Db } from '../db/connection.js';
import { conditionRule } from './conditions.js';
import { hasFeature, isRaging, relentlessRageDc, RELENTLESS_RAGE_USES } from './features.js';
import { underSnapshot } from './undo.js';
import {
  effectsFor,
  getCombatant,
  listCombatants,
  listEffects,
  logCombat,
  requireEncounter,
  saveCombatant,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
  type Effect,
} from './state.js';
import { type PreRoll, partyHp, finish, sheetOf, immuneTo } from './engine-core.js';
import { rollDamage } from './damage-math.js';
import { rollSave } from './d20.js';
import {
  characterOf,
  mirrorCharacter,
  addCondition,
  damageCombatant,
  healCombatant,
} from './hp.js';

/** Ends everything a combatant holds with its concentration and clears the concentration itself. */
export function endConcentration(db: Db, encounter: EncounterRow, holder: Combatant, reason: string): CombatLogEntry[] {
  const held = listEffects(db, encounter.id).filter(
    (e) => e.concentration_of === holder.id || (e.ends === 'concentration' && e.source_id === holder.id),
  );
  const entries: CombatLogEntry[] = [];
  for (const effect of held) {
    endEffect(db, encounter, effect);
    const on = getCombatant(db, encounter.id, effect.target_id);
    entries.push(
      logCombat(db, encounter, {
        actor_id: holder.id,
        target_id: on.id,
        kind: 'effect_end',
        payload: { effect_id: effect.id, name: effect.name, reason },
        text: `${effect.name} ends on ${on.name} (${reason}).`,
      }),
    );
  }
  // Ending the effects may have stripped a condition off this very combatant: re-read before saving.
  const after = getCombatant(db, encounter.id, holder.id);
  if (after.concentration) {
    after.concentration = null;
    saveCombatant(db, after);
  }
  holder.concentration = null;
  holder.conditions = after.conditions;
  return entries;
}

/** Damage while concentrating: CON save against DC max(10, half the damage), up to 30, failure ends the effects. */
async function concentrationCheck(
  db: Db,
  encounter: EncounterRow,
  target: Combatant,
  damage: number,
  tool: string,
): Promise<CombatLogEntry[]> {
  // Dropping to 0 HP or dying breaks concentration outright, flag set or not: no save is rolled.
  if (!target.alive || target.hp_current === 0) {
    return endConcentration(db, encounter, target, target.alive ? 'down at 0 HP' : 'dead');
  }
  if (!target.concentration || damage <= 0) return [];
  // Relentless Hunter: taking damage cannot break a Ranger's hold on Hunter's Mark.
  const holder = sheetOf(db, target);
  if (holder && /hunter.s mark/i.test(target.concentration.name) && hasFeature(holder, 'ranger-relentless-hunter')) {
    return [
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'concentration',
        payload: { held: true, spell: target.concentration.name, feature: 'Relentless Hunter' },
        text: `${target.name} keeps ${target.concentration.name} up: Relentless Hunter means damage cannot break it.`,
      }),
    ];
  }
  const dc = concentrationSaveDc(damage);
  const save = await rollSave(db, encounter, target, 'con', dc, {
    tool,
    concentration: true,
    // Extended Spell bought Advantage on exactly these saves when the casting went up.
    ...(target.concentration.advantage ? { advantage: 'advantage' as Advantage } : {}),
  });
  const entries: CombatLogEntry[] = [];
  if (save.success) {
    entries.push(
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'concentration',
        payload: { save, held: true, spell: target.concentration.name },
        text: `${target.name} holds concentration on ${target.concentration.name} (CON save ${save.total} vs DC ${dc}).`,
      }),
    );
    return entries;
  }
  const spell = target.concentration.name;
  const ended = endConcentration(db, encounter, target, `failed concentration save on ${spell}`);
  entries.push(
    logCombat(db, encounter, {
      actor_id: target.id,
      kind: 'concentration',
      payload: { save, held: false, spell, effects_ended: ended.map((e) => (e.payload as { effect_id: number }).effect_id) },
      text: `${target.name} loses concentration on ${spell} (CON save ${save.total} vs DC ${dc}).`,
    }),
  );
  entries.push(...ended);
  return entries;
}

/**
 * A turned creature's Frightened and Incapacitated end the moment it takes damage, however much of the
 * minute was left. Nothing else in the fight ends this way, so the effects are named on the flag itself.
 */
function endTurning(db: Db, encounter: EncounterRow, target: Combatant, damage: number): CombatLogEntry[] {
  const turned = target.flags.turned;
  if (!turned || damage <= 0) return [];
  const fresh = getCombatant(db, encounter.id, target.id);
  fresh.flags = { ...fresh.flags, turned: undefined };
  saveCombatant(db, fresh);
  for (const effect of listEffects(db, encounter.id)) {
    if (turned.effect_ids.includes(effect.id)) endEffect(db, encounter, effect);
  }
  const after = getCombatant(db, encounter.id, target.id);
  target.flags = after.flags;
  target.conditions = after.conditions;
  return [
    logCombat(db, encounter, {
      target_id: target.id,
      kind: 'feature_note',
      payload: { feature: turned.feature, ended: true },
      text: `${target.name} is no longer turned: ${turned.feature} ends the moment it takes damage.`,
    }),
  ];
}

/**
 * Relentless Rage: a raging Barbarian dropped to 0 makes a Constitution save - DC 10, and 5 more for each
 * time it has already held in this fight - and stands back up on twice their level in hit points.
 */
async function relentlessRage(db: Db, encounter: EncounterRow, target: Combatant, tool: string): Promise<CombatLogEntry[]> {
  if (!target.alive || target.hp_current > 0 || !isRaging(target)) return [];
  const sheet = sheetOf(db, target);
  if (!sheet || !hasFeature(sheet, 'barbarian-relentless-rage') || !target.character_id) return [];
  const dc = relentlessRageDc(sheet);
  const save = await rollSave(db, encounter, target, 'con', dc, { tool });
  // "Each time you use this feature after the first, the DC increases by 5": the use is the attempt, and
  // the count sits on the sheet, so it outlives the fight and goes back to nothing on a rest.
  const used = countFeatureUse(db, {
    campaign_id: encounter.campaign_id,
    character_id: target.character_id,
    ...RELENTLESS_RAGE_USES,
  });
  const next = 10 + 5 * used;
  if (!save.success) {
    return [
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'feature_save',
        payload: { feature: 'Relentless Rage', save, applied: false, next_dc: next },
        text: `${target.name}'s rage is not enough this time (CON save ${save.total} vs DC ${dc}). The next one is DC ${next}.`,
      }),
    ];
  }
  const back = sheet.level * 2;
  healCombatant(db, encounter, target, back);
  const fresh = getCombatant(db, encounter.id, target.id);
  target.flags = fresh.flags;
  target.hp_current = fresh.hp_current;
  target.conditions = fresh.conditions;
  return [
    logCombat(db, encounter, {
      actor_id: target.id,
      kind: 'feature_note',
      payload: { feature: 'Relentless Rage', save, hp_current: fresh.hp_current, next_dc: next },
      text: `${target.name} refuses to fall (CON save ${save.total} vs DC ${dc}): Relentless Rage puts them back on ${back} hit points. The next one is DC ${next}.`,
    }),
  ];
}

/** What a blow that landed costs besides hit points: a turning it breaks, then the Concentration save. */
export async function afterDamage(
  db: Db,
  encounter: EncounterRow,
  target: Combatant,
  damage: number,
  tool: string,
): Promise<CombatLogEntry[]> {
  return [
    ...endTurning(db, encounter, target, damage),
    ...(await relentlessRage(db, encounter, target, tool)),
    ...(await concentrationCheck(db, encounter, target, damage, tool)),
  ];
}

// --- effects ----------------------------------------------------------------

export interface EffectInput {
  target_id: number;
  source_id?: number | null;
  name: string;
  kind: 'damage' | 'condition' | 'buff';
  damage_expr?: string;
  damage_type?: string;
  save_ability?: Ability;
  save_dc?: number;
  tick?: 'start' | 'end';
  ends?: Effect['ends'];
  remaining_rounds?: number;
  concentration_of?: number | null;
}

function insertEffect(db: Db, encounter: EncounterRow, input: EffectInput): Effect {
  const id = Number(
    db
      .prepare(
        `INSERT INTO effect (encounter_id, target_id, source_id, name, kind, damage_expr, damage_type, save_ability,
           save_dc, tick, ends, remaining_rounds, concentration_of, created_round)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        encounter.id,
        input.target_id,
        input.source_id ?? null,
        input.name,
        input.kind,
        input.damage_expr ?? null,
        input.damage_type ?? null,
        input.save_ability ?? null,
        input.save_dc ?? null,
        input.tick ?? 'start',
        input.ends ?? 'manual',
        input.remaining_rounds ?? null,
        input.concentration_of ?? null,
        encounter.round,
      ).lastInsertRowid,
  );
  return listEffects(db, encounter.id).find((e) => e.id === id)!;
}

/** A condition effect owns its condition: it goes on when the effect starts and off when it ends. */
function removeEffectCondition(db: Db, encounter: EncounterRow, effectId: number): void {
  const effect = listEffects(db, encounter.id, false).find((e) => e.id === effectId);
  if (!effect || effect.kind !== 'condition') return;
  const target = getCombatant(db, encounter.id, effect.target_id);
  const still = listEffects(db, encounter.id).some(
    (e) => e.id !== effectId && e.kind === 'condition' && e.target_id === target.id && e.name === effect.name,
  );
  if (still) return;
  target.conditions = target.conditions.filter((c) => c !== effect.name);
  saveCombatant(db, target);
  const characterId = characterOf(target);
  if (characterId && conditionNames().includes(effect.name)) {
    setPcCondition(db, { campaign_id: encounter.campaign_id, character_id: characterId, condition: effect.name, active: false, mirror: false });
    mirrorCharacter(db, target);
    saveCombatant(db, target);
  }
}

export function endEffect(db: Db, encounter: EncounterRow, effect: Effect): void {
  db.prepare('UPDATE effect SET active = 0 WHERE id = ?').run(effect.id);
  removeEffectCondition(db, encounter, effect.id);
}

/** Rolls every effect due on this combatant's turn: damage, save-ends saves, round countdowns. */
export async function tickEffects(
  db: Db,
  encounter: EncounterRow,
  combatantId: number,
  when: 'start' | 'end',
  rolls?: Record<string, PreRoll>,
  tool = 'advance_turn',
): Promise<CombatLogEntry[]> {
  const entries: CombatLogEntry[] = [];
  for (const effect of effectsFor(db, encounter.id, combatantId, when)) {
    const target = getCombatant(db, encounter.id, combatantId);
    if (!target.alive) break;

    if (effect.damage_expr) {
      const rolled = rollDamage(effect.damage_expr, false);
      const result = damageCombatant(db, encounter, target, {
        amount: rolled.total,
        type: effect.damage_type,
        source: effect.name,
      });
      entries.push(
        logCombat(db, encounter, {
          actor_id: effect.source_id,
          target_id: target.id,
          kind: 'effect_tick',
          payload: { effect_id: effect.id, name: effect.name, roll: rolled, result },
          text: `${effect.name} deals ${result.applied} ${effect.damage_type ?? ''} damage to ${target.name} (${rolled.output}${
            result.resistance ? `, ${result.resistance}` : ''
          })${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      entries.push(...(await afterDamage(db, encounter, target, result.applied, tool)));
      if (result.dead) entries.push(killEntry(db, encounter, target, effect.name));
    }

    if (effect.ends === 'save' && effect.save_ability && effect.save_dc !== null) {
      const save = await rollSave(db, encounter, target, effect.save_ability as Ability, effect.save_dc, {
        roll: rolls?.[String(target.id)],
        tool,
      });
      entries.push(
        logCombat(db, encounter, {
          target_id: target.id,
          kind: 'save',
          payload: { effect_id: effect.id, save, ends_effect: save.success },
          text: `${target.name} rolls ${save.total} against ${effect.name} (DC ${effect.save_dc} ${effect.save_ability.toUpperCase()}): ${save.success ? 'the effect ends' : 'it continues'}.`,
        }),
      );
      if (save.success) {
        endEffect(db, encounter, effect);
        continue;
      }
    }

    if (effect.ends === 'rounds') {
      const remaining = (effect.remaining_rounds ?? 1) - 1;
      db.prepare('UPDATE effect SET remaining_rounds = ? WHERE id = ?').run(remaining, effect.id);
      if (remaining <= 0) {
        endEffect(db, encounter, effect);
        entries.push(
          logCombat(db, encounter, {
            target_id: target.id,
            kind: 'effect_end',
            payload: { effect_id: effect.id, name: effect.name },
            text: `${effect.name} ends on ${target.name}.`,
          }),
        );
      }
    }
  }
  return entries;
}

export function killEntry(db: Db, encounter: EncounterRow, target: Combatant, source: string): CombatLogEntry {
  return logCombat(db, encounter, {
    target_id: target.id,
    kind: 'kill',
    payload: { name: target.name, source },
    text: `${target.name} drops dead.`,
  });
}

/** What a condition does the moment it lands: speed 0 stops the turn, incapacitation breaks concentration. */
function conditionLanded(db: Db, encounter: EncounterRow, target: Combatant, condition: string): CombatLogEntry[] {
  const rule = conditionRule(condition);
  if (!rule) return [];
  const fresh = getCombatant(db, encounter.id, target.id);
  if (rule.speed_zero && fresh.movement_left > 0) {
    fresh.movement_left = 0;
    saveCombatant(db, fresh);
    target.movement_left = 0;
  }
  if (!rule.incapacitated || !fresh.concentration) return [];
  const entries = endConcentration(db, encounter, fresh, `${fresh.name} is ${condition}`);
  target.concentration = null;
  return entries;
}

export function attachEffect(
  db: Db,
  encounter: EncounterRow,
  input: EffectInput,
): { effect: Effect; entry: CombatLogEntry; landed: CombatLogEntry[]; ended: CombatLogEntry[] } {
  // A creature holds one concentration, so an effect that starts its source's concentration ends
  // whatever that source already held. The second target of one casting is not a new concentration:
  // the casting path says so with concentration_of, and the DM's effect {op: apply} door, which has no such
  // field, says it by naming the same effect again.
  const ended: CombatLogEntry[] = [];
  if (input.ends === 'concentration' && input.source_id != null && input.concentration_of !== input.source_id) {
    const source = listCombatants(db, encounter.id).find((c) => c.id === input.source_id);
    const held = listEffects(db, encounter.id).filter(
      (e) => e.active && e.ends === 'concentration' && e.source_id === input.source_id,
    );
    const sameCasting = held.some((e) => e.name.toLowerCase() === input.name.toLowerCase());
    if (source?.concentration && !sameCasting) {
      ended.push(...endConcentration(db, encounter, source, `${source.name} starts concentrating on ${input.name}`));
    }
  }
  const effect = insertEffect(db, encounter, input);
  const target = getCombatant(db, encounter.id, input.target_id);
  if (effect.kind === 'condition') {
    addCondition(target, effect.name);
    saveCombatant(db, target);
    const characterId = characterOf(target);
    if (characterId && conditionNames().includes(effect.name)) {
      setPcCondition(db, { campaign_id: encounter.campaign_id, character_id: characterId, condition: effect.name, active: true, mirror: false });
      mirrorCharacter(db, target);
      saveCombatant(db, target);
    }
  }
  // An effect that ends with its source's concentration makes that source concentrate, if it is not already.
  if (effect.ends === 'concentration' && effect.source_id !== null) {
    const source = listCombatants(db, encounter.id).find((c) => c.id === effect.source_id);
    if (source && !source.concentration) {
      source.concentration = { name: effect.name };
      saveCombatant(db, source);
    }
  }
  const landed = effect.kind === 'condition' ? conditionLanded(db, encounter, target, effect.name) : [];
  const entry = logCombat(db, encounter, {
    actor_id: effect.source_id,
    target_id: target.id,
    kind: 'effect_start',
    payload: { effect },
    text: `${target.name} is affected by ${effect.name} (${effect.kind}${
      effect.damage_expr ? `, ${effect.damage_expr} ${effect.damage_type ?? ''} at the ${effect.tick} of their turn` : ''
    }${effect.ends === 'rounds' ? `, ${effect.remaining_rounds} rounds` : ''}${
      effect.ends === 'save' ? `, DC ${effect.save_dc} ${effect.save_ability?.toUpperCase()} ends` : ''
    }).`,
  });
  return { effect, entry, landed, ended };
}

export function applyEffect(db: Db, input: EffectInput & { campaign_id: number }) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'effect', () => runApplyEffect(db, input));
}

function runApplyEffect(db: Db, input: EffectInput & { campaign_id: number }) {
  const encounter = requireEncounter(db, input.campaign_id);
  const target = getCombatant(db, encounter.id, input.target_id);
  const immune = input.kind === 'condition' ? immuneTo(db, encounter, target, input.name) : null;
  if (immune) throw new Error(`${immune} Apply something else, or leave it off.`);
  const { effect, entry, landed, ended } = attachEffect(db, encounter, input);
  return finish(db, encounter, 'effect', `${input.name} applied.`, [...ended, entry, ...landed], { effect });
}

/** The manual way out: ends one effect by id, whatever it was waiting for. */
export function endEffectById(db: Db, input: { campaign_id: number; effect_id: number }) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'effect', () => runEndEffectById(db, input));
}

function runEndEffectById(db: Db, input: { campaign_id: number; effect_id: number }) {
  const encounter = requireEncounter(db, input.campaign_id);
  const effect = listEffects(db, encounter.id, false).find((e) => e.id === input.effect_id);
  if (!effect) throw new Error(`No effect ${input.effect_id} in this encounter. Call get_battle_state for the ids.`);
  if (!effect.active) throw new Error(`Effect ${effect.id} (${effect.name}) has already ended.`);
  const target = getCombatant(db, encounter.id, effect.target_id);
  endEffect(db, encounter, effect);
  const entry = logCombat(db, encounter, {
    actor_id: effect.source_id,
    target_id: target.id,
    kind: 'effect_end',
    payload: { effect_id: effect.id, name: effect.name, reason: 'ended by the DM' },
    text: `${effect.name} ends on ${target.name}.`,
  });
  return finish(db, encounter, 'effect', `${effect.name} ends on ${target.name}.`, [entry], {
    effect_id: effect.id,
    target_id: target.id,
  });
}

export function setCombatCondition(db: Db, input: Parameters<typeof runSetCombatCondition>[1]) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'condition', () =>
    runSetCombatCondition(db, input),
  );
}

function runSetCombatCondition(
  db: Db,
  input: { campaign_id: number; combatant_id: number; condition: string; active: boolean; duration_rounds?: number },
) {
  const encounter = requireEncounter(db, input.campaign_id);
  const target = getCombatant(db, encounter.id, input.combatant_id);
  const condition = input.condition.trim().toLowerCase();
  const valid = conditionNames();
  if (!valid.includes(condition)) {
    throw new Error(`"${input.condition}" is not an SRD condition. Valid conditions: ${valid.join(', ')}.`);
  }
  const immune = input.active ? immuneTo(db, encounter, target, condition) : null;
  if (immune) throw new Error(`${immune} Nothing to apply: pick another condition or narrate it without one.`);
  const log: CombatLogEntry[] = [];

  if (input.active && input.duration_rounds) {
    const created = attachEffect(db, encounter, {
      target_id: target.id,
      name: condition,
      kind: 'condition',
      tick: 'end',
      ends: 'rounds',
      remaining_rounds: input.duration_rounds,
    });
    log.push(created.entry, ...created.landed);
  } else {
    if (input.active) addCondition(target, condition);
    else {
      target.conditions = target.conditions.filter((c) => c !== condition);
      db.prepare("UPDATE effect SET active = 0 WHERE encounter_id = ? AND target_id = ? AND kind = 'condition' AND name = ?").run(
        encounter.id,
        target.id,
        condition,
      );
    }
    saveCombatant(db, target);
    const characterId = characterOf(target);
    if (characterId) {
      setPcCondition(db, { campaign_id: encounter.campaign_id, character_id: characterId, condition, active: input.active, mirror: false });
      mirrorCharacter(db, target);
      saveCombatant(db, target);
    }
    log.push(
      logCombat(db, encounter, {
        target_id: target.id,
        kind: 'condition',
        payload: { condition, active: input.active, effect: conditionRule(condition)?.summary ?? null },
        text: `${target.name} ${input.active ? 'gains' : 'loses'} the ${condition} condition.${
          input.active && conditionRule(condition) ? ` ${conditionRule(condition)!.summary}` : ''
        }`,
      }),
    );
    if (input.active) log.push(...conditionLanded(db, encounter, target, condition));
  }

  return finish(db, encounter, 'condition', `${target.name}: ${condition} ${input.active ? 'on' : 'off'}.`, log, {
    combatant_id: target.id,
    conditions: getCombatant(db, encounter.id, target.id).conditions,
  });
}
