// One deed path: world {op: deed} and the deeds a checkpoint save carries are planned and written by the
// same code, and each recorded deed leaves a 'deed' event naming how it arrived and who saw it.
import type { Db } from '../db/connection.js';
import { attitudeBand } from './attitude-bands.js';
import { logEvent } from './campaign.js';
import { matchPlace } from './place-match.js';
import { placePolitics } from './politics-service.js';
import { findPlace, getRegion, type RegionView, type WorldPlace } from './region.js';
import { ensureFactionEntity } from './world-codex.js';
import { addAttitude, attitudeOf, DEED_KNOWN_DAYS, deedKnownAt } from './world-memory.js';
import { currentGameDay, listAgendas, listFactions, type WorldFaction } from './world-store.js';

type Ref = number | string;

export interface DeedInput {
  target: Ref;
  value: number;
  reason: string;
  /** Codex entities who saw it; a rival faction one of them speaks for hears of it wherever its seat lies. */
  witnesses?: Ref[];
  place?: Ref;
}

/** Which call recorded the deed, kept on its event so the funnel's paths can be counted. */
export type DeedVia = 'world' | 'checkpoint';

interface EntityRefRow {
  id: number;
  name: string;
}

/** A deed resolved against the campaign and ready to write; planning one writes nothing. */
export interface DeedPlan {
  faction?: WorldFaction;
  entity?: EntityRefRow;
  place?: WorldPlace;
  value: number;
  reason: string;
  witnesses: EntityRefRow[];
}

export function findFaction(db: Db, campaignId: number, ref: Ref): WorldFaction | undefined {
  const factions = listFactions(db, campaignId, { includeEnded: true });
  if (typeof ref === 'number') return factions.find((faction) => faction.id === ref);
  const name = ref.trim().toLowerCase();
  return factions.find((faction) => faction.name.toLowerCase() === name);
}

/** Codex entity lookup by id or case-insensitive name; codex.ts's finder is not exported. */
function findEntity(db: Db, campaignId: number, ref: Ref): EntityRefRow | undefined {
  const sql =
    typeof ref === 'number'
      ? 'SELECT id, name FROM entity WHERE campaign_id = ? AND id = ?'
      : 'SELECT id, name FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)';
  return db.prepare(sql).get(campaignId, ref) as EntityRefRow | undefined;
}

/** Half the magnitude toward zero, opposite sign: +3 -> -1, +1 -> none, -4 -> +2; small favours go unnoticed. */
function oppositeHalf(value: number): number {
  return -Math.sign(value) * Math.floor(Math.abs(value) / 2);
}

/** Factions one hop from this one: it targets them, or they target it, on an active rivalry. */
function rivalFactionIds(db: Db, campaignId: number, factionId: number): number[] {
  const ids = new Set<number>();
  for (const agenda of listAgendas(db, campaignId, { status: 'active' })) {
    if (agenda.target_kind !== 'rival_faction') continue;
    if (agenda.target_id === factionId) ids.add(agenda.faction_id);
    if (agenda.faction_id === factionId && agenda.target_id !== null) ids.add(agenda.target_id);
  }
  ids.delete(factionId);
  return [...ids];
}

