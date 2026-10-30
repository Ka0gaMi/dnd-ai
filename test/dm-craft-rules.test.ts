import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guideTopics, readGuide, type GuideSection } from '../src/mcp/tools/guide.js';

const DM_INSTRUCTIONS = fileURLToPath(new URL('../docs/dm-instructions.md', import.meta.url));

/** Line wraps in the markdown must not hide a phrase. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** One `##` topic of a guide page, flattened; a missing topic fails the test by name. */
function topic(section: GuideSection, name: string): string {
  const found = guideTopics(readGuide(section).text).topics.find((entry) => entry.name === name);
  expect(found, `${section}/${name}`).toBeDefined();
  return flat(found!.text);
}

describe('the rules the DM needs every turn, in dm-instructions', () => {
  const text = flat(readFileSync(DM_INSTRUCTIONS, 'utf8').replace(/\r\n/g, '\n'));

  it.each([
    ['narrate events before the state', 'show what happened before you sum it up - each hit, miss, crit, spell and clue found since the player last spoke'],
    ['never name an unfound clue', 'Never name a clue or secret the party has not found'],
    ['no enemy numbers', 'never a number, even when weighing options'],
    ['turn order and gear from the tools', 'Sheet numbers, gear and turn order come from the tools, never memory'],
    ['no invented gear', 'never invent gear'],
    ['inventory before an item is mentioned', 'Check inventory before you mention an item'],
    ['distances checked', 'Before you state a distance, direction or how a place looks, check get_codex'],
    ['new distances recorded', 'record a new one as a fact'],
    ['checkpoint after rests and level-ups', 'checkpoint {op: save} after every scene, rest and level-up'],
    ['no tool talk', 'Keep tool talk out of narration and scene summaries'],
    ['no grid coordinates', 'grid coordinates'],
    ['Inspiration explained in the fiction', 'say in the fiction what earned it'],
    ['Inspiration offered when it matters', 'remind them they hold it before a roll that matters'],
    ['a deferred tool is loaded and retried', '"No such tool available" means it is not loaded yet: load it with your tool search, call again'],
  ])('%s', (_rule, phrase) => {
    expect(text).toContain(phrase);
  });

  it('no longer tells the DM to quote the engine at the player', () => {
    expect(text).not.toContain('quote the engine');
  });
});

describe('the situational rules, each in its guide topic', () => {
  it.each([
    ['combat', 'turn-loop', 'narrate everything since the player last spoke'],
    ['combat', 'turn-loop', 'Never answer with numbers and a status line alone'],
    ['combat', 'turn-loop', 'While the player character is down, `advance_turn` rolls their death save'],
    ['combat', 'turn-loop', 'end your reply there and narrate it, never several rounds in one reply'],
    ['combat', 'turn-loop', 'If they hold Heroic Inspiration and roll their own dice, remind them before the save'],
    ['combat', 'what-the-player-is-told', 'Say the turn order as the battle state lists the combatants'],
    ['combat', 'what-the-player-is-told', 'never a shield or a weapon it does not carry'],
    ['story', 'threads-and-clues', 'Show a found clue in the scene'],
    ['story', 'secrets', 'name a clue or secret the party has not found, not even as a guess'],
    ['story', 'planned-pressure', 'Run the threats you planned'],
    ['story', 'planned-pressure', 'A place the party cleared stays cleared unless the fiction gives a reason'],
    ['story', 'quests', 'Tick a step as it happens'],
    ['story', 'quests', 'the same way for every quest of a kind'],
    ['story', 'rumours', 'have an NPC say them in their own voice'],
    ['story', 'rumours', '`rumour {op: tell, ids}` with the ids you actually narrated'],
    ['codex', 'after-a-meeting', 'append a `notes` line with `entity {op: upsert}`'],
    ['codex', 'after-a-meeting', 'greets an old friend as a stranger'],
    ['codex', 'writing-an-entry', 'For a place, put where it lies in `notes`'],
    ['items', 'coins', 'Charge the price you quoted'],
  ] as const)('%s/%s: %s', (section, name, phrase) => {
    expect(topic(section, name)).toContain(phrase);
  });
});
