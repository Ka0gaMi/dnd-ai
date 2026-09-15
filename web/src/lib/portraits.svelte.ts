// Monster faces hang on the creature name, so one lookup serves every card, chip and token.
import { getCreaturePortrait } from './api';
import type { Combatant } from './types';

const paths = $state<Record<string, string | null>>({});
const asked = new Set<string>();
/** Bumped when the cache is dropped, so whoever asks for portraits asks again. */
const version = $state({ n: 0 });

export const portraitVersion = (): number => version.n;

const key = (creature: string): string => creature.trim().toLowerCase();

export function creaturePortrait(creature: string): string | null {
  return paths[key(creature)] ?? null;
}

/** Fetches a creature's portrait once; a miss is remembered so the window stops asking. */
export function wantCreaturePortrait(campaignId: number, creature: string): void {
  const name = key(creature);
  if (!name || asked.has(name)) return;
  asked.add(name);
  getCreaturePortrait(campaignId, creature)
    .then((found) => (paths[name] = found.path))
    .catch(() => (paths[name] = null));
}

/** After a `portrait` event: the next hover or render asks again. */
export function forgetCreaturePortraits(): void {
  asked.clear();
  for (const name of Object.keys(paths)) delete paths[name];
  version.n += 1;
}

/** "Goblin Warrior 2" is still a goblin warrior: portraits hang on the creature, not on the token. */
export const creatureName = (name: string): string => name.replace(/\s+\d+$/, '').trim();

/** The server's own portrait wins; the creature-name lookup only fills in when it has none. */
export function portraitFor(combatant: Combatant, lookup: (combatant: Combatant) => string | null): string | null {
  return combatant.portrait_path ?? lookup(combatant);
}
