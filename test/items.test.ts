import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import { advanceTime } from '../src/core/calendar.js';
import {
  addItem,
  adjustGold,
  applyDamage,
  createCharacter,
  equipItem,
  listInventory,
  removeItem,
  rest,
  sellItem,
  spendFeatureResource,
  useItem,
  useSpellSlot,
  type CreateCharacterInput,
  type InventoryItem,
} from '../src/core/character.js';
import { clauseSchema } from '../src/core/mechanics.js';
import { actionsFor } from '../src/combat/actions.js';
import { combatSheet } from '../src/combat/sheet.js';
import { damageCombatant, endEncounter, startEncounter } from '../src/combat/engine.js';
import { activeEncounter, listCombatants } from '../src/combat/state.js';
import { coinsCp, settleCoins, type Coins } from '../src/core/rules.js';
import { attunementRequirementMet, findMagicItem, containerSpec, unidentifiedKind } from '../src/srd/lookup.js';
import { readGuide } from '../src/mcp/tools/guide.js';
import { setOverrides } from '../src/core/overrides.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Ashfall', story_shape: 'sandbox' }).campaign_id;
});

function fighter(overrides: Partial<CreateCharacterInput> = {}) {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
    ...overrides,
  });
}

function wizard() {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'investigation', 'perception'],
    cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
    spells: ['Magic Missile', 'Shield', 'Sleep', 'Identify'],
    spellbook: ['Magic Missile', 'Shield', 'Sleep', 'Identify', 'Alarm', 'Feather Fall'],
  });
}

const sheet = () => getCharacterSheet(db, campaignId)!;
const items = () => listInventory(db, { campaign_id: campaignId }).items;
const carried = (name: string) => items().find((i) => i.name === name);
/** Everything one campaign has written to the log, text and payload alike. */
const events = () =>
  db.prepare('SELECT kind, text, payload_json FROM event WHERE campaign_id = ?').all(campaignId) as Array<{
    kind: string;
    text: string;
    payload_json: string | null;
  }>;

// --- 1. data -----------------------------------------------------------------

describe('SRD magic item data', () => {
  it('resolves the generic +N weapon, armour and shield however the name is written', () => {
    for (const name of ['+1 Weapon', 'Weapon +1', '+1 Longsword', 'Longsword +1']) {
      expect(findMagicItem(name)).toMatchObject({ bonus: 1, rarity: 'uncommon', attunement: false });
    }
    expect(findMagicItem('+3 Weapon')).toMatchObject({ bonus: 3, rarity: 'very_rare' });
    expect(findMagicItem('+1 Armor')).toMatchObject({ bonus: 1, rarity: 'rare' });
    expect(findMagicItem('+2 Chain Mail')).toMatchObject({ bonus: 2, rarity: 'very_rare', base: 'Chain Mail' });
    expect(findMagicItem('+2 Shield')).toMatchObject({ bonus: 2, rarity: 'rare' });
    expect(findMagicItem('+3 Shield')!.name).toBe('+3 Shield');
  });

  it('resolves the healing potion tiers, wand charges, a container and an attunement requirement', () => {
    expect(findMagicItem('Potion of Healing')).toMatchObject({ rarity: 'common' });
    expect(findMagicItem('Potion of Greater Healing')).toMatchObject({ rarity: 'uncommon' });
    expect(findMagicItem('potion of superior healing')).toMatchObject({ rarity: 'rare' });

    expect(findMagicItem('Wand of Magic Missiles')!.charges).toEqual({
      current: 7,
      max: 7,
      recharge: 'dawn',
      dice: '1d6+1',
    });
    expect(findMagicItem('Bag of Holding')!.container).toEqual({ capacity_lb: 500, weightless_contents: true });
    expect(containerSpec('Backpack')).toEqual({ capacity_lb: 30 });

    expect(findMagicItem('Holy Avenger')!.attunement).toBe('by a Paladin');
    expect(findMagicItem('Cloak of Elvenkind')!.attunement).toBe(true);
    // A plain shield is a mundane item, even though the SRD names its +N entry the same.
    expect(findMagicItem('Shield')).toBeUndefined();
  });

  it('names the kind of an item nobody has identified, never the item', () => {
    expect(unidentifiedKind('+1 Longsword')).toBe('longsword');
    expect(unidentifiedKind('Potion of Greater Healing')).toBe('potion');
    expect(unidentifiedKind('Wand of Magic Missiles')).toBe('wand');
    // The kind comes off the category, not off the entry the SRD prints the item under.
    expect(unidentifiedKind('Potion of Healing')).toBe('potion');
    expect(unidentifiedKind('Cloak of Elvenkind')).toBe('cloak');
    expect(unidentifiedKind('Immovable Rod')).toBe('rod');
    expect(unidentifiedKind('Staff of Power')).toBe('staff');
    expect(unidentifiedKind('+2 Chain Mail')).toBe('chain mail');
    // A weapon named for what it does would give itself away; it is only ever "weapon".
    expect(unidentifiedKind('Holy Avenger')).toBe('weapon');
  });

  it('counts only the containers the SRD names as containers', () => {
    expect(containerSpec('Backpack')).toEqual({ capacity_lb: 30 });
    expect(containerSpec('Sack')).toEqual({ capacity_lb: 30 });
    expect(containerSpec('Waterskin')).toEqual({});
    expect(containerSpec('Bag of Holding')).toEqual({ capacity_lb: 500, weightless_contents: true });
    // Both of these say what they can "hold" in their rules text, and neither carries anything.
    expect(containerSpec('Immovable Rod')).toBeUndefined();
    expect(containerSpec('Rope of Climbing')).toBeUndefined();
    expect(containerSpec('Chain Mail')).toBeUndefined();
  });

  it('says it does not know when the bundled text carries charges but no recharge', () => {
    expect(findMagicItem('Wand of Fear')!.charges).toMatchObject({ current: 7, max: 7, recharge: 'unknown' });
    expect(findMagicItem('Staff of Power')!.charges).toMatchObject({ max: 20, recharge: 'unknown' });
    expect(findMagicItem('Wand of Magic Missiles')!.charges!.recharge).toBe('dawn');
  });

  it('hands a half-readable attunement requirement back to the DM', () => {
    const dwarf = { class: 'Fighter', species: 'Dwarf', spellcaster: false };
    const human = { class: 'Fighter', species: 'Human', spellcaster: false };
    const thrower = findMagicItem('Dwarven Thrower')!.attunement as string;
    expect(attunementRequirementMet(thrower, dwarf)).toBe(true);
    // "or a Creature Attuned to a Belt of Dwarvenkind" is not something the parser reads.
    expect(attunementRequirementMet(thrower, human)).toBeNull();
    expect(attunementRequirementMet('by a Paladin', human)).toBe(false);
  });
});

