import { activeCombatant, activeEncounter, listCombatants } from '../combat/state.js';
import { pcRow, snippet } from '../core/campaign.js';
import type { Db } from '../db/connection.js';

export type Mode = 'combat' | 'level-up' | 'creation' | 'play';

/** The calls that fit each mode, named when the table enters it. */
export const MODE_CALLS: Record<Mode, string> = {
  combat: 'attack, move_token, use_action, effect, advance_turn, get_battle_state, end_encounter',
  'level-up': 'the player picks in their window; level_up if they pick in chat, then get_character_sheet',
  creation: 'list_character_options, srd_lookup, create_character, generate_portrait, then load_campaign',
  play: 'roll, log_event, update_objectives, remember, checkpoint {op: save}, start_encounter, read_guide',
};

const short = (name: string): string => snippet(name, 32);

/** The table's mode and its one-line header, read from state the campaign already keeps. */
export function tableMode(db: Db, campaignId: number): { mode: Mode; header: string } {
  const encounter = activeEncounter(db, campaignId);
  if (encounter) {
    const up = activeCombatant(listCombatants(db, encounter.id), encounter.turn_index);
    return { mode: 'combat', header: `combat · r${encounter.round}${up ? ` · ${short(up.name)} #${up.id} up` : ''}` };
  }
  const levelling = db
    .prepare(
      "SELECT id, name, json_extract(pending_level_up_json, '$.to_level') AS to_level FROM character WHERE campaign_id = ? AND status = 'active' AND pending_level_up_json IS NOT NULL ORDER BY is_pc DESC, id LIMIT 1",
    )
    .get(campaignId) as { id: number; name: string; to_level: number | null } | undefined;
  if (levelling) {
    const to = levelling.to_level ? ` to level ${levelling.to_level}` : '';
    return { mode: 'level-up', header: `level-up · ${short(levelling.name)} #${levelling.id}${to}` };
  }
  if (!pcRow(db, campaignId)) return { mode: 'creation', header: 'creation' };
  const scene = db
    .prepare('SELECT s.location_name FROM campaign c JOIN scene s ON s.id = c.current_scene_id WHERE c.id = ?')
    .get(campaignId) as { location_name: string | null } | undefined;
  return { mode: 'play', header: scene?.location_name ? `play · ${short(scene.location_name)}` : 'play' };
}

/** The mode each campaign's last reply was in, per database, so it outlives the per-request servers HTTP creates. */
const shown = new WeakMap<Db, Map<number, Mode>>();

/**
 * The mode line when the campaign's mode changed since its last reply, or whenever `fresh`; else null, as on any failure.
 * Entering a fight names no calls, since start_encounter already ends with the turn loop.
 */
export function modeLine(db: Db, campaignId: number, fresh = false): string | null {
  try {
    const { mode, header } = tableMode(db, campaignId);
    let last = shown.get(db);
    if (!last) shown.set(db, (last = new Map()));
    const changed = last.get(campaignId) !== mode;
    last.set(campaignId, mode);
    if (!changed && !fresh) return null;
    return mode === 'combat' && !fresh ? `Mode: ${header}.` : `Mode: ${header} — calls: ${MODE_CALLS[mode]}.`;
  } catch {
    // Like a duty check, a broken detection must never cost the reply it rides on.
    return null;
  }
}
