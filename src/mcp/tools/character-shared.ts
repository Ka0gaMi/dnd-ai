import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { pcRow } from '../../core/campaign.js';
import { clausesSchema } from '../../core/mechanics.js';
import { ITEM_RARITIES } from '../../srd/lookup.js';

export const ABILITY_SCORES = z.object({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});

export const CHARACTER_ID = z
  .number()
  .int()
  .optional()
  .describe('Who this applies to. Leave it out for the player character; pass a companion id from the briefing.');

export const ITEM_REF = 'An item the character carries, by its name or its id; items inside a container count.';

export const COIN_PURSE = z
  .object({
    cp: z.number().int().optional(),
    sp: z.number().int().optional(),
    ep: z.number().int().optional(),
    gp: z.number().int().optional(),
    pp: z.number().int().optional(),
  })
  .describe('Coins by denomination, negative to spend: 10 cp = 1 sp, 5 sp = 1 ep, 2 ep = 1 gp, 10 gp = 1 pp.');

export const ITEM_MAGIC = z
  .object({
    rarity: z
      .enum(ITEM_RARITIES)
      .optional()
      .describe('Required for an item the SRD does not know; an SRD magic item brings its own.'),
    attunement: z
      .union([z.boolean(), z.string()])
      .optional()
      .describe('false for none, true for anyone, or the requirement in words, e.g. "by a Wizard".'),
    bonus: z.number().int().min(1).max(3).optional().describe('+N to attack and damage for a weapon, to AC for armour or a shield.'),
    base: z
      .string()
      .optional()
      .describe(
        'The SRD equipment this is a magical version of. A weapon, armour or shield, e.g. "Longsword", whenever bonus is set; otherwise any SRD equipment name, e.g. "Backpack", for what it looks like.',
      ),
    charges: z
      .object({
        current: z.number().int().min(0),
        max: z.number().int().min(1),
        recharge: z
          .enum(['dawn', 'dusk', 'long_rest', 'never', 'unknown'])
          .describe('When the charges come back; "unknown" is the SRD text not saying, which leaves it to you.'),
        dice: z.string().optional().describe('What one recharge rolls, e.g. "1d6+1"; leave it out to get every charge back.'),
      })
      .optional(),
    identified: z.boolean().optional().describe('Use the unidentified flag instead; this is the stored form of it.'),
    mechanics: z
      .object({
        resistances: z.array(z.string()).optional(),
        vulnerabilities: z.array(z.string()).optional(),
        immunities: z.array(z.string()).optional(),
        ac_bonus: z.number().int().optional(),
        clauses: clausesSchema
          .optional()
          .describe(
            'What the item does, in the clause language a feature uses; it applies only while the item is worn, and attuned when it asks for attunement, so the clauses never have to say so.',
          ),
      })
      .optional()
      .describe('What the item does in numbers, in the same shape a feature carries them.'),
  })
  .describe('What makes the item magical. An item the SRD does not know must at least name its rarity.');

export const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Which character this call is about, so concentration is read and ended on the right row. */
export function heldHolderId(db: Db, input: { campaign_id: number; character_id?: number }): number {
  if (input.character_id !== undefined) return input.character_id;
  const pc = pcRow(db, input.campaign_id);
  if (!pc) throw new Error(`Campaign ${input.campaign_id} has no character yet.`);
  return pc.id as number;
}
