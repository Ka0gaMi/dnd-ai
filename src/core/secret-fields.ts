// The secret-field registry: what only the DM may read and what only the player may read. The leak
// test plants a marker in every DM-only field and reads every player surface, and checks DM replies by key.
import { PLAYER_ONLY_SETTINGS } from './settings.js';

export interface SecretField {
  /** The handle the leak test plants its marker under. */
  id: string;
  /** Where the secret is stored: a table and column, or a key inside a JSON column. */
  source: string;
  /** The field stays on its own side while this holds; "always" means it never crosses. */
  secret_while: string;
}

/** Never in the player's window: no `/api` GET reply and no WebSocket snapshot may carry these. */
export const DM_ONLY_FIELDS = [
  { id: 'rumour_truth', source: 'rumour.truth', secret_while: 'the rumour is unresolved' },
  { id: 'unheard_rumour', source: 'rumour.text (heard_at IS NULL)', secret_while: 'the party has not heard it' },
  { id: 'packet_truth', source: 'world_packet.truth', secret_while: 'always' },
  { id: 'outline_secret_notes', source: 'story_outline.secret_notes', secret_while: 'the spoiler toggle is off' },
  { id: 'hidden_thread', source: 'plot_thread (hidden = 1)', secret_while: 'the spoiler toggle is off' },
  { id: 'hidden_clue', source: 'clue (hidden = 1)', secret_while: 'the spoiler toggle is off' },
  { id: 'codex_hidden_notes', source: 'entity.hidden_notes', secret_while: 'the spoiler toggle is off' },
  {
    id: 'unidentified_item_name',
    source: 'character.inventory_json[].name (magic.identified = false)',
    secret_while: 'the item is unidentified',
  },
  { id: 'secret_faction', source: "world_faction (secrecy = 'secret')", secret_while: 'always' },
  {
    id: 'ended_secret_faction',
    source: "world_faction (secrecy = 'secret', ended_day set)",
    secret_while: 'always',
  },
  { id: 'hidden_agenda', source: 'world_agenda (known_to_party = 0)', secret_while: 'the party does not know it' },
  {
    id: 'unheard_portent',
    source: 'world_agenda.portents_json[] (heard = false)',
    secret_while: 'the party has not heard it',
  },
  { id: 'faction_resources', source: 'world_faction.resources', secret_while: 'always' },
  { id: 'faction_capacities', source: 'world_faction.capacities_json', secret_while: 'always' },
  { id: 'secret_event', source: "world_event (visibility = 'secret')", secret_while: 'always' },
  {
    id: 'unknown_danger_name',
    source: "world_place.name (kind = 'danger')",
    secret_while: 'the party does not know the place',
  },
  {
    id: 'unknown_area_name',
    source: "world_place.name (kind = 'area')",
    secret_while: 'the party does not know the place',
  },
  { id: 'unknown_county_name', source: 'world_county.name', secret_while: 'the party does not know its seat' },
  {
    id: 'unknown_place_state',
    source: 'world_place_state (state, faith_id, cause_event_id)',
    secret_while: 'the party does not know the place',
  },
  { id: 'region_raw_json', source: 'world_region.raw_json', secret_while: 'always' },
  { id: 'place_seed', source: 'world_place.seed', secret_while: 'always' },
  { id: 'place_link', source: 'world_place.link', secret_while: 'always' },
  { id: 'checkpoint_snapshot', source: 'checkpoint.snapshot_json', secret_while: 'always' },
] as const satisfies readonly SecretField[];

export type DmOnlyFieldId = (typeof DM_ONLY_FIELDS)[number]['id'];

/** Never in a DM-facing reply or briefing: the player's own dials, which their window alone reads. */
export const PLAYER_ONLY_FIELDS: readonly SecretField[] = PLAYER_ONLY_SETTINGS.map((key) => ({
  id: key,
  source: `campaign.settings_json.${key}`,
  secret_while: 'always',
}));