// --- 2. item model -----------------------------------------------------------

describe('the item model', () => {
  it('gives every item an opaque id that gives nothing away', () => {
    fighter();
    expect(items().every((i) => typeof i.id === 'string' && /^[a-z0-9]{6}$/.test(i.id!))).toBe(true);
    expect(carried('Chain Mail')!.id).not.toContain('chain');

    const hidden = addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true }).item;
    // An id built from the name would hand the player the true name of anything unidentified.
    for (const part of ['longsword', 'long', 'sword', '1-longsword']) expect(hidden.id).not.toContain(part);
    expect(new Set(items().map((i) => i.id)).size).toBe(items().length);
  });

  it('backfills ids for a row written before ids existed and writes them back', () => {
    fighter();
    const legacy = items().map(({ id, ...rest }) => rest);
    db.prepare('UPDATE character SET inventory_json = ? WHERE campaign_id = ?').run(JSON.stringify(legacy), campaignId);
    const stored = () =>
      (
        JSON.parse(
          (db.prepare('SELECT inventory_json FROM character WHERE campaign_id = ?').get(campaignId) as {
            inventory_json: string;
          }).inventory_json,
        ) as InventoryItem[]
      ).map((i) => i.id);

    expect(stored().every((id) => id === undefined)).toBe(true);
    listInventory(db, { campaign_id: campaignId });

    const written = stored();
    expect(written.every((id) => typeof id === 'string' && /^[a-z0-9]{6}$/.test(id))).toBe(true);
    expect(new Set(written).size).toBe(written.length);
    // Reading again hands back the ids that were stored, not a fresh set.
    listInventory(db, { campaign_id: campaignId });
    expect(stored()).toEqual(written);
  });

  it('backfills the weights and the ids of a legacy row on one read', () => {
    fighter();
    const legacy = items().map(({ id, weight_lb, ...rest }) => rest);
    db.prepare('UPDATE character SET inventory_json = ? WHERE campaign_id = ?').run(JSON.stringify(legacy), campaignId);

    // One read of the sheet: filling the weights must not leave the ids for the next one.
    sheet();
    const stored = JSON.parse(
      (db.prepare('SELECT inventory_json FROM character WHERE campaign_id = ?').get(campaignId) as {
        inventory_json: string;
      }).inventory_json,
    ) as InventoryItem[];
    expect(stored.every((i) => typeof i.id === 'string' && typeof i.weight_lb === 'number')).toBe(true);
  });

  it('fills the magic block from the SRD and refuses an invented item with no rarity', () => {
    fighter();
    const wand = addItem(db, { campaign_id: campaignId, name: 'Wand of Magic Missiles' });
    expect(wand.item.magic).toMatchObject({
      srd_index: 'wand-of-magic-missiles',
      rarity: 'uncommon',
      attunement: false,
      identified: true,
      charges: { current: 7, max: 7, recharge: 'dawn', dice: '1d6+1' },
    });
    expect(wand.item.notes).toContain('7 charges, back at dawn');

    expect(() =>
      addItem(db, { campaign_id: campaignId, name: 'Whispering Blade', magic: { attunement: true } }),
    ).toThrow(/must name its rarity.*common, uncommon, rare, very_rare, legendary, artifact/);

    const invented = addItem(db, {
      campaign_id: campaignId,
      name: 'Whispering Blade',
      magic: { rarity: 'rare', attunement: 'by a Rogue', bonus: 1 },
    });
    expect(invented.item.magic).toMatchObject({ rarity: 'rare', attunement: 'by a Rogue', bonus: 1, identified: true });
  });
});

