import type {
  DecisionChoice,
  DecisionResult,
  HomebrewSpellSchema,
  HomebrewSubclassSchema,
  PendingDecision,
} from './decisions.svelte';
import type { PresetFile } from './presets';
import type { Homebrew, LevelUpAnswer, LevelUpBody, LibraryAnswer, Mechanics, OptionDetail, PlayProfile } from './progression';
import type { PlayerRegionSummary, RegionRequest } from './region';
import type { CampaignSettings } from './settings';
import type { Tactics } from './tactics';
import type { CharacterOptions, CreatedCharacter, NewCampaignBody, NewCharacterBody } from './wizard';
import type {
  BattleState,
  CampaignListItem,
  CodexListItem,
  CombatLogEntry,
  EntityView,
  GlossaryEntry,
  JournalEntry,
  Pc,
  PendingRoll,
  PendingRollBoosts,
  RollResult,
  RollRow,
  Rumour,
  RumourScope,
  TreeNode,
} from './types';

/** The delete endpoints were added later than the rest: an old server 404s them. */
const MISSING_ENDPOINT = 'Server needs a restart to enable deletion';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Carries the status so the caller can tell a 409 (someone else rolled it) from a real failure. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(`${path} -> ${res.status}`, res.status);
  return (await res.json()) as T;
}

/** The wizard's posts: a 400 body carries a message written for the player, so it becomes the error. */
async function postChecked<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new ApiError(typeof message === 'string' ? message : `${path} -> ${res.status}`, res.status);
  }
  return data as T;
}

async function send(path: string, method: string): Promise<void> {
  const res = await fetch(path, { method });
  if (res.status === 404) throw new Error(MISSING_ENDPOINT);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
}

export const getCampaigns = (includeDeleted = false) =>
  getJson<CampaignListItem[]>(`/api/campaigns${includeDeleted ? '?include_deleted=1' : ''}`);
export const getGlossary = (campaignId: number) =>
  getJson<GlossaryEntry[]>(`/api/campaigns/${campaignId}/glossary`);
export const getRolls = (campaignId: number) =>
  getJson<RollRow[]>(`/api/campaigns/${campaignId}/rolls?limit=50`);
/** The running fight's whole log, oldest first: the snapshot only carries its tail. */
export const getCombatLog = (campaignId: number) =>
  getJson<CombatLogEntry[]>(`/api/campaigns/${campaignId}/combat-log?encounter=current&limit=500`);
export const deleteCampaign = (campaignId: number) => send(`/api/campaigns/${campaignId}`, 'DELETE');
export const restoreCampaign = (campaignId: number) => send(`/api/campaigns/${campaignId}/restore`, 'POST');

/** The player's view of the campaign's region map, or null before one exists. */
export const getRegion = (campaignId: number) =>
  getJson<{ region: PlayerRegionSummary | null }>(`/api/campaigns/${campaignId}/region`);
/** A 400 carries the player's own words (a bad file, an existing region) and a 502 suggests uploading. */
export const postRegion = (campaignId: number, body: RegionRequest) =>
  postChecked<{ region: PlayerRegionSummary }>(`/api/campaigns/${campaignId}/region`, body);

export const getSettings = (campaignId: number) =>
  getJson<CampaignSettings>(`/api/campaigns/${campaignId}/settings`);

