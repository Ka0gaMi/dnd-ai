// Spell tooltips on the sheet: the same hover the level-up dialog shows, one batched fetch per new name.
import { getSpellDetails } from './api';
import type { OptionDetail } from './progression';

const details = $state<Record<string, OptionDetail | null>>({});
const asked = new Set<string>();

export function spellDetail(name: string): OptionDetail | null {
  return details[name] ?? null;
}

/** Names not yet asked for, in the order given and without repeats: what one batch still needs to fetch. */
export function namesToFetch(shown: string[], askedAlready: Set<string>): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const name of shown) {
    if (!name || askedAlready.has(name) || seen.has(name)) continue;
    seen.add(name);
    missing.push(name);
  }
  return missing;
}

/** Fetches whatever names on the sheet have not been asked for yet, in one request; a miss stays name-only. */
export async function wantSpellDetails(names: string[]): Promise<void> {
  const missing = namesToFetch(names, asked);
  if (missing.length === 0) return;
  for (const name of missing) asked.add(name);
  try {
    const found = (await getSpellDetails(missing)).details;
    for (const name of missing) details[name] = found[name] ?? null;
  } catch {
    // The server did not answer: forget having asked, so the next snapshot tries again.
    for (const name of missing) asked.delete(name);
  }
}
