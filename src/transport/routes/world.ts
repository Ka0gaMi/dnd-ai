// The player-safe world panel: the news the party has heard, the clocks they know and how factions
// regard them. Everything the party has not learned stays out of the reply.
import type { Express } from 'express';
import type { Db } from '../../db/connection.js';
import { AGENDA_TEMPLATES } from '../../core/agenda-templates.js';
import { getCampaign } from '../../core/campaign.js';
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
}

interface RegardItem {
  faction: string;
  value: number;
  reasons: Array<{ reason: string; value: number }>;
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

/** The name a player may hear for a faction, hiding a monstrous brood's true name. */
function publicFactionName(view: RegionView, faction: WorldFaction): string {
  return publicText(view, faction, NO_TARGET, null, '{faction}');
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

/** One known agenda as a clock: names filled for a player, and only the signs the party heard. */
function toClock(
  view: RegionView,
  db: Db,
  campaignId: number,
  agenda: WorldAgenda,
  faction: WorldFaction,
): ClockItem {
  const place: WorldPlace | null =
    faction.place_id !== null ? findPlace(db, campaignId, faction.place_id) ?? null : null;
  const target = { kind: agenda.target_kind, id: agenda.target_id, name: agenda.target_name };
  const label = AGENDA_TEMPLATES.find((template) => template.id === agenda.template)?.label ?? agenda.template;
  return {
    id: agenda.id,
    faction: publicText(view, faction, target, place, '{faction}'),
    goal: `${label}: ${publicText(view, faction, target, place, '{target}')}`,
    filled: agenda.clock_filled,
    size: agenda.clock_size,
    signs: agenda.portents.filter((portent) => portent.heard).map((portent) => portent.text),
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
      faction: publicFactionName(view, faction),
      value: total,
      reasons: reasons.slice(0, 3).map((reason) => ({ reason: reason.reason, value: reason.current })),
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
        return faction ? toClock(view, db, id, agenda, faction) : null;
      })
      .filter((clock): clock is ClockItem => clock !== null);

    res.json({ world: { news: heardNews(db, id), clocks, regard: regardOf(view, db, id, today) } });
  });
}
