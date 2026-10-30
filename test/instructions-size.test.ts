import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTRUCTIONS } from '../src/mcp/server.js';

const DM_INSTRUCTIONS = fileURLToPath(new URL('../docs/dm-instructions.md', import.meta.url));

/** Line wraps in the markdown must not hide a phrase. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('the server INSTRUCTIONS', () => {
  it('stays within 1,200 characters', () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(1200);
  });

  it('keeps every contract line', () => {
    const text = flat(INSTRUCTIONS);
    for (const phrase of [
      'Dungeon Master',
      'load_campaign first',
      'Every die comes from roll',
      'DC',
      'roll_type',
      'outcome word',
      'checkpoint {op: save} after every scene',
      '{op: end_session}',
      'update_objectives',
      'remember {op: fact}',
      '{op: term}',
      'log_event',
      'get_character_sheet',
      'combat tools',
      'read_guide',
      'homebrew_decision',
      'Never re-ask',
      'second person, present tense',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it('lists the world among the read_guide areas', () => {
    const line = INSTRUCTIONS.split('\n').find((entry) => entry.startsWith('- read_guide'));
    expect(line).toContain('world');
  });

  it('drops the stale combat lines', () => {
    expect(INSTRUCTIONS).not.toContain('same tools you use');
    expect(INSTRUCTIONS).not.toContain('get_battle_state');
  });
});

describe('docs/dm-instructions.md', () => {
  const text = readFileSync(DM_INSTRUCTIONS, 'utf8').replace(/\r\n/g, '\n');

  it('stays within 4,200 characters', () => {
    expect(text.length).toBeLessThanOrEqual(4200);
  });

  it('keeps the tool contract and covers game time and the living world', () => {
    const body = flat(text);
    for (const phrase of [
      'load_campaign',
      'Every die comes from roll',
      'checkpoint {op: save}',
      'update_objectives',
      'remember {op: fact}',
      'log_event',
      'get_character_sheet',
      'read_guide',
      'time {op: advance}',
      'world {op: deed}',
      'second person, present tense',
    ]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  it('keeps DCs and ACs off the table unless dc_disclosure is shown', () => {
    const body = flat(text);
    expect(body).toContain('Never tell the player a DC or AC');
    expect(body).toContain('dc_disclosure: shown');
  });
});
