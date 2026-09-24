// The codex view of the living world: a faction the party comes to know gains a player-safe codex
// entry whose summary never names a danger site, and a secret faction never reaches the codex at all.
import type { Db } from '../db/connection.js';
import { upsertEntity } from './codex.js';
import { heraldryFor } from './heraldry.js';
import { placeDistance } from './region-graph.js';
import { findPlace, getRegion } from './region.js';
import { listFactions, updateFaction, type WorldFaction } from './world-store.js';

interface EntityRefRow {
  id: number;
  kind: string;
}

/** The settlement nearest a place, for naming a faction by where it is rather than what it is. */
function nearestSettlementName(db: Db, campaignId: number, placeId: number | null): string | undefined {
  const view = getRegion(db, campaignId);
  if (!view || placeId === null) return undefined;
  const place = view.places.find((entry) => entry.id === placeId);
  if (!place) return undefined;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const settlement of view.places) {
    if (settlement.kind !== 'settlement') continue;
    const distance = placeDistance(place, settlement);
    if (distance < bestDistance) {
      best = settlement.name;
      bestDistance = distance;
    }
  }
  return best;
}

/** The ordinal words for a second, third, ... brood when one town already has more than one. */
const BROOD_ORDINALS = ['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** The nth player-safe brood name: the plain form first, then "The second brood near X", and so on. */
function broodName(town: string | undefined, count: number): string {
  const ordinal = count <= 1 ? '' : `${BROOD_ORDINALS[count - 2] ?? `${count}th`} `;
  return town ? `The ${ordinal}brood near ${town}` : `A ${ordinal}monstrous brood`;
}

/** Whether a world faction already links this codex entity, so a second faction needs another name. */
function entityIsLinked(db: Db, campaignId: number, entityId: number): boolean {
  const row = db
    .prepare('SELECT id FROM world_faction WHERE campaign_id = ? AND entity_id = ? LIMIT 1')
    .get(campaignId, entityId) as { id: number } | undefined;
  return row !== undefined;
}

/** The first brood name no other faction has claimed, with any unlinked faction entity already bearing it. */
function broodNameChoice(
  db: Db,
  campaignId: number,
  town: string | undefined,
): { name: string; existing?: EntityRefRow } {
  for (let count = 1; ; count += 1) {
    const name = broodName(town, count);
    const existing = findEntityByName(db, campaignId, name);
    if (!existing) return { name };
    if (existing.kind === 'faction' && !entityIsLinked(db, campaignId, existing.id)) return { name, existing };
  }
}

function realmName(db: Db, campaignId: number, realmId: number | null): string | undefined {
  if (realmId === null) return undefined;
  const row = db
    .prepare('SELECT name FROM world_realm WHERE campaign_id = ? AND id = ?')
    .get(campaignId, realmId) as { name: string } | undefined;
  return row?.name;
}

/** A short, player-safe summary of a faction, with its arms when the world seed gives it any. */
function summaryFor(db: Db, campaignId: number, faction: WorldFaction): string {
  const seatPlace = faction.place_id !== null ? findPlace(db, campaignId, faction.place_id) : undefined;
  const seat = seatPlace?.name ?? faction.name;
  const realm = realmName(db, campaignId, faction.realm_id) ?? faction.name;
  const town = nearestSettlementName(db, campaignId, faction.place_id);
  let text: string;
  switch (faction.type) {
    case 'realm':
      text = seatPlace?.known_to_party ? `A realm ruled from ${seat}.` : 'A realm of the region.';
      break;
    case 'house':
      text = `A noble house seated at ${seat}.`;
      break;
    case 'church':
      text = `The temple of the faith in ${realm}.`;
      break;
    case 'guild':
      text = `A merchants' guild of ${seat}.`;
      break;
    case 'gang':
      text = `A criminal gang working the streets of ${seat}.`;
      break;
    case 'monsters':
      text = town ? `Something dangerous lairs in the wilds near ${town}.` : 'Something dangerous lairs in the wilds.';
      break;
    default:
      text = 'A power from beyond the map.';
  }
  const heraldry = heraldryFor(db, campaignId, faction);
  return heraldry ? `${text} Arms: ${heraldry.blazon}.` : text;
}

function findEntityByName(db: Db, campaignId: number, name: string): EntityRefRow | undefined {
  return db
    .prepare('SELECT id, kind FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
    .get(campaignId, name) as EntityRefRow | undefined;
}

/** Adds a non-secret faction to the codex, or links the entry it already has; null when it must not. */
export function ensureFactionEntity(db: Db, campaignId: number, faction: WorldFaction): number | null {
  if (faction.secrecy === 'secret') return null;

  if (faction.entity_id !== null) {
    const linked = db
      .prepare('SELECT id FROM entity WHERE campaign_id = ? AND id = ?')
      .get(campaignId, faction.entity_id) as { id: number } | undefined;
    if (linked) return linked.id;
  }

  const linkOrCreate = (name: string, existing: EntityRefRow | undefined): number => {
    if (existing) {
      updateFaction(db, campaignId, faction.id, { entity_id: existing.id });
      return existing.id;
    }
    const { entity } = upsertEntity(db, {
      campaign_id: campaignId,
      kind: 'faction',
      name,
      summary: summaryFor(db, campaignId, faction),
    });
    updateFaction(db, campaignId, faction.id, { entity_id: entity.id });
    return entity.id;
  };

  if (faction.type === 'monsters') {
    const choice = broodNameChoice(db, campaignId, nearestSettlementName(db, campaignId, faction.place_id));
    return linkOrCreate(choice.name, choice.existing);
  }

  const existing = findEntityByName(db, campaignId, faction.name);
  if (existing && existing.kind !== 'faction') return null;
  return linkOrCreate(faction.name, existing);
}

/** Links factions the reveal flow already added, without creating anything new. */
export function linkKnownFactions(db: Db, campaignId: number): void {
  for (const faction of listFactions(db, campaignId)) {
    if (faction.secrecy === 'secret' || faction.entity_id !== null) continue;
    if (faction.type === 'monsters') {
      const choice = broodNameChoice(db, campaignId, nearestSettlementName(db, campaignId, faction.place_id));
      if (choice.existing) updateFaction(db, campaignId, faction.id, { entity_id: choice.existing.id });
      continue;
    }
    const existing = findEntityByName(db, campaignId, faction.name);
    if (existing?.kind === 'faction') updateFaction(db, campaignId, faction.id, { entity_id: existing.id });
  }
}
