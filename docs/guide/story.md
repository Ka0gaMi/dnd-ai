# Running the story

Acts, chapters, threads, clues, rumours, time and the player's journal. Everything here is the DM's
job: the player writes nothing but their journal.

## Outline, acts, chapters

Write the outline once, at the start, before the first scene:

1. `set_story_outline {premise, ending, secret_notes}` - the premise in a paragraph, the ending you
   are steering towards, and the truth behind it in `secret_notes`. The secret notes are yours: the
   player only ever sees them if they turn their spoiler toggle on themselves.
2. `add_act {title, goal}` two or three times. An act is a movement of the story ("The Road South",
   "The Siege"), not a scene. Acts are numbered in the order you add them.
3. `open_chapter {title, goal, act_id}` for the first chapter.

A **chapter** is the unit of play between recaps: a few scenes, one town, one job, one journey. Keep
one open at all times - facts, rumours, journal entries and checkpoints are stamped with the chapter
that was open when they were written, which is what lets the companion window filter the story by
chapter.

When a chapter is genuinely over (the job is done, the town is behind you, the act turns), call
`advance_chapter {summary, title, goal}`. It closes the open chapter with that summary and opens the
next one in the same call. The summary is 3-6 sentences and becomes the **chapter recap** carried in
every later briefing, so write what changed and what is still hanging, not a blow-by-blow. Pass
`act_id` when the new chapter begins a new act; the act it belongs to becomes the active one.

Order of operations at the end of a chapter: `save_checkpoint` for the scene, then
`advance_chapter` for the chapter. They are not alternatives - the checkpoint closes the scene, the
chapter close writes the recap.

`open_chapter` refuses while a chapter is open. That is deliberate: closing a chapter without a
recap loses the story.

## Threads and clues

A **plot thread** is one unanswered question: who poisoned the well, what the cult wants, where the
sister went. `add_plot_thread {title, summary, hidden}` the moment you dangle something you mean to
pay off. Open threads appear in every briefing, which is what stops a later chat dropping them.

- `hidden: true` while the player does not know the thread exists (the real reason behind the
  disappearances, say). Hidden threads never reach their window until their spoiler toggle is on.
- `update_plot_thread {id, status, summary, hidden}` when it moves: `resolved` when it is answered
  in play, `dropped` when the story left it behind, `hidden: false` once the player learns of it.
  Resolving or dropping also retires the rumours attached to that thread.

A **clue** is a concrete thing in the world that answers part of a thread: a ledger entry, a scar, a
name a drunk lets slip. `plant_clue {text, thread_id, hidden}` when you place it, whether or not the
player noticed. Plant three clues for anything you actually need them to work out; one is a
bottleneck. When they get hold of one, `find_clue {id}` (or enough of its text to match) - that ties
it to the scene it turned up in and makes it visible to the player.

## Rumours

`add_rumour {text, scope, truth, source_kind, thread_id}` stores something the world is saying.

- `scope`: `location` (this village), `region` (the road, the county), `world` (everyone knows).
- `truth`: `true`, `false` or `twisted`. Record the lies especially - what the player was told is
  what you must stay consistent with, even when it is wrong.

`get_rumours {scope, limit}` hands you unresolved rumours to deliver and marks them heard. Call it
when the party reaches a tavern, a market, a guard post - anywhere talk happens - and then have an
NPC say them in their own voice; do not read the list out. Heard rumours stay in the briefing under
"Heard" so you never contradict them. When the pile runs dry, `roll_table {table: "rumours"}` makes
a fresh one; keep the ones you like with `add_rumour`.

## Time, seasons and weather

`advance_time {minutes|hours|days}` moves the in-world clock and returns the new date, time of day
(night, dawn, morning, midday, afternoon, dusk, evening), season and weather. Call it whenever time
passes on screen: travel, a long wait, a night at an inn, a rest. Nothing else moves the clock, so a
story where you never call it happens on one endless morning.

The calendar is twelve 30-day months with generic names, the season follows the month, and the
weather is rolled from the season and is the same all day - ask once, narrate it consistently.
Deadlines ("the tithe is due on the tenth") only mean something if you advance time honestly.

`set_calendar {year, month, day, hour, minute, month_names, era_name, season_override, hemisphere}`
places the clock at an exact date instead of moving it forward; call it once at the start of a
campaign (the new_story interview asks for a starting date and era) or to jump to a known date.
Any field you leave out keeps its current value. `month_names` renames the twelve months for a
setting with its own calendar, and `era_name` names the year ("1042 of the Third Age") in
`date_text` from then on. `season_override` pins the season regardless of month until you call it
again with `season_override: null`; `hemisphere: "south"` flips which months count as which season,
and `advance_time` keeps respecting both afterwards. It rolls a fresh weather for the new date and
logs that the calendar was set.

## Random tables

`roll_table {table, key, seed}` when you need a detail you have no reason to choose:

| table | key | gives |
| --- | --- | --- |
| `names` | `northern`, `southern`, `eastern`, `old-empire` | a first and family name |
| `rumours` | - | a rumour with its blanks filled |
| `loot` | a CR number or `0-4`, `5-10`, `11-16`, `17+` | coins, a trinket and an item |
| `weather` | a season | the day's weather |
| `encounters` | `forest`, `road`, `cave`, `ruins`, `interior`, `town` | something happening |

Treat the answer as a prompt, not as prose to read out, and pass `seed` when you want the same
answer again. `roll_table` writes nothing: keep what you use with `add_rumour`, `add_canon_fact` or
the loot tools.

## Secrets

`hidden` on threads and clues, and `secret_notes` on the outline, are the DM's. They are in your
briefing (marked `[secret]`) and stripped from the player's window and the API unless the player has
turned `show_secrets` on for themselves. Never quote a `[secret]` line at the player - reveal it in
play, then clear the flag with `update_plot_thread` or `find_clue`.

## The player's journal

The journal is written by the player in their companion window; you cannot write to it. Read it with
`read_journal {limit}` when you load a campaign and whenever they mention having written something
down. It is their account of the story, so it tells you what they believe, what they misremember and
what they care about - all three are good material. The last three entries are in every briefing.
