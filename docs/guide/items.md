# Items, magic items and money

The server owns every item, every coin and every charge. You narrate what the party finds; the tools
put it on the sheet and work out what it does. Never invent a price, a charge count or an armour
class yourself - call the tool and read its answer back.

## Handing out an item

`add_item{campaign_id, name}`. Use the SRD spelling where one exists and the item arrives with its
category, damage or armour value, properties and weight already written in.

Magic items the engine knows by name:

- Any SRD magic item: `"Bag of Holding"`, `"Wand of Magic Missiles"`, `"Cloak of Elvenkind"`.
- The healing potions by tier: `"Potion of Healing"`, `"Potion of Greater Healing"`,
  `"Potion of Superior Healing"`.
- A +N on any weapon, armour or shield: `"+1 Longsword"`, `"Longsword +1"`, `"+2 Chain Mail"`,
  `"+3 Shield"`. All three spellings resolve to the same SRD entry.

Each of those brings its own rarity, attunement requirement, charges, container size and +N. You do
not have to pass any of it.

**An item you invented must name its rarity.** `add_item{name: "Whispering Blade", magic: {rarity:
"rare", attunement: "by a Rogue", bonus: 1}}`. Without `rarity` the call is refused and the error
lists the six values: `common, uncommon, rare, very_rare, legendary, artifact`. Everything else in
the `magic` block is optional: `attunement` (false, true, or the requirement in words), `bonus`
(+1 to +3), `charges`, and `mechanics` for resistances and the like.

Pass `unidentified: true` for something nobody has worked out yet. The player's own window then sees
only its kind - "Unidentified longsword", "Unidentified potion", "Unidentified cloak" - and none of
its numbers, and so does every event about it: the item's true name never reaches the player's feed,
and its `id` is an opaque handle that gives nothing away. Your `get_character_sheet` and
`list_inventory` still show everything, with `true_name` beside the masked one. Two things reveal it: a short rest spent studying it
(`rest{kind: "short", identify: ["<item>"]}`) or the Identify spell
(`use_spell_slot{level: 1, spell: "Identify", target_item: "<item>"}`).

## Attunement

2024: a creature is attuned to **at most three** items at once, and attuning takes a **short rest**
spent focused on that one item.

- `rest{kind: "short", attune: ["Cloak of Elvenkind"]}` - attunes.
- `rest{kind: "short", unattune: ["Cloak of Elvenkind"]}` - ends one, freeing a slot.
- A fourth is refused, naming the three they already hold.
- A requirement such as "by a Paladin" or "by a Spellcaster" is checked against the character's
  class, species and spellcasting. When any part of the wording is something the engine cannot parse
  - "or a Creature Attuned to a Belt of Dwarvenkind" - it lets the attunement through and says so in
  `notes`; that one is yours to rule on.
- A requirement it does read and the character does not meet is refused. Pass
  `rest{kind: "short", attune: ["Holy Avenger"], attune_ruling: "the sword chose her"}` when the
  story means it to happen anyway: it goes through, and the reply and the event call it a DM ruling.
- An item that needs no attunement cannot be attuned to; it simply works.
- Dying ends every attunement.

Until an item that asks for attunement is attuned, **its bonus does nothing**. `add_item` and
`equip_item` say so in `attunement_note` when they hand over such an item.

## +N gear

A magic weapon's `bonus` is added to its attack roll and its damage once it is equipped (and attuned
if it asks for it). The attack in `list_actions` is named after the magic item and its text says how
much of the bonus came from it. Magic armour and a magic shield add their bonus to AC the same way;
the sheet's `ac_breakdown` names every part of the number, so read that out instead of computing one.

An item may also carry a `mechanics` block - `add_item{magic: {mechanics: {resistances: ["fire"]}}}`
for a Ring of Fire Resistance. While the item is equipped, and attuned when it asks for attunement,
those resistances, vulnerabilities and immunities merge into the combat sheet and the engine halves
the damage itself. Take the item off or end the attunement and the protection goes with it.

## Charges

`use_item{campaign_id, item, charges}` spends charges - `charges` defaults to 1. The reply says what
is left, when they come back and repeats the item's own rules text.

**`use_item` does not cast anything.** A wand's spell is yours to narrate, and if the player is the
one casting it goes through `use_action` in a fight or `use_spell_slot` outside one. `use_item` only
moves the charges.

Recharging happens by itself:

