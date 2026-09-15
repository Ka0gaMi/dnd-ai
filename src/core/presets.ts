// The session-zero setting presets the "New story" wizard and the new_story prompt offer.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

export interface SettingPresetFile {
  presets: SettingPreset[];
  tone_dials: ToneDial[];
  session_zero_fields: Array<{ id: string; name: string; help: string }>;
  sources_note: string;
}

const FILE = new URL('../../presets/setting-presets.json', import.meta.url);
let cache: SettingPresetFile | undefined;

/** The whole preset file, read once per process. */
export function settingPresets(): SettingPresetFile {
  cache ??= JSON.parse(readFileSync(fileURLToPath(FILE), 'utf8')) as SettingPresetFile;
  return cache;
}

export function findPreset(id: string): SettingPreset | undefined {
  return settingPresets().presets.find((p) => p.id === id);
}

export function toneDial(id: string): ToneDial | undefined {
  return settingPresets().tone_dials.find((d) => d.id === id);
}

/** "Lethality: Fair - death possible, foreshadowed" - a dial value written the way the DM reads it. */
export function toneDialWords(id: string, value: number): string {
  const dial = toneDial(id);
  if (!dial) return `${id}: ${value}`;
  return `${dial.name}: ${dial.levels[value - 1] ?? value}`;
}
