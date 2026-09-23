import type { Db } from '../db/connection.js';
import { linkEntities, upsertEntity } from './codex.js';
import { placePolitics } from './politics-service.js';
import { findPlace, getRegion, type WorldPlace } from './region.js';

export interface RevealResult {
  place: WorldPlace;
  entity_id: number | null;
  created: boolean;
  warning?: string;
  realm?: { entity_id: number; name: string; created: boolean };
}

/** Terrain words a reader would say aloud, keyed by the raw tag. */
const TERRAIN_WORDS: Record<string, string> = {
  'forest-dark': 'dark forest',
  'forest-light': 'light forest',
};

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** The codex-visible line for a settlement: its size, its walls and coast, then the generator's own note. */
function settlementSummary(place: WorldPlace): string {
  const size = typeof place.tags.size === 'string' ? place.tags.size : '';
  const parts = [capitalise(size)];
  if (place.tags.walled === true) parts.push('walled');
  if (place.tags.coast === true) parts.push('on the coast');
  return `${parts.join(', ')}. ${place.info}`;
}

/** The codex-visible line for an area: just the terrain it covers. */
function areaSummary(place: WorldPlace): string {
  const terrain = typeof place.tags.terrain === 'string' ? place.tags.terrain : '';
  return `An area of ${TERRAIN_WORDS[terrain] ?? terrain.replace(/-/g, ' ')}.`;
}

/** The codex-visible line for a realm: where it is ruled from, or that it has no crown. */
function realmSummary(realm: { name: string; capital: string | null }): string {
  return realm.capital === null
    ? `The free lands of ${realm.name}, with no crown.`
    : `A realm ruled from ${realm.capital}.`;
}

/** The DM-only link back to the generator that drew this place. */
function hiddenNotes(place: WorldPlace): string {
  if (place.kind === 'area' || !place.link) return '';
  return `${place.kind === 'danger' ? 'Dungeon' : 'Region'} map link: ${place.link}`;
}

/**
 * Marks a region place as known to the party and gives it a codex place entry, unless the codex already
 * names something of another kind. Nothing DM-only except the generator link reaches the codex.
 */
export function revealPlace(db: Db, campaignId: number, ref: number | string): RevealResult {
  if (getRegion(db, campaignId) === null) {
    throw new Error(`Campaign ${campaignId} has no region map. The player adds one in the companion window.`);
  }
  const place = findPlace(db, campaignId, ref);
  if (!place) {
    throw new Error(`No place "${String(ref)}" on the region map. Call region with op=get for the list.`);
  }
  if (place.known_to_party && place.entity_id !== null) {
    return { place, entity_id: place.entity_id, created: false };
  }

  return db.transaction(() => {
    const clash = db
      .prepare('SELECT id, kind FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
      .get(campaignId, place.name) as { id: number; kind: string } | undefined;
    if (clash && clash.kind !== 'place') {
      db.prepare('UPDATE world_place SET known_to_party = 1 WHERE id = ?').run(place.id);
      return {
        place: findPlace(db, campaignId, place.id)!,
        entity_id: null,
        created: false,
        warning: `The codex already has a ${clash.kind} named "${place.name}", so no place entry was made.`,
      };
    }

    // A place the DM already wrote up keeps its own summary; the generated one only fills a new entry.
    const { entity, created } = upsertEntity(db, {
      campaign_id: campaignId,
      kind: 'place',
      name: place.name,
      summary: clash
        ? undefined
        : place.kind === 'settlement'
          ? settlementSummary(place)
          : place.kind === 'area'
            ? areaSummary(place)
            : '',
      hidden_notes: hiddenNotes(place),
    });
    db.prepare('UPDATE world_place SET known_to_party = 1, entity_id = ? WHERE id = ?').run(entity.id, place.id);

    let warning: string | undefined;
    let realm: RevealResult['realm'];
    if (place.kind === 'settlement') {
      const pol = placePolitics(db, campaignId, place);
      if (pol.realm) {
        const realmClash = db
          .prepare('SELECT id, kind FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
          .get(campaignId, pol.realm.name) as { id: number; kind: string } | undefined;
        if (realmClash && realmClash.kind !== 'faction') {
          const note = `The codex already has a ${realmClash.kind} named "${pol.realm.name}", so the realm was not added.`;
          warning = warning ? `${warning} ${note}` : note;
        } else {
          // A realm the DM already wrote up keeps its own summary; the generated one only fills a new entry.
          const upserted = upsertEntity(db, {
            campaign_id: campaignId,
            kind: 'faction',
            name: pol.realm.name,
            summary: realmClash ? undefined : realmSummary(pol.realm),
          });
          linkEntities(db, { campaign_id: campaignId, from: upserted.entity.id, to: entity.id, type: 'rules' });
          realm = { entity_id: upserted.entity.id, name: pol.realm.name, created: upserted.created };
        }
      }
    }

    const result: RevealResult = { place: findPlace(db, campaignId, place.id)!, entity_id: entity.id, created };
    if (warning !== undefined) result.warning = warning;
    if (realm !== undefined) result.realm = realm;
    return result;
  })();
}
