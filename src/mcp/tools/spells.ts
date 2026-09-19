import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { grantSpellRuling, inActiveEncounter, learnSpell, prepareSpells, useSpellSlot } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { CHARACTER_ID, WRITES, heldHolderId } from './character-shared.js';

export function registerSpellTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'spells', {
    title: 'Spells known, prepared and slots',
    description:
      'Cleric, Druid, Paladin, Wizard set their list on a long rest: the exact class table count, none above a castable level, Wizard only from the spellbook; errors give count and pool. Bards, Rangers, Sorcerers, Warlocks swap one spell on level_up. Only a Wizard keeps a spellbook; learn copies a found spell in (narrate the cost) to prepare. grant adds a class-list spell outside a level-up for any caster (a Wizard uses learn), no higher than their top slot, cantrips too, as a ruling; reason says what is owed. spend_slot works out of combat: spends a slot of that level and records Concentration; in a fight use_action {spell, slot_level} spends it and this refuses. Pass spell "Identify" with target_item to reveal an unidentified item; call for every out-of-combat level 1+ spell, cantrips free. A second Concentration ends the first, the reply saying so; an empty level is refused until a rest.',
    fields: {
      campaign_id: z.number().int(),
      character_id: CHARACTER_ID,
      spells: z.array(z.string()).optional().describe('(op=prepare) The complete new prepared list, not the changes to it.'),
      spell: z
        .string()
        .optional()
        .describe(
          "(op=learn, op=grant, op=spend_slot) The spell's SRD name. On their class list and of a level they can cast (a cantrip counts); pass it always for spend_slot, since a spell that needs Concentration is recorded on the sheet from here.",
        ),
      reason: z
        .string()
        .optional()
        .describe('(op=grant) What the player is owed, or why they get it: it goes in the log with the spell.'),
      level: z.number().int().min(1).max(9).optional().describe('(op=spend_slot) The slot level to spend.'),
      target_item: z
        .string()
        .optional()
        .describe('(op=spend_slot) Identify only: the unidentified item it is cast on, by name or id, which becomes identified.'),
    },
    ops: {
      prepare: {
        summary: 'Set the prepared list of a preparing caster after a long rest',
        requires: ['spells'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, prepareSpells(db, { ...input, spells: input.spells! }));
        },
      },
      learn: {
        summary: "Copy a found spell into a Wizard's spellbook",
        requires: ['spell'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, learnSpell(db, { ...input, spell: input.spell! }));
        },
      },
      grant: {
        summary: 'Grant a class-list spell outside a level-up, as a ruling',
        requires: ['spell', 'reason'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, grantSpellRuling(db, { ...input, spell: input.spell!, reason: input.reason! }));
        },
      },
      spend_slot: {
        summary: 'Spend a spell slot outside a fight (use_action spends it inside one)',
        requires: ['level'],
        run: (args) => {
          const { op, ...input } = args;
          // use_action spends the slot on the caster's own sheet, so a second call here would spend two.
          const characterId = heldHolderId(db, input);
          if (inActiveEncounter(db, input.campaign_id, characterId)) {
            const { name } = db.prepare('SELECT name FROM character WHERE id = ?').get(characterId) as { name: string };
            throw new Error(`${name} is in a fight: use_action {spell, slot_level} spends the slot itself. Call that instead.`);
          }
          return reply(db, input.campaign_id, useSpellSlot(db, { ...input, level: input.level! }));
        },
      },
    },
    annotations: { ...WRITES },
  });
}