// --- 3. attunement -----------------------------------------------------------

describe('attunement', () => {
  const attune = (...names: string[]) => rest(db, { campaign_id: campaignId, kind: 'short', attune: names });

  it('attunes on a short rest, caps at three and gives the slot back when one ends', () => {
    fighter();
    for (const name of ['Cloak of Elvenkind', 'Boots of Speed', 'Bracers of Defense', 'Amulet of Health']) {
      addItem(db, { campaign_id: campaignId, name });
    }
    expect(attune('Cloak of Elvenkind').attuned).toEqual(['Cloak of Elvenkind']);
    const three = attune('Boots of Speed', 'Bracers of Defense');
    expect(three.attunement).toMatchObject({ used: 3, max: 3 });

    expect(() => attune('Amulet of Health')).toThrow(/already attuned to three: Cloak of Elvenkind/);

    const freed = rest(db, {
      campaign_id: campaignId,
      kind: 'short',
      unattune: ['Boots of Speed'],
      attune: ['Amulet of Health'],
    });
    expect(freed).toMatchObject({ unattuned: ['Boots of Speed'], attuned: ['Amulet of Health'] });
    expect(freed.attunement!.items.sort()).toEqual(['Amulet of Health', 'Bracers of Defense', 'Cloak of Elvenkind']);
  });

  it('checks the requirement, refuses an item that needs no attunement, and needs a short rest', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Holy Avenger' });
    addItem(db, { campaign_id: campaignId, name: 'Bag of Holding' });
    addItem(db, { campaign_id: campaignId, name: 'Moon Sigil', magic: { rarity: 'rare', attunement: 'by a Starborn' } });

    expect(() => attune('Holy Avenger')).toThrow(/only be attuned by a Paladin, and Borg is a Dwarf Fighter/);
    expect(() => attune('Bag of Holding')).toThrow(/needs no attunement/);
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long', attune: ['Holy Avenger'] })).toThrow(
      /take a short rest spent focused on it/,
    );

    // A requirement the SRD knows nothing about is allowed, and handed back to the DM.
    const odd = attune('Moon Sigil');
    expect(odd.attuned).toEqual(['Moon Sigil']);
    expect(odd.notes!.join(' ')).toMatch(/cannot parse/);
  });

  it('allows what it cannot parse, refuses what it can, and takes a DM ruling on the refusal', () => {
    wizard(); // Zel, a Human Wizard: neither a Dwarf nor a Paladin
    addItem(db, { campaign_id: campaignId, name: 'Dwarven Thrower' });
    addItem(db, { campaign_id: campaignId, name: 'Holy Avenger' });

    // "by a Dwarf or a Creature Attuned to a Belt of Dwarvenkind" is half something the parser reads.
    const odd = attune('Dwarven Thrower');
    expect(odd.attuned).toEqual(['Dwarven Thrower']);
    expect(odd.notes!.join(' ')).toMatch(/cannot parse/);

    expect(() => attune('Holy Avenger')).toThrow(/only be attuned by a Paladin.*attune_ruling/s);
    const ruled = rest(db, {
      campaign_id: campaignId,
      kind: 'short',
      attune: ['Holy Avenger'],
      attune_ruling: 'the sword chose her on the barrow steps',
    });
    expect(ruled.attuned).toEqual(['Holy Avenger']);
    expect(ruled.rulings!.join(' ')).toMatch(/Holy Avenger is attuned by a Paladin.*chose her/s);
    expect(events().map((e) => e.text).join(' ')).toMatch(/by DM ruling, Holy Avenger is attuned by a Paladin/);
  });

  it('ends every attunement when the character dies', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Cloak of Elvenkind' });
    attune('Cloak of Elvenkind');
    expect(sheet().attunement.used).toBe(1);

    applyDamage(db, { campaign_id: campaignId, amount: 500, source: 'a falling pillar' });
    expect(sheet().status).toBe('dead');
    expect(sheet().attunement).toMatchObject({ used: 0, items: [] });
  });
});

