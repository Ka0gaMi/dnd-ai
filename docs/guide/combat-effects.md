# Combat effects, rolls and endings

The player's own rolls in a fight, the conditions and ongoing effects, how to end an encounter and
how to explain it to a novice.

## Player rolls inside a fight

With player rolls on, `attack` and `use_action` pause while the player clicks their d20, and again
for damage. The timeout applies per die, so one attack can wait twice. Say nothing about the outcome
until the tool returns: describe the swing, not whether it lands.

Companions act on their own initiative through the same tools, and their d20s are the player's to
roll too.

## Conditions and ongoing effects

- `condition {op: set}` for conditions from the rules (prone, grappled, blinded); a creature immune
  to one is refused, and the effects above start at once.
- `effect {op: apply}` for anything the fiction leaves running: burning for 1d6 at the start of its
  turns, poisoned until it saves, blessed for three rounds. Set `tick`, `ends`, and `save_ability`
  with `save_dc` when a save ends it. The engine rolls it every turn and reports what happened.
- `effect {op: end}` stops one early when the fiction says it is over (the fire is smothered).

Concentration, death saves, resistances and temporary hit points are handled inside `attack` and
`use_action`. When a character drops, follow the lines the tool returns; on status `dead`, stop and
present exactly the options in `death_options`.

## Ending it

Call `end_encounter` when the fighting stops - fleeing, surrender and a truce all count. Then:

1. `checkpoint {op: save}` with what the fight cost and changed.
2. `xp {op: award}` - the XP `end_encounter` suggests is a suggestion; awarding it is a separate call.
3. `time {op: advance}` for the minutes the fight and the aftermath took, if it matters.

## Explaining it to a novice

Explain a rule the first time it matters, in a sentence or two: advantage, opportunity attacks,
cover, concentration, death saves. If the player hesitates on their turn, offer two or three concrete
options ("close and swing, throw the lantern, or shout for the guard") rather than a rules lecture.
