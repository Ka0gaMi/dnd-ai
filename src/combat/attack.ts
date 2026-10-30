// Combat engine: resolving one attack.
import { heldInspirationDie, spendInspirationDie } from '../core/character.js';
import { type Advantage } from '../core/dice.js';
import { netAdvantage } from '../core/rolls.js';
import type { Db } from '../db/connection.js';
import {
  findAction,
  gripDamage,
  hasProperty,
  shieldEquipped,
  isAttack,
  weaponAbility,
  weaponOfAction,
} from './actions.js';
import { rulesOf } from './conditions.js';
import {
  attackBonusOf,
  auraHalfCover,
  classFeatures,
  critRangeOf,
  attackSources as featureAttackSources,
  defenceSources,
  hasFeature,
  hitRiders,
  irresistibleOffense,
  missRiders,
  reactionOffers,
  sacredWeaponBlessing,
  damageTakenOutcomes,
  type AttackOptions,
  type BrutalStrikeOption,
  type CunningStrikeOption,
  type HitRider,
  type ReactionOffer,
  type RollSource,
} from './features.js';
import { coverBetween, distanceBetween } from './grid.js';
import { sheetAbilityMod } from './sheet.js';
import { boostsFor, type ClauseCtx } from './homebrew.js';
import { underSnapshot } from './undo.js';
import {
  encounterMap,
  getCombatant,
  listCombatants,
  listEffects,
  logCombat,
  requireEncounter,
  saveCombatant,
  type CombatLogEntry,
} from './state.js';
import {
  ATTACK_HOOKS,
  type PreRoll,
  signed,
  partyHp,
  finish,
  sheetOf,
  auraSources,
  pcLuck,
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
} from './resources.js';
import { criticalExpr, rollDamage, greatWeaponBonus, type DamageResult } from './damage-math.js';
import { charmedBy, d20Context, rollD20, askPlayer, applyD20Stance } from './d20.js';
import { isDowned, damageCombatant, refreshVitals } from './hp.js';
import { afterDamage } from './effects.js';
import { droppedToZero, afterKill, applyOutcome, remindersOf } from './outcome.js';
import { crowdedShot } from './movement.js';
import {
  type MasteryEffect,
  masteryFor,
  requireCleave,
  withoutAbilityMod,
  resolveMastery,
  spendSapVex,
} from './mastery.js';
import {
  refuseIfIncapacitated,
  standardId,
  revealHidden,
  releaseReady,
} from './standard-actions.js';
import {
  rollRiderDamage,
  foldNegativeRiders,
  applyHitRiders,
  mitigateHit,
  cuttingWords,
  cuttingWordsOffers,
  extendRage,
  huntersMarkRider,
} from './riders.js';
import { swappedMastery, requireAttackOptions } from './feature-helpers.js';

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
      expr: `1d20${signed(bonus)}${context.dice}`,
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
    { advantage, dc: effectiveAc, kind: 'attack', luck_bias: pcLuck(db, encounter, attacker), dice: context.dice },
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
      dice: context.dice,
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
          text: `Superior Hunter's Prey: the mark's power leaps to ${second.name} for ${result.applied} force damage (${rolled.output}${
            result.resistance ? `, ${result.resistance}` : ''
          })${partyHp(second, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
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
          payload: { feature: "Superior Hunter's Prey", dm_note: 'Name it with attack {prey_target_id}.' },
          text: `Superior Hunter's Prey: the mark's extra damage may also land on a creature within 30 ft of ${target.name}.`,
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
    // Spent before the swing is counted: a swing that opens the surged Action starts that Action's own count.
    spendResource(attacker, action.kind === 'bonus_action' ? 'bonus' : 'action', input.out_of_turn, swings);
    if (!input.out_of_turn && action.kind !== 'bonus_action') {
      attacker.flags = { ...attacker.flags, attacks_used: (attacker.flags.attacks_used ?? 0) + 1 };
    }
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