// --- 4. +N gear ---------------------------------------------------------------

describe('+N gear', () => {
  it('adds a magic weapon bonus to the attack and the damage, once it is in hand', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword' });
    const attack = () => {
      const cs = combatSheet(db, sheet().id);
      return actionsFor({ stat_block: null } as never, cs).find((a) => a.name.includes('Longsword'))!;
    };
    // STR 17 (+3) and proficiency +2: +5 before the weapon's own magic.
    expect(attack()).toMatchObject({ attack_bonus: 5 });

    equipItem(db, { campaign_id: campaignId, name: '+1 Longsword', equipped: true });
    const armed = attack();
    expect(armed.attack_bonus).toBe(6);
    expect(armed.damage![0]!.dice).toBe('1d10+4');
    expect(armed.text).toContain('+1 of it from +1 Longsword');
  });

  it('adds magic armour and a magic shield to AC, and only once attuned when it asks for it', () => {
    fighter(); // chain mail 16, DEX 0
    expect(sheet().ac).toBe(16);

    addItem(db, { campaign_id: campaignId, name: '+2 Chain Mail', equipped: true });
    expect(sheet().ac).toBe(18);
    expect(sheet().ac_breakdown).toMatchObject({ total: 18, armor: 'Chain Mail', magic_bonus: 2 });
    expect(sheet().ac_breakdown.notes).toContain('+2 Chain Mail: +2 AC');

    // A shield whose magic asks for attunement is worth nothing until the rest is spent on it.
    const shield = addItem(db, {
      campaign_id: campaignId,
      name: 'Shield',
      equipped: true,
      magic: { rarity: 'rare', attunement: true, bonus: 2 },
    });
    expect(shield.attunement_note).toMatch(/does nothing until Borg attunes to it/);
    expect(sheet().ac).toBe(20); // 18 + the shield's plain +2

    rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Shield'] });
    expect(sheet().ac).toBe(22);
    expect(sheet().ac_breakdown.magic_bonus).toBe(4);
  });
});

describe('what a worn item does in a fight', () => {
  it('halves fire damage from a Ring of Fire Resistance, and does nothing unattuned', async () => {
    fighter();
    addItem(db, {
      campaign_id: campaignId,
      name: 'Ring of Fire Resistance',
      equipped: true,
      magic: { rarity: 'rare', attunement: true, mechanics: { resistances: ['fire'] } },
    });
    // Nobody is at the keyboard to click initiative here.
    updateSettings(db, campaignId, { player_rolls: 'none' });
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 3,
      terrain: 'cave',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    const encounter = activeEncounter(db, campaignId)!;
    const pc = () => listCombatants(db, encounter.id).find((c) => c.kind === 'pc')!;

    // On the finger but not attuned: the ring is inert and the fire lands in full.
    expect(combatSheet(db, sheet().id).resistances).not.toContain('fire');
    expect(damageCombatant(db, encounter, pc(), { amount: 10, type: 'fire' })).toMatchObject({
      applied: 10,
      resistance: null,
    });

    // Attuning to the ring is a short rest, and no rest fits inside a fight: end this one, rest, go again.
    endEncounter(db, { campaign_id: campaignId, outcome: 'retreat' });
    rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Ring of Fire Resistance'] });
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 3,
      terrain: 'cave',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    const rematch = activeEncounter(db, campaignId)!;
    const rematchPc = () => listCombatants(db, rematch.id).find((c) => c.kind === 'pc')!;
    expect(combatSheet(db, sheet().id).resistances).toContain('fire');
    expect(damageCombatant(db, rematch, rematchPc(), { amount: 10, type: 'fire' })).toMatchObject({
      applied: 5,
      resistance: 'resistant',
    });
  });
});

// --- 5. charges ---------------------------------------------------------------

