// The setting presets the "New story" wizard offers, as GET /api/presets sends them.

export interface SettingPreset {
  id: string;
  name: string;
  pitch: string;
  tone: string[];
  themes: string[];
  typical_conflicts: string[];
  common_locations: string[];
  sample_hooks: string[];
  suggested_classes: Array<{ class: string; why: string }>;
  content_notes: string;
  pacing: string;
}

export interface ToneDial {
  id: string;
  name: string;
  levels: [string, string, string];
}

export interface SessionZeroField {
  id: string;
  name: string;
  help: string;
}

export interface PresetFile {
  presets: SettingPreset[];
  tone_dials: ToneDial[];
  session_zero_fields: SessionZeroField[];
}

export type DialValue = 1 | 2 | 3;

export const EMPTY_PRESETS: PresetFile = { presets: [], tone_dials: [], session_zero_fields: [] };

export const findPreset = (file: PresetFile, id: string | null): SettingPreset | null =>
  (id ? file.presets.find((preset) => preset.id === id) : undefined) ?? null;

/** The dial values each preset starts on; anything unlisted sits in the middle. */
const PRESET_DIALS: Record<string, Record<string, DialValue>> = {
  'classic-high-fantasy': { lethality: 1, grimness: 1, humour: 2, horror: 1, romance: 2, moral_greyness: 1 },
  grimdark: { lethality: 2, grimness: 3, humour: 1, horror: 2, romance: 1, moral_greyness: 3 },
  'gothic-horror': { lethality: 2, grimness: 3, humour: 1, horror: 3, romance: 2, moral_greyness: 2 },
  'political-intrigue': { lethality: 2, grimness: 2, humour: 2, horror: 1, romance: 2, moral_greyness: 3 },
  'swashbuckling-pirates': { lethality: 2, grimness: 1, humour: 3, horror: 1, romance: 3, moral_greyness: 2 },
  'wilderness-frontier': { lethality: 2, grimness: 2, humour: 2, horror: 1, romance: 1, moral_greyness: 2 },
  'urban-mystery-heist': { lethality: 2, grimness: 2, humour: 2, horror: 1, romance: 2, moral_greyness: 3 },
  megadungeon: { lethality: 3, grimness: 2, humour: 1, horror: 2, romance: 1, moral_greyness: 2 },
  'war-military': { lethality: 3, grimness: 3, humour: 1, horror: 2, romance: 2, moral_greyness: 3 },
  'planar-weird': { lethality: 2, grimness: 2, humour: 2, horror: 2, romance: 1, moral_greyness: 3 },
  'fairy-tale': { lethality: 1, grimness: 1, humour: 3, horror: 1, romance: 2, moral_greyness: 2 },
  'post-apocalyptic': { lethality: 3, grimness: 3, humour: 1, horror: 2, romance: 1, moral_greyness: 3 },
  'sword-and-sorcery': { lethality: 3, grimness: 2, humour: 2, horror: 2, romance: 2, moral_greyness: 3 },
  'mythic-epic': { lethality: 2, grimness: 1, humour: 2, horror: 1, romance: 2, moral_greyness: 2 },
};

export const PRESET_DIAL_IDS = Object.keys(PRESET_DIALS);

/** Where the six dials sit when a setting is picked: the preset's own reading, else the middle. */
export function defaultDials(presetId: string | null, dials: ToneDial[]): Record<string, DialValue> {
  const preset = presetId ? PRESET_DIALS[presetId] : undefined;
  return Object.fromEntries(dials.map((dial) => [dial.id, preset?.[dial.id] ?? 2]));
}

/** "Lethality" / "Fair — death possible, foreshadowed" for every dial the player set. */
export function dialWords(
  dials: ToneDial[],
  values: Record<string, number> | undefined,
): Array<{ id: string; name: string; word: string }> {
  if (!values) return [];
  return dials
    .filter((dial) => values[dial.id] !== undefined)
    .map((dial) => ({ id: dial.id, name: dial.name, word: dial.levels[(values[dial.id] ?? 2) - 1] ?? '' }))
    .filter((entry) => entry.word !== '');
}
