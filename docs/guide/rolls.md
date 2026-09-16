# Rolling dice

The server owns every die. You never invent, estimate, adjust or re-narrate a number you did not get
back from a tool.

## The roll tool

`roll {expr, purpose, dc, roll_type, advantage, roller, campaign_id}`.

- `expr` carries the whole modifier: `1d20+5`, `4d6kh3`, `2d6+1d4`.
- `dc` is the number you set, or the target's AC for an attack. Pass it and narrate the `outcome`
  word the tool returns; do not decide success yourself.
- `roll_type`: `attack`, `check`, `save`, `damage`, `other`. Only an attack crits - a natural 20 on
  an attack is `critical_hit` and a natural 1 is `miss` whatever the AC, while a natural 20 on a
  check or a save is just a 20 against its DC.
- `advantage`: `advantage` or `disadvantage` on d20 rolls; the server rolls both dice and keeps the
  right one.
- Always pass `campaign_id` when a campaign is loaded, so the roll is logged and appears in the
  player's window.

## Let the server work out the modifier

For a check or a save, do not add the numbers up yourself. Name what is being rolled and the server
reads the sheet:

- `roll {skill: "stealth", dc, roller: "player"}` — a skill check.
- `roll {save: "dex", dc, roller: "player"}` — a saving throw.
- `roll {ability: "str", dc, roller: "player"}` — a raw ability check with no skill behind it.

The server composes `1d20` plus the ability modifier, the proficiency bonus when they are proficient
(doubled by Expertise) and the exhaustion penalty, and returns the breakdown as `modifier` with
`modifier_from_sheet`. `expr` is not needed; a modifier left in it is ignored and named back to you
as `expr_modifier_ignored`. `roll_type` is inferred as `check` or `save`. Pass `character_id` for a
companion. A skill name the rules do not have is refused with the list of the ones they do.

Armour counts here: armour the table marks as loud gives **Disadvantage on Stealth**, applied to the
roll for you and said in `rules_applied`. Armour heavier than its wearer costs 10 ft of speed, which
shows on the sheet with `speed_reason`.

Class features count here too. **Jack of All Trades** adds half a Bard's proficiency bonus to every
check that carries no proficiency, and a Cleric's **Thaumaturge** or a Druid's **Magician** adds their
Wisdom to Arcana, Religion or Nature; the reply names them under `modifier.feature`.

## The dice a feature adds to a failed test

Two features let a character add a die to a d20 test after seeing it fail. A tool call cannot stop
halfway through to ask, so both are **declared before the roll and spent only when they turn it**:

- `roll {bardic_inspiration: true, dc}` — the Bardic Inspiration die the character is holding, handed
  to them by a Bard with `use_action {action_name: "bardic_inspiration", target_id}`. The die lives on
  their own sheet until it is rolled.
- `roll {dark_ones_luck: true, dc}` — a Fiend warlock's Dark One's Own Luck, 1d10 out of their uses.

Pass the `dc`: with one the engine only rolls the die when the test would otherwise fail, and only
spends it when the die carries the test, saying which in `feature_die` and `rules_applied`. Without a
`dc` there is no failure to turn, so the die is added and spent outright. In a fight the same two are
`attack {inspiration: true}` and `use_action {action_name: "dark_ones_own_luck"}`, which puts the d10
on the warlock's next check or save.

## Passive checks

`roll {passive: true, skill: "perception"}` answers **10 + the modifier**, +5 with Advantage and −5
with Disadvantage. No dice are rolled, nothing appears in the player's window and they are told
nothing: it is how you decide what they notice without asking. It is logged for you all the same, as
a `passive_check` event among the campaign events - not in the player's dice ledger.

## Contests

When two creatures push against each other — a shove, a grapple, hiding from a watcher, an arm
wrestle — both sides roll:

```
roll{campaign_id, purpose: "Shoving the door shut", skill: "athletics",
     contest: {opponent: {creature: "Ogre"}}}          // or {character_id} or {bonus: 5}
```

The server rolls both sides, reads the opponent's bonus off their sheet or their stat block (pass
`opponent.skill` or `opponent.ability` when the creature's own is not obvious, or `opponent.bonus`
outright), and returns both totals with `winner`. **A tie means the situation stays exactly as it
was**: nothing moves, nobody is grabbed, whatever was hidden stays hidden. Narrate the deadlock; do
not reroll it.

## Group checks

When the whole party tries the same thing, roll it as one: `roll {group: [id, id], skill, dc}`.
Everyone rolls, and the group succeeds when **at least half** of them do. The reply carries each
member's total, so one botched roll is a moment to narrate rather than a failure for everybody.

## Tools and languages

Two arguments let the server apply rules you would otherwise have to remember.

- `tool: "Thieves' Tools"` on a player's check. Proficiency with the tool adds the proficiency bonus,
  so leave it out of `expr`. When a skill they are proficient in applies to the same check, the 2024
  rule gives **Advantage** instead of a second bonus, and the server rolls it that way. Name the skill
  in `purpose` ("Investigation check") or pass `skill`, so it can tell. The reply says which applied.