- `dawn` / `dusk` items roll their recharge dice the moment the campaign clock passes 06:00 or 18:00
  - through `advance_time`, or through the hours a rest costs. The roll is logged like any other.
- `long_rest` items come back whole on a long rest; the rest result lists them in `items_recharged`.
- `never` items are spent for good once they are empty.
- `unknown` means the bundled SRD text carries the charges but not the recharge rule, as it does for
  the Wand of Fear and the Staff of Power. Nothing recharges those by itself: rule on it yourself
  with `use_item{item, restore: 3}`, which hands the charges back and logs it as your ruling, or
  settle it for good with `add_item{name, magic: {charges: {current, max, recharge: "dawn"}}}`.

At zero charges `use_item` refuses and names the recharge. Read that out: the item cannot be used
again until then.

## Containers

`add_item{name: "Rope, Hempen", into: "Backpack"}` puts the item inside a container the character
already carries. `remove_item`, `equip_item`, `sell_item` and `use_item` all find items inside
containers, by name or by the item's `id`. `list_inventory` shows contents nested under their
container.

**Equipping something stowed takes it out of the container first** - "Borg takes the +3 Shield from
the Backpack and equips it" - because nothing inside a pack is in hand. Taking it off leaves it at
the top level; put it back with `remove_item` and `add_item{into: ...}` if the story needs it stowed.

The containers are the ones the SRD names: a Backpack, Sack, Pouch, Basket, Chest, Barrel, Bucket,
Case, Flask, Jug, Pot, Vial, Waterskin or Quiver, and the Bag of Holding, Handy Haversack, Portable
Hole and Efficient Quiver. Anything else holds nothing until you say it does:
`add_item{name: "Saddlebag", container: {capacity_lb: 30}}`.

A container's contents count toward carrying capacity like anything else - unless the container
carries them free, as a Bag of Holding does. A container with a stated capacity refuses what would
not fit, naming what it holds and what is already in it.

**A container that still holds something is not removed or sold by accident.** Both refuse and name
the contents; empty it first, or pass `force: true` and the reply and the event say what was lost
with it.

## Coins

The purse is kept by denomination: `{cp, sp, ep, gp, pp}`, at the 2024 rates - 10 cp = 1 sp,
5 sp = 1 ep, 2 ep = 1 gp, 10 gp = 1 pp. Every reply shows both the purse and its total in gold.

`adjust_gold{delta: -15, reason: "..."}` still works and still means gold pieces.
`adjust_gold{coins: {sp: -5}, reason: "..."}` moves exact denominations. Pass one or the other; a
call with both is refused.

**Change is made automatically.** Paying 1 gp out of a purse of silver breaks the silver; paying out
of platinum breaks the platinum. The call is refused only when the whole purse is worth less than the
price, and then it says how much is there - pass `allow_debt: true` only when the story means them to
owe it.

## Selling

`sell_item{campaign_id, item, qty}`. The default price is **half the SRD list price**, the 2024 rule
of thumb, and the reply names the rule it used so you can say it out loud. **Every magic item needs a
`price_gp` from you** - the SRD prices the Chain Mail, never the +2 Chain Mail - and so does anything
you want to haggle to a different number.

It refuses an item still equipped or still attuned - take it off with `equip_item`, end the
attunement on a short rest, or pass `force: true` when the story means them to hand it over anyway.
A gift, a theft or a broken item is `remove_item`, not this.

## Rules the engine does not own

These are yours. The engine will not do them and will not stop you.

- **Casting from a wand or staff.** `use_item` spends the charge; the spell, its save DC, its targets
  and its effect are narrated by you and run through `use_action` or `use_spell_slot`.
- **Cursed items.** Nothing on the sheet is cursed. If you hand out a cursed item, keep the curse in
  a canon fact and enforce it yourself - the engine will happily let the player unattune and sell it.
- **Where an item is.** The engine knows what a character carries, not what is a hundred feet away in
  a locked chest. The "attunement ends after 24 hours more than 100 feet away" rule is yours to apply
  with `rest{kind: "short", unattune: [...]}`.
- **Attunement requirements it cannot read.** When any part of a requirement names something the SRD
  does not know, the attunement is allowed and flagged in `notes`; a requirement it does read and the
  character fails is refused until you pass `attune_ruling`.
- **Item interactions.** A Bag of Holding inside a Portable Hole, a potion mixed with another, an
  item destroyed by fire: narrate it and use `remove_item`.
- **What a shop actually stocks, and what it will pay.** Half price is a default, not a market.
