// The player-safe world panel: the news the party has heard, the clocks they know and how factions
// regard them. Everything the party has not learned stays out of the reply.
import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { AGENDA_TEMPLATES } from '../../core/agenda-templates.js';
import { getCampaign } from '../../core/campaign.js';
import { placeDistance } from '../../core/region-graph.js';
import { findPlace, getRegion, type RegionView, type WorldPlace } from '../../core/region.js';
import { attitudeOf } from '../../core/world-memory.js';
import { publicText } from '../../core/world-seed.js';
import {
  currentGameDay,
  getWorldState,
  listAgendas,
  listFactions,
  type WorldAgenda,
  type WorldFaction,
} from '../../core/world-store.js';

interface NewsItem {
  id: number;
  text: string;
  local: boolean;
}

interface ClockItem {
  id: number;
  faction: string;
  goal: string;
  filled: number;
  size: number;
  signs: string[];
  emblem: string | null;
}

interface RegardItem {
  id: number;
  faction: string;
  value: number;
  reasons: Array<{ reason: string; value: number }>;
  emblem: string | null;
}

const NO_TARGET = { kind: 'none', id: null, name: '' };

/** getCampaign throws for an unknown campaign; the route answers that as a plain 404. */
function campaignExists(db: Db, campaignId: number): boolean {
  try {
    getCampaign(db, campaignId);
    return true;
  } catch {
    return false;
  }
}

/** The settlement nearest to a place, for naming a brood the party knows only by its surroundings. */
function nearestSettlement(view: RegionView, place: WorldPlace): WorldPlace | undefined {
  let best: WorldPlace | undefined;
  let bestDistance = Infinity;
  for (const settlement of view.places) {
    if (settlement.kind !== 'settlement') continue;
    const distance = placeDistance(place, settlement);
    if (distance < bestDistance) {
      best = settlement;
      bestDistance = distance;
    }
  }
  return best;
}

/** The name a player may hear for a faction: a linked brood uses its codex name, else its surroundings. */
function publicFactionName(db: Db, campaignId: number, view: RegionView, faction: WorldFaction): string {
  if (faction.type !== 'monsters') return publicText(view, faction, NO_TARGET, null, '{faction}');
  if (faction.entity_id !== null) {
    const row = db
      .prepare('SELECT name FROM entity WHERE campaign_id = ? AND id = ?')
      .get(campaignId, faction.entity_id) as { name: string } | undefined;
    if (row) return row.name;
  }
  const lair =
    faction.place_id !== null ? view.places.find((place) => place.id === faction.place_id) : undefined;
  const nearest = lair ? nearestSettlement(view, lair) : undefined;
  return nearest ? `The brood near ${nearest.name}` : 'A monstrous brood';
}

/** The world news the party has actually heard, newest first, never with its truth. */
function heardNews(db: Db, campaignId: number): NewsItem[] {
  const rows = db
    .prepare(
      "SELECT id, text, scope FROM rumour WHERE campaign_id = ? AND source_kind = 'world' AND heard_at IS NOT NULL ORDER BY id DESC LIMIT 20",
    )
    .all(campaignId) as Array<{ id: number; text: string; scope: string }>;
  return rows.map((row) => ({ id: row.id, text: row.text, local: row.scope === 'location' }));
}

/** A faction's emblem: the portrait of the codex entity it is linked to, when there is one. */
function emblemOf(db: Db, campaignId: number, faction: WorldFaction): string | null {
  if (faction.entity_id === null) return null;
  const row = db
    .prepare('SELECT portrait_path FROM entity WHERE campaign_id = ? AND id = ?')
    .get(campaignId, faction.entity_id) as { portrait_path: string | null } | undefined;
  return row?.portrait_path ?? null;
}

/** One known agenda as a clock: names filled for a player, and only the signs the party heard. */
function toClock(
  view: RegionView,
  db: Db,
  campaignId: number,
  agenda: WorldAgenda,
  faction: WorldFaction,
  factions: Map<number, WorldFaction>,
): ClockItem {
  const place: WorldPlace | null =
    faction.place_id !== null ? findPlace(db, campaignId, faction.place_id) ?? null : null;
  const target = { kind: agenda.target_kind, id: agenda.target_id, name: agenda.target_name };
  const rival =
    agenda.target_kind === 'rival_faction' && agenda.target_id !== null
      ? factions.get(agenda.target_id)
      : undefined;
  const hiddenRival = rival?.secrecy === 'secret';
  const label = AGENDA_TEMPLATES.find((template) => template.id === agenda.template)?.label ?? agenda.template;
  return {
    id: agenda.id,
    faction: publicFactionName(db, campaignId, view, faction),
    goal: `${label}: ${hiddenRival ? 'a hidden rival' : publicText(view, faction, target, place, '{target}')}`,
    filled: agenda.clock_filled,
    size: agenda.clock_size,
    signs: agenda.portents.filter((portent) => portent.heard).map((portent) => portent.text),
    emblem: emblemOf(db, campaignId, faction),
  };
}

/** Factions the party has met that feel something about them, strongest feeling first. */
function regardOf(view: RegionView, db: Db, campaignId: number, today: number): RegardItem[] {
  const items: RegardItem[] = [];
  for (const faction of listFactions(db, campaignId)) {
    if (faction.secrecy === 'secret') continue;
    const { total, reasons } = attitudeOf(db, campaignId, { kind: 'faction', id: faction.id }, today);
    if (total === 0) continue;
    items.push({
      id: faction.id,
      faction: publicFactionName(db, campaignId, view, faction),
      value: total,
      reasons:
        faction.type === 'monsters'
          ? []
          : reasons.slice(0, 3).map((reason) => ({ reason: reason.reason, value: reason.current })),
      emblem: emblemOf(db, campaignId, faction),
    });
  }
  items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return items;
}

/** Serves the World tab: known clocks, heard news and standing. Nothing here writes. */
export default function registerWorldRoutes(app: Express, db: Db): void {
  app.get('/api/campaigns/:id/world', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }

    if (!campaignExists(db, id)) {
      res.status(404).json({ error: 'no such campaign' });
      return;
    }

    const view = getWorldState(db, id) === null ? null : getRegion(db, id);
    if (!view) {
      res.json({ world: null });
      return;
    }

    const today = currentGameDay(db, id);
    const factions = new Map(listFactions(db, id).map((faction) => [faction.id, faction]));
    const clocks = listAgendas(db, id)
      .filter((agenda) => agenda.known_to_party && (agenda.status === 'active' || agenda.status === 'held'))
      .map((agenda) => {
        const faction = factions.get(agenda.faction_id);
        if (!faction || faction.secrecy === 'secret') return null;
        return toClock(view, db, id, agenda, faction, factions);
      })
      .filter((clock): clock is ClockItem => clock !== null);

    res.json({ world: { news: heardNews(db, id), clocks, regard: regardOf(view, db, id, today) } });
  });
}