- `language: "Elvish"` on anything that turns on understanding or speaking one. A character who does
  not know it gets no roll at all: the call is refused with the list of languages they do know, and
  you narrate the incomprehension. `grant_language` is how they learn one.

Both read the player character by default; pass `character_id` for a companion.

Exhaustion is applied here too: each level takes 2 off every d20 test the player makes, and the reply
says so. Move it with `set_exhaustion {delta}` - never subtract it yourself.

## Who rolls: the roller argument

This is a solo game with one human at the table, and rolling their own dice is most of what they get
to do physically.

- `roller: "player"` for **every** check, save and attack made by the player character or a
  companion. The tool call pauses, a die appears in their companion window, and they click it. If
  they do not click within the timeout they set, the server rolls it for them and play continues.
- `roller: "dm"` (the default) for monster attacks and saves, hidden rolls the player must not see
  (a secret Perception check, a morale roll), and random determinations.
- Damage is normally yours to roll; the player rolls the d20s, which is where the tension is.

If you leave `roller` off a roll that looks like the player's, the reply reminds you once. Take the
hint rather than arguing with it.

While a player roll is pending, **narrate nothing about the outcome**. Wait for the tool to return.
Describe the swing, not the result, and never say "you feel that will hit".

## Cheat mode is invisible to you

The player has dials of their own: a luck bias, and a cheat mode that lets them edit a roll before it
counts. Neither is ever reported to you, and neither appears in any briefing or tool reply. A number
that comes back is simply the number. Do not go looking for it, do not ask about it, and do not
comment on a suspicious run of twenties - from your side there is nothing to see. The same applies
to their visibility and roll-mode settings.

## Heroic Inspiration

`grant_inspiration {character_id}` when the player does something clever, brave or true to who their
character is - and tell them they have it, or it may as well not exist. It does not stack.

They spend it in one of two ways:

- In their window, on a d20 they have already seen: the reply tells you it was spent and what the
  reroll changed. Narrate the second number.
- By saying so: call `spend_inspiration {character_id}`, then `roll` again and use the new result.
  The reroll must be taken - it is not the better of the two.

## Dying and stabilising

`death_save` rolls the saves. Three successes, or a successful DC 10 Medicine check followed by
`stabilize {character_id}`, make the character stable: no more death saves, still unconscious at 0 HP.
A stable character regains 1 HP after 1d4 hours of in-world time, which `advance_time` applies (a rest
moves the clock too). Damage while they are down undoes it and the saves begin again.

## Rests

`rest {kind: "long"}` and `rest {kind: "short"}` apply the rest and move the in-world clock by the
**8 hours** a long rest takes or the **1 hour** a short one does; pass `advance_time: false` when
you have moved it yourself.

- **One long rest per 24 hours.** A second one inside that is refused with the in-world time the
  last one ended. A short rest is always available.
- **Interrupted rests give nothing.** If something breaks it off — an attack, a storm, a watch that
  went wrong — pass `interrupted: true` (or `hours` for what they actually got). Nothing is restored,
  the long rest is still owed, and it is yours to narrate why.
- **Features spent on a rest.** A short rest takes `arcane_recovery`, `natural_recovery`,
  `sorcerous_restoration` and `memorize_spell {replace, with}`; either rest takes
  `fiendish_resilience` with the damage type the warlock resists from here on. The reply says what
  each gave back.

## Boosts: a homebrew clause spent on a roll

A clause written `decide: "ask_before"` - "once per Long Rest you can give yourself Advantage" - is a
**boost**. Every reply that carries a roll lists the ones that fit it in `boosts_available`, each
with an id, what it does and the uses left. The player's own card offers theirs and they choose
before clicking; for a companion or a roll you make yourself, pass the ids back in `boosts` on
`roll`, `attack` or `use_action`. A boost is refused unless it is on offer with a use left, and the
use is spent only once the roll stands - a card left unanswered costs nothing.

## Nothing else rolls

Combat damage, saves against ongoing effects, death saves and hit dice on a rest are rolled inside
their own tools (`attack`, `apply_effect`, `death_save`, `rest`) and reported in the lines they
return. Read those lines out; do not roll them again by hand.

## Rules the engine does not own

These are yours to adjudicate by hand. Say what you are doing, and keep it consistent:

- Concentration carried into a fight. Casting at the table is recorded on the sheet
  (`concentrating_on`), and damage outside a fight rolls the Constitution save by itself, but
  `start_encounter` does not carry it in yet: if it matters, say so and apply it in the fiction.
- Cover, lighting and which of the two applies when they disagree.
- Whether a check is called for at all, and what its DC is. The server never invents a DC.
- Whether Advantage or Disadvantage is deserved before you pass it.
- Help, working together and taking time over a task.