describe('charges', () => {
  it('spends charges, refuses at zero and names the recharge', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Wand of Magic Missiles' });

    const first = useItem(db, { campaign_id: campaignId, item: 'Wand of Magic Missiles', charges: 3 });
    expect(first).toMatchObject({ spent: 3, remaining: 4, max: 7, recharges: 'at dawn' });
    expect(first.item_text).toContain('Magic Missile');

    useItem(db, { campaign_id: campaignId, item: 'Wand of Magic Missiles', charges: 4 });
    expect(() => useItem(db, { campaign_id: campaignId, item: 'Wand of Magic Missiles' })).toThrow(
      /no charges left; it recharges at dawn/,
    );
    expect(() => useItem(db, { campaign_id: campaignId, item: 'Chain Mail' })).toThrow(/has no charges/);
  });

  it('says the recharge is unknown when the SRD text does not carry it, and takes a DM ruling', () => {
    fighter();
    const wand = addItem(db, { campaign_id: campaignId, name: 'Wand of Fear' });
    expect(wand.item.magic!.charges).toMatchObject({ current: 7, max: 7, recharge: 'unknown' });

    const spent = useItem(db, { campaign_id: campaignId, item: 'Wand of Fear', charges: 7 });
    expect(spent.recharge_note).toMatch(/no recharge rule.*use_item\{restore: n\}/s);
    expect(() => useItem(db, { campaign_id: campaignId, item: 'Wand of Fear' })).toThrow(
      /is empty and.*yours to rule on/s,
    );
    // Nothing hands an unknown recharge back on its own, not even a day of world time.
    advanceTime(db, campaignId, { hours: 48 });
    expect(carried('Wand of Fear')!.magic!.charges!.current).toBe(0);

    const ruled = useItem(db, { campaign_id: campaignId, item: 'Wand of Fear', restore: 3 });
    expect(ruled).toMatchObject({ restored: 3, remaining: 3, spent: 0 });
    expect(carried('Wand of Fear')!.magic!.charges!.current).toBe(3);
    expect(events().map((e) => e.text).join(' ')).toMatch(/gets 3 charges of Wand of Fear back on a DM ruling/);
  });

  it('gives dawn charges back when the clock passes 06:00, and long-rest charges back on a long rest', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Wand of Magic Missiles' });
    addItem(db, {
      campaign_id: campaignId,
      name: 'Ember Ring',
      magic: { rarity: 'rare', charges: { current: 0, max: 3, recharge: 'long_rest' } },
    });
    useItem(db, { campaign_id: campaignId, item: 'Wand of Magic Missiles', charges: 7 });

    // The campaign clock starts at 08:00, so an hour is not yet a dawn.
    advanceTime(db, campaignId, { hours: 1 });
    const chargesOf = (name: string) => carried(name)!.magic!.charges!;
    expect(chargesOf('Wand of Magic Missiles').current).toBe(0);

    advanceTime(db, campaignId, { hours: 24 });
    const wand = chargesOf('Wand of Magic Missiles');
    expect(wand.current).toBeGreaterThanOrEqual(2);
    expect(wand.current).toBeLessThanOrEqual(7);

    const long = rest(db, { campaign_id: campaignId, kind: 'long' });
    expect(long.items_recharged).toEqual(['Ember Ring (3 charges)']);
    expect(chargesOf('Ember Ring').current).toBe(3);
  });
});

// --- 6. containers ------------------------------------------------------------

describe('containers', () => {
  it('puts an item in a container, finds it there and counts its weight', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Backpack' });
    const before = listInventory(db, { campaign_id: campaignId }).carried_lb;
    addItem(db, { campaign_id: campaignId, name: 'Iron Ingot', weight_lb: 8, qty: 2, into: 'Backpack' });

    const pack = carried('Backpack')!;
    expect(pack.container!.contents.map((i) => i.name)).toEqual(['Iron Ingot']);
    expect(listInventory(db, { campaign_id: campaignId }).carried_lb).toBe(before + 16);

    // Everything that names an item looks inside containers too.
    expect(removeItem(db, { campaign_id: campaignId, name: 'Iron Ingot', qty: 1 })).toMatchObject({ remaining: 1 });
    expect(listInventory(db, { campaign_id: campaignId }).carried_lb).toBe(before + 8);
  });

  it('refuses what will not fit, and carries a Bag of Holding weightlessly', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Backpack' });
    expect(() => addItem(db, { campaign_id: campaignId, name: 'Anvil', weight_lb: 100, into: 'Backpack' })).toThrow(
      /Backpack holds 30 lb/,
    );
    expect(() => addItem(db, { campaign_id: campaignId, name: 'Torch', into: 'Chain Mail' })).toThrow(
      /is not a container/,
    );

    const bag = addItem(db, { campaign_id: campaignId, name: 'Bag of Holding' });
    expect(bag.item.container).toMatchObject({ capacity_lb: 500, weightless_contents: true, contents: [] });
    const loaded = listInventory(db, { campaign_id: campaignId }).carried_lb;
    addItem(db, { campaign_id: campaignId, name: 'Anvil', weight_lb: 100, qty: 3, into: 'Bag of Holding' });
    expect(listInventory(db, { campaign_id: campaignId }).carried_lb).toBe(loaded);
  });

  it('takes a stowed item out of its container to equip it', () => {
    fighter(); // chain mail, AC 16
    addItem(db, { campaign_id: campaignId, name: 'Backpack' });
    addItem(db, { campaign_id: campaignId, name: '+3 Shield', into: 'Backpack' });
    expect(sheet().ac).toBe(16);

    const equipped = equipItem(db, { campaign_id: campaignId, name: '+3 Shield', equipped: true });
    expect(equipped.taken_from).toBe('Backpack');
    expect(sheet().ac).toBe(21); // 16 + 2 for the shield + its +3
    expect(carried('+3 Shield')).toBeDefined();
    expect(carried('Backpack')!.container!.contents).toEqual([]);
    expect(events().map((e) => e.text).join('\n')).toMatch(
      /takes the \+3 Shield from the Backpack and equips it/,
    );

    // Putting it away leaves it at the top level rather than back in the pack.
    equipItem(db, { campaign_id: campaignId, name: '+3 Shield', equipped: false });
    expect(carried('+3 Shield')!.equipped).toBe(false);
    expect(carried('Backpack')!.container!.contents).toEqual([]);
  });

  it('refuses to lose a full container by accident, and says what went with it', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Sack' });
    addItem(db, { campaign_id: campaignId, name: 'Diamond', weight_lb: 0, into: 'Sack' });

    expect(() => removeItem(db, { campaign_id: campaignId, name: 'Sack' })).toThrow(
      /The Sack holds: 1x Diamond.*pass force true/s,
    );
    const lost = removeItem(db, { campaign_id: campaignId, name: 'Sack', force: true });
    expect(lost.contents_lost).toEqual(['1x Diamond']);
    expect(carried('Diamond')).toBeUndefined();
    expect(events().map((e) => e.text).join('\n')).toMatch(/what was inside it: Diamond/);

    addItem(db, { campaign_id: campaignId, name: 'Sack' });
    addItem(db, { campaign_id: campaignId, name: 'Ruby', weight_lb: 0, into: 'Sack' });
    expect(() => sellItem(db, { campaign_id: campaignId, item: 'Sack' })).toThrow(/The Sack holds: 1x Ruby/);
    const sold = sellItem(db, { campaign_id: campaignId, item: 'Sack', force: true });
    expect(sold.contents_lost).toEqual(['1x Ruby']);
  });
});