export async function patchSettings(campaignId: number, patch: Partial<CampaignSettings>): Promise<CampaignSettings> {
  const res = await fetch(`/api/campaigns/${campaignId}/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(`settings -> ${res.status}`, res.status);
  return (await res.json()) as CampaignSettings;
}

export const getPendingRolls = (campaignId: number) =>
  getJson<PendingRoll[]>(`/api/campaigns/${campaignId}/pending-rolls`);
/** Cheat mode only: the honest roll, before the player decides what to do with it. */
export const previewRoll = (rollId: number) => postJson<RollResult>(`/api/rolls/${rollId}/preview`);
export const resolveRoll = (rollId: number, override?: { dice: number[] }) =>
  postJson<RollResult>(`/api/rolls/${rollId}/resolve`, override ? { override } : {});

/** Selects one homebrew boost before rolling and returns the recomputed pending-roll card. */
export const boostRoll = (rollId: number, boostId: string) =>
  postJson<PendingRoll & Required<PendingRollBoosts>>(`/api/rolls/${rollId}/boost`, { boost_id: boostId });

/** Heroic Inspiration: the server rerolls the d20 the player has just seen and spends the star. */
export const inspireRoll = (rollId: number) => postJson<RollResult>(`/api/rolls/${rollId}/inspire`);

/** A companion's full sheet, through the same mask as the player's own. */
export const getCompanionSheet = (characterId: number) =>
  getJson<Pc>(`/api/characters/${characterId}/sheet`);

export const setOverrides = (characterId: number, patch: Record<string, number | null>) =>
  postJson<unknown>(`/api/characters/${characterId}/overrides`, patch);

export const undoCombat = (campaignId: number) =>
  postChecked<{ undone: string; state: BattleState; log: CombatLogEntry[] }>(
    `/api/campaigns/${campaignId}/combat/undo`,
    undefined,
  );
export const rewindCampaign = (campaignId: number) =>
  postChecked<{ reverted_events: number; cancelled_rolls: number; checkpoint_at: string }>(
    `/api/campaigns/${campaignId}/rewind`,
    undefined,
  );

/** The fuller list behind the handful the snapshot carries; only what the party has heard. */
export const getRumoursInScope = (campaignId: number, scope?: RumourScope) =>
  getJson<Rumour[]>(`/api/campaigns/${campaignId}/rumours${scope ? `?scope=${scope}` : ''}`);

export const getJournal = (campaignId: number) =>
  getJson<JournalEntry[]>(`/api/campaigns/${campaignId}/journal`);
/** The one write this window makes: the player's own note. */
export const addJournalEntry = (campaignId: number, text: string) =>
  postChecked<JournalEntry>(`/api/campaigns/${campaignId}/journal`, { text });

/** The whole index in one call; the panel searches and filters it in the window. */
export const getCodex = (campaignId: number) =>
  getJson<{ entities: CodexListItem[] }>(`/api/campaigns/${campaignId}/codex`);
export const getEntity = (campaignId: number, entityId: number) =>
  getJson<EntityView>(`/api/campaigns/${campaignId}/entities/${entityId}`);
export const getEntityTree = (campaignId: number, entityId: number) =>
  getJson<{ tree: TreeNode }>(`/api/campaigns/${campaignId}/entities/${entityId}/tree`);

export interface TownMapAnswer {
  name: string;
  kind: 'city' | 'village';
  geojson: unknown;
}

/** The drawn map of a known settlement, or null when the server has none; a miss is normal, not an error. */
export async function getTownMap(campaignId: number, entityId: number): Promise<TownMapAnswer | null> {
  const path = `/api/campaigns/${campaignId}/entities/${entityId}/town-map`;
  const res = await fetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as TownMapAnswer;
}

/** The level-up window the DM prepared: the SRD options and their own suggestions. */
export const getLevelUp = (characterId: number) =>
  getJson<LevelUpAnswer>(`/api/characters/${characterId}/level-up`);
/** A 400 names exactly what is missing, in the engine's own words: it goes on the panel as it is. */
export const applyLevelUp = (characterId: number, body: LevelUpBody) =>
  postChecked<{ name: string; level: number }>(`/api/characters/${characterId}/level-up`, body);

export const getDecisions = (campaignId: number) =>
  getJson<PendingDecision[]>(`/api/campaigns/${campaignId}/decisions`);
export const resolveDecision = (
  decisionId: number,
  decision: DecisionChoice,
  edits?: { mechanics: Mechanics } | { schema: HomebrewSubclassSchema | HomebrewSpellSchema },
) => postJson<DecisionResult>(`/api/decisions/${decisionId}/resolve`, edits ? { decision, edits } : { decision });

/** The rulebook's own detail for a batch of spell names, for the sheet's tooltips; an unknown name is simply absent. */
export const getSpellDetails = (names: string[]) =>
  getJson<{ details: Record<string, OptionDetail> }>(`/api/srd/spells?names=${encodeURIComponent(names.join(','))}`);

export const getLibrary = (campaignId: number) =>
  getJson<LibraryAnswer>(`/api/campaigns/${campaignId}/library`);
export const saveToLibrary = (homebrewId: number) =>
  postJson<Homebrew>(`/api/homebrew/${homebrewId}/library`);
export const getPlayProfile = (campaignId: number, characterId?: number) =>
  getJson<PlayProfile>(
    `/api/campaigns/${campaignId}/play-profile${characterId === undefined ? '' : `?character_id=${characterId}`}`,
  );

export const getTactics = (campaignId: number, from: number, to: number) =>
  getJson<Tactics>(`/api/campaigns/${campaignId}/tactics?from=${from}&to=${to}`);

export const getPortraitStatus = () => getJson<{ enabled: boolean }>('/api/portraits/status');
export const getCreaturePortrait = (campaignId: number, creature: string) =>
  getJson<{ path: string }>(`/api/portraits/creature/${encodeURIComponent(creature)}?campaign_id=${campaignId}`);

async function upload(path: string, file: File): Promise<{ path: string }> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': file.type }, body: file });
  if (!res.ok) throw new ApiError(`${path} -> ${res.status}`, res.status);
  return (await res.json()) as { path: string };
}

export const uploadCharacterPortrait = (characterId: number, file: File) =>
  upload(`/api/characters/${characterId}/portrait`, file);
export const uploadCreaturePortrait = (campaignId: number, creature: string, file: File) =>
  upload(`/api/portraits/creature/${encodeURIComponent(creature)}?campaign_id=${campaignId}`, file);

let presetFile: Promise<PresetFile> | undefined;

/** The preset file never changes while the server runs, and two panels want it. */
export function getPresets(): Promise<PresetFile> {
  presetFile ??= getJson<PresetFile>('/api/presets').catch((problem) => {
    presetFile = undefined;
    throw problem;
  });
  return presetFile;
}
export const getCharacterOptions = (query: { class?: string; species?: string; background?: string }) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  return getJson<CharacterOptions>(`/api/srd/options?${params.toString()}`);
};
export const createCampaign = (body: NewCampaignBody) => postChecked<CampaignListItem>('/api/campaigns', body);
export const createCharacter = (campaignId: number, body: NewCharacterBody) =>
  postChecked<CreatedCharacter>(`/api/campaigns/${campaignId}/character`, body);
