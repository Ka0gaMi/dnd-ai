import { describe, expect, it } from 'vitest';
import { CUNNING_STRIKE_DM_APPLIED, FEATURES } from '../src/combat/features.js';
import type { CombatSheet } from '../src/combat/sheet.js';
import { feats, invocations } from '../src/srd/data.js';

// Derived from the code, not scraped. The A2b (class features) and A8c (items) waves of the master plan shrink this list.
const PINNED_COUNT = 32;
const PINNED: string[] = [
  'cunning strike: daze',
  'epic boon: Boon of Dimensional Travel',
  'epic boon: Boon of Truesight',
  'epic boon: Boon of the Night Spirit',
  'feature: barbarian-primal-knowledge',
  'feature: bard-countercharm',
  'feature: champion-remarkable-athlete',
  'feature: devotion-sacred-weapon',
  'feature: draconic-sorcery-dragon-companion',
  'feature: draconic-sorcery-dragon-wings',
  'feature: druid-druidic',
  'feature: fighter-tactical-mind',
  'feature: hunter-defensive-tactics',
  'feature: monk-acrobatic-movement',
  'feature: monk-slow-fall',
  'feature: paladin-faithful-steed',
  'feature: ranger-feral-senses',
  'feature: rogue-thieves-cant',
  'feature: thief-second-story-work',
  'feature: thief-supreme-sneak',
  'feature: thief-thiefs-reflexes',
  'feature: warlock-contact-patron',
  'feature: warlock-eldritch-master',
  'feature: warlock-magical-cunning',
  'feature: wizard-ritual-adept',
  'invocation: Devil’s Sight',
  'invocation: Gaze of Two Minds',
  'invocation: Gift of the Protectors',
  'invocation: Investment of the Chain Master',
  'invocation: Lessons of the First Ones',
  'invocation: Pact of the Tome',
  'invocation: Witch Sight',
];

/** One sorted line per feature the engine hands to the DM: registry handlers, Epic Boons, invocations, Cunning Strike effects. */
function derive(): string[] {
  const out: string[] = [];
  for (const handler of Object.values(FEATURES)) if (handler.dm_applied) out.push(`feature: ${handler.index}`);
  // Epic Boons live in a private table; the epic-boon handler's passive note says "left to you" for the unapplied ones.
  const epicBoon = FEATURES['fighter-epic-boon']!;
  for (const feat of feats().filter((f) => f.name.startsWith('Boon of'))) {
    const sheet = { class_index: 'fighter', features: [{ name: feat.name, source: 'feat' }] } as unknown as CombatSheet;
    if (epicBoon.passive?.(sheet)?.note?.includes('left to you - ')) out.push(`epic boon: ${feat.name}`);
  }
  for (const entry of invocations()) if (entry.mechanics?.dm_applied) out.push(`invocation: ${entry.name}`);
  for (const option of Object.keys(CUNNING_STRIKE_DM_APPLIED)) out.push(`cunning strike: ${option}`);
  return out.sort();
}

describe('DM-applied features pin', () => {
  const current = derive();

  it('the pinned list is sorted and counted', () => {
    expect(PINNED).toEqual([...PINNED].sort());
    expect(PINNED.length).toBe(PINNED_COUNT);
  });

  it('nothing was removed: delete a fixed feature from the pin (shrinking is the goal)', () => {
    const removed = PINNED.filter((name) => !current.includes(name));
    expect(removed, `No longer DM-applied: delete these from PINNED and lower PINNED_COUNT: ${removed.join(', ')}`).toEqual([]);
  });

  it('nothing was added: a new DM-applied feature needs the owner\'s OK', () => {
    const added = current.filter((name) => !PINNED.includes(name));
    expect(added, `New DM-applied features need the owner's OK before they are pinned: ${added.join(', ')}`).toEqual([]);
  });
});