/** The place the party stands at: the latest scene location matched to the region map. */
export function partyPlace(db: Db, campaignId: number): WorldPlace | undefined {
  const scene = db
    .prepare(
      'SELECT location_name FROM scene WHERE campaign_id = ? AND location_name IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get(campaignId) as { location_name: string } | undefined;
  return scene ? matchPlace(db, campaignId, scene.location_name) : undefined;
}

/** A rival hears of a deed when its seat lies within the deed's known range, or, with no place, shares its realm. */
function rivalHears(
  view: RegionView,
  place: WorldPlace | undefined,
  realmId: number | null,
  value: number,
  rival: WorldFaction,
): boolean {
  if (DEED_KNOWN_DAYS[Math.abs(value)] === Number.POSITIVE_INFINITY) return true;
  if (!place) return realmId !== null && rival.realm_id === realmId;
  const seat = rival.place_id !== null ? view.places.find((entry) => entry.id === rival.place_id) : undefined;
  return seat !== undefined && deedKnownAt(view, place, value, seat);
}

/** The world factions the witnesses speak for: a faction's own codex entry, or one a witness is member_of. */
function witnessFactionIds(db: Db, campaignId: number, witnesses: EntityRefRow[]): Set<number> {
  if (witnesses.length === 0) return new Set();
  const ids = witnesses.map((witness) => witness.id);
  const marks = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id FROM world_faction WHERE campaign_id = ? AND (entity_id IN (${marks}) OR entity_id IN
         (SELECT to_id FROM relationship WHERE campaign_id = ? AND active = 1 AND type = 'member_of' AND from_id IN (${marks})))`,
    )
    .all(campaignId, ...ids, campaignId, ...ids) as Array<{ id: number }>;
  return new Set(rows.map((row) => row.id));
}

const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`;

/** Checks a deed and resolves its target, place and witnesses; throws the refusal the DM reads. */
export function planDeed(db: Db, campaignId: number, deed: DeedInput): DeedPlan {
  const value = deed.value;
  if (!Number.isInteger(value) || value === 0 || value < -5 || value > 5) {
    throw new Error(`A deed value must be a non-zero integer from -5 to 5, got ${value}. Re-call with one in that range.`);
  }
  const reason = deed.reason.trim();
  if (reason === '') throw new Error('A deed needs a reason: pass reason with what the party did.');

  const faction = findFaction(db, campaignId, deed.target);
  const entity = faction ? undefined : findEntity(db, campaignId, deed.target);
  if (!faction && !entity) {
    throw new Error(
      `No faction or codex entity "${String(deed.target)}" in this campaign. world {op: get} lists the factions; get_codex lists the entities.`,
    );
  }
  if (faction && faction.ended_day != null) {
    throw new Error(
      `${faction.name} ended on day ${faction.ended_day}; a deed can only change how a living faction regards the party. world {op: get} lists the living ones.`,
    );
  }

  const place =
    deed.place === undefined
      ? partyPlace(db, campaignId)
      : typeof deed.place === 'number'
        ? findPlace(db, campaignId, deed.place)
        : matchPlace(db, campaignId, deed.place);
  if (deed.place !== undefined && !place) {
    throw new Error(`No place "${String(deed.place)}" on the region map. Call region with op=get for the list.`);
  }

  const witnesses = new Map<number, EntityRefRow>();
  for (const ref of deed.witnesses ?? []) {
    const witness = findEntity(db, campaignId, ref);
    if (!witness) throw new Error(`No codex entity "${String(ref)}" to name as a witness. get_codex lists the entities.`);
    witnesses.set(witness.id, witness);
  }
  return { faction, entity, place, value, reason, witnesses: [...witnesses.values()] };
}

/** Writes a planned deed: the attitude, a rival's backlash, the target's codex entry and the deed event. */
export function applyDeed(
  db: Db,
  campaignId: number,
  plan: DeedPlan,
  via: DeedVia,
): { data: Record<string, unknown>; text: string } {
  const { entity, place, value, reason } = plan;
  // Read afresh: an earlier deed of the same save may have linked its codex entry since the plan was made.
  const faction = plan.faction ? findFaction(db, campaignId, plan.faction.id)! : undefined;
  // With no place the deed belongs to the target faction's realm, if it has one.
  const realmId = place ? (placePolitics(db, campaignId, place).realm?.id ?? null) : (faction?.realm_id ?? null);
  const knownDays = DEED_KNOWN_DAYS[Math.abs(value)]!;
  const scope = { place_id: place?.id ?? null, realm_id: realmId };

  const today = currentGameDay(db, campaignId);
  const recorded: Array<{
    subject_kind: 'faction' | 'entity';
    subject_id: number;
    subject_name: string;
    value: number;
    reason: string;
  }> = [];

  if (faction) {
    const stored = addAttitude(db, campaignId, { kind: 'faction', id: faction.id }, { value, reason, day: today, ...scope });
    ensureFactionEntity(db, campaignId, faction);
    recorded.push({
      subject_kind: 'faction',
      subject_id: faction.id,
      subject_name: faction.name,
      value: stored.value,
      reason: stored.reason,
    });
    const view = getRegion(db, campaignId)!;
    const factions = listFactions(db, campaignId);
    const witnessed = witnessFactionIds(db, campaignId, plan.witnesses);
    for (const rivalId of rivalFactionIds(db, campaignId, faction.id)) {
      const rival = factions.find((entry) => entry.id === rivalId);
      if (!rival) continue;
      const rivalValue = oppositeHalf(value);
      if (rivalValue === 0) continue;
      if (!witnessed.has(rival.id) && !rivalHears(view, place, realmId, value, rival)) continue;
      const rivalReason = `${reason} (rival of ${faction.secrecy === 'secret' ? 'a hidden rival' : faction.name})`;
      const rivalStored = addAttitude(
        db,
        campaignId,
        { kind: 'faction', id: rival.id },
        { value: rivalValue, reason: rivalReason, day: today, ...scope, rival_of: faction.id },
      );
      recorded.push({
        subject_kind: 'faction',
        subject_id: rival.id,
        subject_name: rival.name,
        value: rivalStored.value,
        reason: rivalStored.reason,
      });
    }
  } else {
    const stored = addAttitude(db, campaignId, { kind: 'entity', id: entity!.id }, { value, reason, day: today, ...scope });
    recorded.push({
      subject_kind: 'entity',
      subject_id: entity!.id,
      subject_name: entity!.name,
      value: stored.value,
      reason: stored.reason,
    });
  }

  // The text is the reason alone, which reaches the player anyway; the payload keeps ids, never a secret's name.
  logEvent(db, {
    campaign_id: campaignId,
    kind: 'deed',
    text: reason,
    payload: {
      via,
      subject: { kind: recorded[0]!.subject_kind, id: recorded[0]!.subject_id },
      value,
      place_id: place?.id ?? null,
      witnesses: plan.witnesses.map((witness) => witness.id),
    },
  });

  const regarded = recorded.map((entry) => {
    const total = attitudeOf(db, campaignId, { kind: entry.subject_kind, id: entry.subject_id }, today).total;
    return { ...entry, total, band: attitudeBand(total) };
  });
  const wholeMap = knownDays === Number.POSITIVE_INFINITY;
  const lines = regarded.map(
    (entry) => `${entry.subject_name}: ${signed(entry.value)} ${entry.reason}; now ${entry.band} (${signed(entry.total)})`,
  );
  if (wholeMap) lines.push(`Known across the whole map${place ? `; done at ${place.name}` : ''}.`);
  else if (place) lines.push(`Done at ${place.name}; known within ${knownDays} day(s) of travel.`);
  else if (faction) lines.push('No place on the map, so only rivals in its realm hear of it.');
  if (plan.witnesses.length > 0) lines.push(`Seen by ${plan.witnesses.map((witness) => witness.name).join(', ')}.`);
  const subjects = regarded.map((entry) => `${entry.subject_kind} #${entry.subject_id} ${entry.subject_name}`);
  const where = [place ? `place #${place.id}` : '', realmId !== null ? `realm #${realmId}` : ''].filter((part) => part !== '');
  lines.push(`Ids: ${[subjects.join(', '), ...where].join('; ')}.`);
  return {
    data: {
      target: { kind: faction ? 'faction' : 'entity', id: faction?.id ?? entity!.id, name: faction?.name ?? entity!.name },
      place: place ? { id: place.id, name: place.name } : null,
      realm_id: realmId,
      known_within_days: wholeMap ? null : knownDays,
      recorded: regarded,
    },
    text: lines.join('\n'),
  };
}

/** Plans and writes one deed; the caller holds the transaction and has made sure the world exists. */
export function recordDeed(
  db: Db,
  campaignId: number,
  deed: DeedInput,
  via: DeedVia,
): { data: Record<string, unknown>; text: string } {
  return applyDeed(db, campaignId, planDeed(db, campaignId, deed), via);
}