// --- 7. identification --------------------------------------------------------

describe('identification', () => {
  it('masks an unidentified item on the player sheet and shows the DM the truth', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true });

    const player = campaignSnapshot(db, campaignId, { forPlayer: true }).pc!;
    const theirs = (player.inventory as InventoryItem[]).find((i) => i.name.startsWith('Unidentified'))!;
    expect(theirs.name).toBe('Unidentified longsword');
    expect(theirs.magic).toBeUndefined();
    expect(theirs.notes).toBeUndefined();

    const dm = items().find((i) => i.true_name === '+1 Longsword')!;
    expect(dm.name).toBe('Unidentified longsword');
    expect(dm.magic).toMatchObject({ bonus: 1, identified: false });
  });

  it('keeps the true name out of every event, and out of the player feed', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true });
    equipItem(db, { campaign_id: campaignId, name: 'Unidentified longsword', equipped: true });
    removeItem(db, { campaign_id: campaignId, name: 'Unidentified longsword' });

    // The bus and the player's window both ship the payload, so neither may carry the truth.
    const written = events().map((e) => `${e.text} ${e.payload_json ?? ''}`).join('\n');
    expect(written).not.toContain('+1 Longsword');
    expect(written).toMatch(/gains 1x Unidentified longsword/);
    expect(written).toMatch(/equips Unidentified longsword/);
    expect(written).toMatch(/loses 1x Unidentified longsword/);

    const feed = campaignSnapshot(db, campaignId, { forPlayer: true }).recent_events;
    expect(feed.map((e) => e.text).join('\n')).not.toContain('+1 Longsword');
  });

  it('keeps the true name out of the rest event when an unidentified item is attuned', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Cloak of Elvenkind', unidentified: true });
    const rested = rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Cloak of Elvenkind'] });
    expect(rested.attuned).toEqual(['Unidentified cloak']);

    const written = events().map((e) => `${e.text} ${e.payload_json ?? ''}`).join('\n');
    expect(written).toMatch(/attuned to Unidentified cloak/);
    expect(written).not.toContain('Cloak of Elvenkind');
  });

  it('keeps the true name out of a DM ruling on an unidentified item', () => {
    fighter(); // Borg, a Dwarf Fighter: the Holy Avenger is not his to attune to
    addItem(db, { campaign_id: campaignId, name: 'Holy Avenger', unidentified: true });
    const ruled = rest(db, {
      campaign_id: campaignId,
      kind: 'short',
      attune: ['Unidentified weapon'],
      attune_ruling: 'the blade lit up in his hand',
    });
    expect(ruled.attuned).toEqual(['Unidentified weapon']);
    expect(ruled.rulings!.join(' ')).toMatch(/Unidentified weapon is attuned by a Paladin/);

    const written = events().map((e) => `${e.text} ${e.payload_json ?? ''}`).join('\n');
    expect(written).toMatch(/by DM ruling, Unidentified weapon is attuned/);
    expect(written).not.toContain('Holy Avenger');
    const feed = campaignSnapshot(db, campaignId, { forPlayer: true }).recent_events;
    expect(feed.map((e) => e.text).join('\n')).not.toContain('Holy Avenger');
  });

  it('unmasks on a short rest studying it, and on the Identify spell', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true });
    // The masked name works as a handle as well as the true one.
    expect(rest(db, { campaign_id: campaignId, kind: 'short', identify: ['Unidentified longsword'] }).identified).toEqual([
      '+1 Longsword',
    ]);
    expect(carried('+1 Longsword')!.magic!.identified).toBe(true);

    wizard();
    addItem(db, { campaign_id: campaignId, name: 'Cloak of Elvenkind', unidentified: true });
    expect(() => useSpellSlot(db, { campaign_id: campaignId, level: 1, spell: 'Sleep', target_item: 'x' })).toThrow(
      /belongs to the Identify spell/,
    );
    const cast = useSpellSlot(db, {
      campaign_id: campaignId,
      level: 1,
      spell: 'Identify',
      target_item: 'Unidentified cloak',
    });
    expect(cast.identified).toBe('Cloak of Elvenkind');
    expect(items().find((i) => i.name === 'Cloak of Elvenkind')!.magic!.identified).toBe(true);
  });
});

