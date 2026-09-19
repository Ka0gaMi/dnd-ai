import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { grantSpellRuling, inActiveEncounter, learnSpell, prepareSpells, useSpellSlot } from '../../core/character.js';
import { reply } from './result.js';
import { CHARACTER_ID, WRITES, heldHolderId } from './character-shared.js';

export function registerSpellTools(server: McpServer, db: Db): void {
  server.registerTool(
    'prepare_spells',
    {
      title: 'Prepare spells',
      description:
        "Sets the whole prepared list of a Cleric, Druid, Paladin or Wizard after a long rest - the 2024 classes whose list changes with the day. The list must be exactly as long as their class table allows, no spell may be above the level they can cast, and a Wizard may only prepare what stands in their spellbook. Anything wrong comes back with the count and the legal pool, so read that out. Bards, Rangers, Sorcerers and Warlocks do not re-prepare: they swap one spell when they gain a level, through level_up.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        spells: z.array(z.string()).describe('The complete new prepared list, not the changes to it.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, prepareSpells(db, input)),
  );

  server.registerTool(
    'learn_spell',
    {
      title: 'Copy a spell into a spellbook',
      description:
        "Writes a spell into a Wizard's spellbook - a scroll they found, a rival's book they studied, a master's gift. What it costs in gold and hours is yours to narrate; the sheet only records the page. Afterwards the spell can be prepared with prepare_spells like any other. Only a Wizard keeps a spellbook; other classes learn spells when they level.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        spell: z.string().describe('An SRD spell name of a level they can cast.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, learnSpell(db, input)),
  );

  server.registerTool(
    'grant_spell',
    {
      title: 'Grant a spell (ruling)',
      description:
        "Adds one spell to a caster's list outside a level-up - a pick that was lost, a boon from a patron, the reward at the end of a quest. It works for any class that learns spells; a Wizard's spellbook still goes through learn_spell. The spell must be on the character's class list and no higher than their highest slot level, and a cantrip is fine. It is written down as your ruling, so say in reason what the player is owed.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        spell: z.string().describe('A spell of their class list, of a level they can cast; a cantrip counts.'),
        reason: z.string().describe('What the player is owed, or why they get it: it goes in the log with the spell.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantSpellRuling(db, input)),
  );

  server.registerTool(
    'use_spell_slot',
    {
      title: 'Spend a spell slot',
      description:
        'Outside a fight only: marks one spell slot of the given level as used, and records Concentration when the spell needs it. Inside an encounter never call it - use_action {spell, slot_level} spends the slot itself, and this tool refuses while the caster is in the fight. Casting Identify on an unidentified magic item reveals it: pass spell "Identify" and target_item with the item. Call it every time the player casts a spell of level 1 or higher out of combat, passing spell with its name; cantrips cost nothing and need no call. Starting a second Concentration spell ends the first and the reply says so. The tool refuses when no slot of that level is left, which means the spell simply cannot be cast until a rest.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        level: z.number().int().min(1).max(9),
        spell: z
          .string()
          .optional()
          .describe('The spell being cast. Pass it always: a spell that needs Concentration is recorded on the sheet from here.'),
        target_item: z
          .string()
          .optional()
          .describe('Identify only: the unidentified item it is cast on, by name or id, which becomes identified.'),
      },
      annotations: { ...WRITES },
    },
    (input) => {
      // use_action spends the slot on the caster's own sheet, so a second call here would spend two.
      const characterId = heldHolderId(db, input);
      if (inActiveEncounter(db, input.campaign_id, characterId)) {
        const { name } = db.prepare('SELECT name FROM character WHERE id = ?').get(characterId) as { name: string };
        throw new Error(`${name} is in a fight: use_action {spell, slot_level} spends the slot itself. Call that instead.`);
      }
      return reply(db, input.campaign_id, useSpellSlot(db, input));
    },
  );
}
