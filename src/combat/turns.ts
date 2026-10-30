// Combat engine: turn edges, death saves and advancing the turn.
import { rollAndRecord } from '../core/campaign.js';
import { deathSave as pcDeathSave } from '../core/character.js';
import { rollDice } from '../core/dice.js';
import type { Db } from '../db/connection.js';
import { legalActions } from './actions.js';
import { exhaustionPenalty, isIncapacitated, speedZeroBy } from './conditions.js';
import { hasFeature, holyNimbusDamage, turnOutcomes } from './features.js';
import { distanceBetween } from './grid.js';
import { underSnapshot } from './undo.js';
import {
  activeCombatant,
  getCombatant,
  listCombatants,
  logCombat,
  requireEncounter,
  saveCombatant,
  type Combatant,
  type CombatFlags,
  type CombatLogEntry,
  type EncounterRow,
} from './state.js';
import {
  type PreRoll,
  partyHp,
  refresh,
  finish,
  sheetOf,
  auraSources,
  pcLuck,
} from './engine-core.js';
import { askPlayer, d20Context } from './d20.js';
import { characterOf, mirrorCharacter, isDowned, damageCombatant } from './hp.js';
import { afterDamage, tickEffects } from './effects.js';
import { droppedToZero, afterKill, applyOutcome } from './outcome.js';
import { revertWildShape } from './spells.js';
import { reachOf } from './movement.js';
import { expireMastery } from './mastery.js';
import { releaseGrapple } from './standard-actions.js';
import { expireSourceRiders } from './riders.js';

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
      text: `${actor.name} starts its turn in ${burning.from.name}'s Holy Nimbus and takes ${result.applied} Radiant damage${
        result.resistance ? ` (${result.resistance})` : ''
      }${partyHp(actor, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
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
 * better counts as the 20 that puts them back on their feet. A Bless or Bane die is rolled here too.
 */
function serverDeathSave(
  db: Db,
  encounter: EncounterRow,
  combatant: Combatant,
  dice: string,
): (PreRoll & { output: string }) | undefined {
  const survivor = defiesDeath(db, combatant);
  if (!survivor && !dice) return undefined;
  // Every roll handed to deathSave carries its own exhaustion, because deathSave only applies the
  // penalty to a roll it made itself.
  const tired = exhaustionPenalty(sheetOf(db, combatant)?.exhaustion ?? 0);
  // Recorded here, since deathSave records only a roll it makes itself.
  const rolled = rollAndRecord(db, {
    expr: `${tired ? `1d20${tired}` : '1d20'}${dice}`,
    purpose: 'Death saving throw',
    campaign_id: encounter.campaign_id,
    advantage: survivor ? 'advantage' : 'none',
    dc: 10,
    roll_type: 'save',
    luck_bias: pcLuck(db, encounter, combatant),
  });
  const natural = rolled.natural_d20 ?? rolled.total;
  if (!survivor) return { total: rolled.total, natural, output: rolled.output };
  return countsAsTwenty({ total: rolled.total, natural, output: `${rolled.output} with Advantage (Survivor)` });
}

/** A downed PC or companion rolls a death save at the start of its turn, by the same SRD rules. */
async function rollDeathSave(db: Db, encounter: EncounterRow, combatant: Combatant): Promise<CombatLogEntry> {
  // Survivor holds whoever makes the roll: the player's card carries the Advantage and the 18+ rule too.
  const survivor = defiesDeath(db, combatant);
  // The character's death save takes exhaustion off the total, so the card has to show it or the
  // window judges the bare face and calls a failed save a success.
  const tired = exhaustionPenalty(sheetOf(db, combatant)?.exhaustion ?? 0);
  // Bless and Bane ride on any saving throw, a death save included.
  const dice = d20Context(db, encounter, combatant, { kind: 'save' }).dice;
  const clicked = await askPlayer(db, encounter, combatant, 'death_save', {
    tool: 'advance_turn',
    expr: `${tired ? `1d20${tired}` : '1d20'}${dice}`,
    purpose: survivor ? 'Death saving throw (Survivor: Advantage, an 18+ counts as a 20)' : 'Death saving throw',
    roll_type: 'save',
    dc: 10,
    ...(survivor ? { advantage: 'advantage' as const } : {}),
  });
  const pre = clicked
    ? survivor
      ? countsAsTwenty(clicked)
      : clicked
    : serverDeathSave(db, encounter, combatant, dice);
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
  const roll = rollDice(`1d20${dice}`, { roll_type: 'save', dc: 10, luck_bias: pcLuck(db, encounter, combatant) });
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