// --- 8. coins -----------------------------------------------------------------

describe('coins', () => {
  const purse = () => listInventory(db, { campaign_id: campaignId }).coins;

  it('seeds the purse from the gold a sheet already had and keeps gold as the gp total', () => {
    fighter();
    expect(purse()).toEqual({ cp: 0, sp: 0, ep: 0, gp: 18, pp: 0 });
    expect(sheet().gold).toBe(18);

    const paid = adjustGold(db, { campaign_id: campaignId, coins: { sp: -5, cp: 3 }, reason: 'a bowl of stew' });
    expect(paid.coins).toEqual({ cp: 3, sp: 5, ep: 0, gp: 17, pp: 0 }); // a gold piece broken into silver
    expect(paid.gold).toBe(17); // 17 gp 5 sp 3 cp, floored to gp
    expect(sheet().coins).toEqual(paid.coins);
  });

  it('lets a hand-set gold total re-mint the purse behind it', () => {
    fighter();
    adjustGold(db, { campaign_id: campaignId, coins: { gp: -18, pp: 2 }, reason: 'changing money' });
    setOverrides(db, sheet().id, { gold: 5 });
    expect(purse()).toEqual({ cp: 0, sp: 0, ep: 0, gp: 5, pp: 0 });
    expect(sheet().gold).toBe(5);
  });

  it('makes change out of bigger and smaller coins, and only refuses when the purse is short', () => {
    expect(settleCoins({ cp: 0, sp: 0, ep: 0, gp: -1, pp: 1 })).toEqual({ cp: 0, sp: 0, ep: 0, gp: 9, pp: 0 });
    // Paying a gold piece out of nothing but copper pools the copper and hands back the change.
    expect(settleCoins({ cp: 150, sp: 0, ep: 0, gp: -1, pp: 0 })).toEqual({ cp: 0, sp: 5, ep: 0, gp: 0, pp: 0 });
    expect(settleCoins({ cp: 50, sp: 0, ep: 0, gp: -1, pp: 0 })).toBeNull();

    fighter();
    adjustGold(db, { campaign_id: campaignId, coins: { gp: -18, pp: 2 }, reason: 'changing money' });
    expect(purse()).toEqual({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 2 });

    const broken = adjustGold(db, { campaign_id: campaignId, delta: -3, reason: 'a room for the night' });
    expect(broken.coins).toEqual({ cp: 0, sp: 0, ep: 0, gp: 7, pp: 1 });
    expect(broken.gold).toBe(17);

    expect(() => adjustGold(db, { campaign_id: campaignId, delta: -50, reason: 'a horse' })).toThrow(
      /has 17 gp and cannot pay 50 gp \(purse: 1 pp, 7 gp\)/,
    );
    expect(() => adjustGold(db, { campaign_id: campaignId, reason: 'nothing at all' })).toThrow(/needs delta.*or coins/);
    // Both at once used to drop delta on the floor without a word.
    expect(() =>
      adjustGold(db, { campaign_id: campaignId, delta: -1, coins: { sp: -5 }, reason: 'two ways at once' }),
    ).toThrow(/pass either delta or coins/);
    expect(coinsCp(purse() as Coins)).toBe(1700);
  });
});

// --- 9. selling ---------------------------------------------------------------

