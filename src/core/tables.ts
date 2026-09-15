// Seeded random tables: names, rumours, loot, weather, encounters. The same seed and key always
// give the same answer, so a rolled detail can be reproduced when a chat asks for it again.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seededRandom } from '../combat/map.js';
import { randomSeed } from './dice.js';

export type TableName = 'names' | 'rumours' | 'loot' | 'weather' | 'encounters';

export const TABLE_NAMES: TableName[] = ['names', 'rumours', 'loot', 'weather', 'encounters'];

interface NameCulture {
  first: string[];
  family: string[];
}

interface LootBand {
  coins: string[];
  trinkets: string[];
  items: string[];
}

interface TableFile {
  names: Record<string, NameCulture>;
  rumours: { templates: string[]; slots: Record<string, string[]> };
  loot: { bands: string[] } & Record<string, LootBand | string[]>;
  weather: Record<string, string[]>;
  encounters: Record<string, string[]>;
}

export interface TableRoll {
  table: TableName;
  key: string | null;
  seed: number;
  result: string;
  parts: Record<string, string>;
}

const FILE = new URL('../../presets/tables.json', import.meta.url);
let cache: TableFile | undefined;

export function randomTables(): TableFile {
  cache ??= JSON.parse(readFileSync(fileURLToPath(FILE), 'utf8')) as TableFile;
  return cache;
}

/** A stable 31-bit seed from whatever identifies the roll - a campaign and a date, say. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const part of parts.join('|')) {
    h ^= part.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 1;
}

/** The keys a table accepts: cultures, CR bands, seasons, terrains. Rumours take no key. */
export function tableKeys(table: TableName): string[] {
  const file = randomTables();
  switch (table) {
    case 'names':
      return Object.keys(file.names);
    case 'loot':
      return file.loot.bands;
    case 'weather':
      return Object.keys(file.weather);
    case 'encounters':
      return Object.keys(file.encounters);
    case 'rumours':
      return [];
  }
}

const pick = <T>(rng: () => number, list: T[]): T => list[Math.floor(rng() * list.length)]!;

/** "3" or "cr 3" land in the band that covers them; a band name passes straight through. */
function lootBand(key: string): string {
  const bands = randomTables().loot.bands;
  if (bands.includes(key)) return key;
  const digits = key.replace(/[^0-9.]/g, '');
  const cr = Number(digits);
  if (digits === '' || !Number.isFinite(cr)) {
    throw new Error(`Unknown loot key "${key}". Use a CR number or one of: ${bands.join(', ')}.`);
  }
  if (cr <= 4) return '0-4';
  if (cr <= 10) return '5-10';
  if (cr <= 16) return '11-16';
  return '17+';
}

function resolveKey(table: TableName, key: string | undefined, rng: () => number): string | null {
  const keys = tableKeys(table);
  if (keys.length === 0) return null;
  if (key === undefined) return pick(rng, keys);
  if (table === 'loot') return lootBand(key);
  const wanted = key.trim().toLowerCase();
  const found = keys.find((k) => k.toLowerCase() === wanted);
  if (!found) throw new Error(`Unknown ${table} key "${key}". Use one of: ${keys.join(', ')}.`);
  return found;
}

/** Fills {person}, {place}, {thing}, {creature}, {event} in a rumour template. */
function fillSlots(template: string, slots: Record<string, string[]>, rng: () => number): string {
  return template.replace(/\{(\w+)\}/g, (whole, slot: string) => {
    const options = slots[slot];
    return options ? pick(rng, options) : whole;
  });
}

export function rollTable(table: TableName, options: { seed?: number; key?: string } = {}): TableRoll {
  const file = randomTables();
  const seed = options.seed ?? randomSeed();
  const rng = seededRandom(seed);
  const key = resolveKey(table, options.key, rng);
  let parts: Record<string, string>;
  let result: string;
  switch (table) {
    case 'names': {
      const culture = file.names[key!]!;
      parts = { first: pick(rng, culture.first), family: pick(rng, culture.family) };
      result = `${parts.first} ${parts.family}`;
      break;
    }
    case 'rumours': {
      parts = { text: fillSlots(pick(rng, file.rumours.templates), file.rumours.slots, rng) };
      result = parts.text;
      break;
    }
    case 'loot': {
      const band = file.loot[key!] as LootBand;
      parts = {
        coins: pick(rng, band.coins),
        trinket: pick(rng, band.trinkets),
        item: pick(rng, band.items),
      };
      result = `${parts.coins}; ${parts.trinket}; ${parts.item}`;
      break;
    }
    case 'weather': {
      result = pick(rng, file.weather[key!]!);
      parts = { weather: result };
      break;
    }
    case 'encounters': {
      result = pick(rng, file.encounters[key!]!);
      parts = { encounter: result };
      break;
    }
  }
  return { table, key, seed, result, parts };
}
