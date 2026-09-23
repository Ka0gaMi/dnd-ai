// The region the player gives a campaign: its player-safe summary and the generate/upload request shapes.

/** The region as the player's window may see it: no danger names, links or per-place seeds. */
export interface PlayerRegionSummary {
  name: string;
  tags: string[];
  seed: number;
  settlements: Array<{ name: string; size: string }>;
  areas: number;
  dangers: number;
}

export interface TagGroup {
  id: string;
  label: string;
  options: Array<{ id: string; label: string }>;
}

/** The tag axes the generator accepts, in the order the panel shows them. */
export const TAG_GROUPS: TagGroup[] = [
  {
    id: 'land',
    label: 'Land',
    options: [
      { id: 'fjord', label: 'Fjords' },
      { id: 'island', label: 'Island' },
    ],
  },
  {
    id: 'people',
    label: 'People',
    options: [
      { id: 'civilized', label: 'Civilised' },
      { id: 'wild', label: 'Wild' },
    ],
  },
  {
    id: 'law',
    label: 'Law',
    options: [
      { id: 'lawful', label: 'Lawful' },
      { id: 'neutral', label: 'Neutral' },
      { id: 'chaotic', label: 'Chaotic' },
    ],
  },
  {
    id: 'danger',
    label: 'Danger',
    options: [
      { id: 'safe', label: 'Safe' },
      { id: 'dangerous', label: 'Dangerous' },
    ],
  },
];

/** A group id mapped to its chosen option id, or null to let the generator pick. */
export type TagChoice = Record<string, string | null>;

/** A dangerous world by default; every other axis stays open. */
export const DEFAULT_TAG_CHOICE: TagChoice = { land: null, people: null, law: null, danger: 'dangerous' };

/** The chosen option ids in TAG_GROUPS order, skipping the groups left open. */
export function tagsFor(choice: TagChoice): string[] {
  const tags: string[] = [];
  for (const group of TAG_GROUPS) {
    const picked = choice[group.id];
    if (picked) tags.push(picked);
  }
  return tags;
}

/** Blank means the server picks the seed; a whole non-negative number is itself; anything else is null. */
export function parseSeed(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** One line naming the region and what the player can see; the dangers are only ever a count. */
export function summaryLine(region: PlayerRegionSummary): string {
  const parts = [
    `${region.settlements.length} ${region.settlements.length === 1 ? 'settlement' : 'settlements'}`,
    `${region.areas} ${region.areas === 1 ? 'area' : 'areas'}`,
  ];
  if (region.dangers > 0) {
    parts.push(`${region.dangers} ${region.dangers === 1 ? 'danger' : 'dangers'} the DM keeps to themselves`);
  }
  return `${region.name}: ${parts.join(', ')}`;
}

export type RegionRequest =
  | { mode: 'generate'; seed?: number; tags?: string[]; replace?: boolean }
  | { mode: 'upload'; realm: object; replace?: boolean };