describe('selling', () => {
  it('pays half the SRD price, names the rule and refuses what is still in use', () => {
    fighter();
    expect(() => sellItem(db, { campaign_id: campaignId, item: 'Chain Mail' })).toThrow(/still equipped/);

    const sold = sellItem(db, { campaign_id: campaignId, item: 'Spear' });
    expect(sold).toMatchObject({
      sold: 1,
      price_gp: 2.5,
      rule: 'half the SRD price of 5 gp (2024 rule of thumb for selling)',
    });
    expect(sold.coins).toEqual({ cp: 0, sp: 5, ep: 0, gp: 20, pp: 0 });
    expect(carried('Spear')).toBeUndefined();

    const javelins = sellItem(db, { campaign_id: campaignId, item: 'Javelin', qty: 4, price_gp: 2 });
    expect(javelins).toMatchObject({ sold: 4, price_gp: 8, remaining: 4, rule: 'the price you named' });
    expect(javelins.gold).toBe(28);
  });

  it('will not price a magic item off the mundane item behind it', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: '+2 Chain Mail' });
    expect(() => sellItem(db, { campaign_id: campaignId, item: '+2 Chain Mail' })).toThrow(
      /a magic item has no SRD price.*Pass price_gp/s,
    );

    const sold = sellItem(db, { campaign_id: campaignId, item: '+2 Chain Mail', price_gp: 1500 });
    expect(sold).toMatchObject({ price_gp: 1500, rule: 'the price you named' });
    expect(carried('+2 Chain Mail')).toBeUndefined();
    // The mundane suit still sells at half its SRD price.
    expect(sellItem(db, { campaign_id: campaignId, item: 'Chain Mail', force: true }).price_gp).toBe(37.5);
  });

  it('needs a price for a magic item the SRD does not sell, and refuses an attuned one', () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Cloak of Elvenkind' });
    expect(() => sellItem(db, { campaign_id: campaignId, item: 'Cloak of Elvenkind' })).toThrow(
      /puts no price on Cloak of Elvenkind.*Pass price_gp/s,
    );

    rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Cloak of Elvenkind'] });
    expect(() => sellItem(db, { campaign_id: campaignId, item: 'Cloak of Elvenkind', price_gp: 400 })).toThrow(
      /still attuned/,
    );
    const forced = sellItem(db, { campaign_id: campaignId, item: 'Cloak of Elvenkind', price_gp: 400, force: true });
    expect(forced).toMatchObject({ price_gp: 400, gold: 418 });
    expect(forced.coins).toEqual({ cp: 0, sp: 0, ep: 0, gp: 18, pp: 40 }); // paid in platinum, purse untouched
  });
});

// --- 10. guide ----------------------------------------------------------------

describe('the items guide', () => {
  it('is bundled and covers what the engine does not own', () => {
    const guide = readGuide('items');
    expect(guide.found).toBe(true);
    expect(guide.text).toMatch(/Rules the engine does not own/);
    expect(guide.text).toMatch(/Cursed items/);
  });
});


// --- 5b. clause counters keyed off a charged item -------------------------------

describe('item clause counters', () => {
  it('tags a clause counter with the item recharge mark and gives it back when the clock passes it', () => {
    fighter();
    const clause = clauseSchema.parse({
      when: 'rest_long',
      do: [{ kind: 'extra_damage', dice: '1d6' }],
      uses: { charges: { max: 1, recharge: 'dawn' } },
    });
    const items = [
      {
        name: 'Cloak of Sparks',
        qty: 1,
        equipped: true,
        magic: { rarity: 'rare', attunement: true, attuned: true, identified: true, mechanics: { clauses: [clause] } },
      },
    ];
    const character = fighter();
    db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(JSON.stringify(items), character.character!.id);
    const spent = spendFeatureResource(db, {
      campaign_id: campaignId,
      character_id: character.character!.id,
      resource: 'homebrew:cloak_of_sparks:0',
      label: 'Cloak of Sparks',
      max: clause.uses === 'unlimited' ? 1 : 1,
      per: 'long',
    });
    expect(spent.resource).toBe('homebrew:cloak_of_sparks:0');
    const mech = (): { resource?: string; used?: number; recharge_at?: string } | undefined => {
      const rows = JSON.parse(
        (db.prepare('SELECT features_json FROM character WHERE id = ?').get(character.character!.id) as { features_json: string })
          .features_json,
      ) as Array<{ name: string; mechanics?: { resource?: string; used?: number; recharge_at?: string } }>;
      return rows.find((f) => f.mechanics?.resource === 'homebrew:cloak_of_sparks:0')?.mechanics;
    };
    expect(mech()).toMatchObject({ used: 1, recharge_at: 'dawn' });

    // The clock starts at 08:00: an hour is not a dawn, and a dawn grant rides the clock alone. But
    // spending a plain class resource over the same hour touches nothing (no tag, no refill).
    advanceTime(db, campaignId, { hours: 1 });
    expect(mech()).toMatchObject({ used: 1 });
    advanceTime(db, campaignId, { hours: 24 });
    expect(mech()).toMatchObject({ used: 0 });
  });
});
