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

/** The name a player may hear for a faction: a brood is known only by the settlement nearest its lair. */
function publicFactionName(db: Db, campaignId: number, faction: WorldFaction): string {
  if (faction.type !== 'monsters') return faction.name;
  const nearest = nearestSettlementName(db, campaignId, faction.place_id);
  return nearest ? `The brood near ${nearest}` : 'A monstrous brood';
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
  const seat =
    (faction.place_id !== null ? findPlace(db, campaignId, faction.place_id)?.name : undefined) ?? faction.name;
  const realm = realmName(db, campaignId, faction.realm_id) ?? faction.name;
  const town = nearestSettlementName(db, campaignId, faction.place_id) ?? faction.name;
  let text: string;
  switch (faction.type) {
    case 'realm':
      text = `A realm ruled from ${seat}.`;
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
      text = `Something dangerous lairs in the wilds near ${town}.`;
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

  const name = publicFactionName(db, campaignId, faction);
  const existing = findEntityByName(db, campaignId, name);
  if (existing) {
    if (existing.kind !== 'faction') return null;
    if (faction.entity_id !== existing.id) updateFaction(db, campaignId, faction.id, { entity_id: existing.id });
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
}

/** Links factions the reveal flow already added, without creating anything new. */
export function linkKnownFactions(db: Db, campaignId: number): void {
  for (const faction of listFactions(db, campaignId)) {
    if (faction.secrecy === 'secret' || faction.entity_id !== null) continue;
    const existing = findEntityByName(db, campaignId, publicFactionName(db, campaignId, faction));
    if (existing?.kind === 'faction') updateFaction(db, campaignId, faction.id, { entity_id: existing.id });
  }
}
