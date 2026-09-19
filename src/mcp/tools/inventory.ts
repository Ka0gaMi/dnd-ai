import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addItem, adjustGold, equipItem, listInventory, removeItem, sellItem, useItem } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { CHARACTER_ID, COIN_PURSE, ITEM_MAGIC, ITEM_REF, WRITES } from './character-shared.js';

export function registerInventoryTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'inventory', {
    title: 'Gold, items and equipment',
    description:
      'Gold/items change only here, never narrated. gold: delta or coins {cp,sp,ep,gp,pp}, negative to spend, never both; change automatic; debt refused unless allow_debt; purchases via add cost_gp. add: an SRD name copies cost, weight and properties; SRD/+N gear brings rarity, attunement, charges, bonus; invented need rarity; bonus needs base; unidentified masked till Identify; into a container; same name merges; equipped wears it; over STR x 15 lb slows to 5 ft. remove: whole/qty, loose or nested; errors list what they carry; full container needs force. equip: wear/stow armour and shields, recomputing AC (armour, shield, DEX cap, Unarmored Defense, +N once attuned) with ac_breakdown, untrained warns; one body armour. list: items (qty, id, note, weight, magic, nesting), purse/total, 3 attune slots, weight vs capacity, unidentified masked (true_name), companion id. use: spends charges off wand/staff/ring; recharge (dawn, dusk, long rest, never); refuses at zero; unknown recharge yours (restore returns them, logged; add magic.charges.recharge sets it); casts nothing. sell: pays at once; without price_gp half SRD list price; magic item needs price_gp; equipped/attuned needs off or force.',
    fields: {
      campaign_id: z.number().int(),
      character_id: CHARACTER_ID,
      delta: z.number().int().optional().describe('(op=gold) Gold pieces: negative to spend, positive to gain. Pass this or coins.'),
      coins: COIN_PURSE.optional().describe('(op=gold) Exact coins instead of delta, e.g. {sp: -5} for five silver.'),
      reason: z.string().optional().describe('(op=gold) What it was for, e.g. "a night at the Gilded Eel".'),
      allow_debt: z.boolean().optional().describe('(op=gold, op=add) True to let the purse go below zero.'),
      name: z
        .string()
        .optional()
        .describe('(op=add) The SRD name where there is one, e.g. "Potion of Healing"; (op=remove, op=equip) an item already carried, by name or id.'),
      item: z.string().optional().describe(`(op=use, op=sell) ${ITEM_REF}`),
      qty: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('(op=add, op=remove, op=sell) How many: 1 by default for add and sell, the whole stack by default for remove.'),
      notes: z.string().optional().describe('(op=add) Your own description; replaces the SRD one.'),
      equipped: z.boolean().optional().describe('(op=add, op=equip) True to wear or wield it; for equip, false takes it off.'),
      cost_gp: z.number().int().min(0).optional().describe('(op=add) What the character pays for it, deducted here.'),
      weight_lb: z.number().min(0).optional().describe('(op=add) Weight of one, for an item the SRD does not list.'),
      magic: ITEM_MAGIC.optional().describe('(op=add) What makes the item magical. An item the SRD does not know must at least name its rarity.'),
      unidentified: z
        .boolean()
        .optional()
        .describe('(op=add) True when nobody knows what it is yet: the player\'s own sheet shows only its kind until a short rest or Identify.'),
      into: z.string().optional().describe('(op=add) A container already carried, by name or id, to put it in, e.g. "Backpack".'),
      container: z
        .object({
          capacity_lb: z.number().min(0).optional().describe('What it holds, in pounds; leave it out for no limit.'),
          weightless_contents: z.boolean().optional().describe('True when what is inside weighs its carrier nothing.'),
        })
        .optional()
        .describe('(op=add) Declares the item a container, for a chest, a saddlebag or anything the SRD does not list as one.'),
      charges: z.number().int().min(1).optional().describe('(op=use) How many charges this use costs; 1 by default, and 0 when restore is passed.'),
      restore: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('(op=use) Charges you are handing back as a DM ruling, for an item whose recharge the SRD text does not carry.'),
      price_gp: z.number().min(0).optional().describe('(op=sell) What the buyer pays for one, in gold, instead of half the SRD price.'),
      force: z
        .boolean()
        .optional()
        .describe('(op=remove, op=sell) True to remove a container and lose what is inside, or to sell something still equipped or attuned.'),
    },
    shared: ['character_id'],
    ops: {
      gold: {
        summary: 'Add or spend coins',
        requires: ['reason'],
        uses: ['delta', 'coins', 'allow_debt'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, adjustGold(db, { ...input, reason: input.reason! }));
        },
      },
      add: {
        summary: 'Put an item on the sheet',
        requires: ['name'],
        uses: ['qty', 'notes', 'equipped', 'cost_gp', 'weight_lb', 'allow_debt', 'magic', 'unidentified', 'into', 'container'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, addItem(db, { ...input, name: input.name! }));
        },
      },
      remove: {
        summary: 'Take an item off the sheet',
        requires: ['name'],
        uses: ['qty', 'force'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, removeItem(db, { ...input, name: input.name! }));
        },
      },
      equip: {
        summary: 'Wear, wield or put away armour and shields',
        requires: ['name', 'equipped'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, equipItem(db, { ...input, name: input.name!, equipped: input.equipped! }));
        },
      },
      list: {
        summary: 'List the inventory, purse and equipment',
        requires: [],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, listInventory(db, input));
        },
      },
      use: {
        summary: 'Spend the charges of a magic item',
        requires: ['item'],
        uses: ['charges', 'restore'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, useItem(db, { ...input, item: input.item! }));
        },
      },
      sell: {
        summary: 'Sell an item and put the coins in the purse',
        requires: ['item'],
        uses: ['qty', 'price_gp', 'force'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, sellItem(db, { ...input, item: input.item! }));
        },
      },
    },
    annotations: { ...WRITES },
  });
}
