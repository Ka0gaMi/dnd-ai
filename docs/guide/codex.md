# Codex

The codex is the campaign's who's-who: every named NPC, faction, place, item, deity and event, the
ties between them, and the voice cards that keep a recurring character sounding like themselves. It
is not a diary. What happened in a scene belongs in `log_event`; what is durably true about the world
belongs in `remember {op: fact}`; who somebody *is* belongs here.

## When to create an entry

Call `entity {op: upsert}` the first time a name will outlive the sentence it appeared in:

- an NPC the player spoke to, bought from, was threatened by or asked about;
- a faction, guild, cult, noble house or company the story has named;
- a settlement, building or landmark the party can return to;
- an item with a name of its own (the Grey Key, not "a shortsword");
- a deity somebody swears by, or a past event everyone remembers (the Ash Winter).

Do not create entries for scenery, for a guard with two lines who will never return, or for SRD rules
terms - those are glossary entries. One entry per name is plenty; if a tavern and its owner both
matter, that is two entries and a `rules` or `owns` link between them.

Before inventing a name, call `get_codex` with a `query`. Reusing a name already in the codex is
almost always better than adding a second, near-identical one.

## Writing an entry

`entity {op: upsert}` matches on name, case-insensitively, so calling it again with the same name
merges rather than duplicating:

- `summary` - one line, replaced each time. "The innkeeper of Ashfall, in debt to the Ash Court."
- `notes` - what is known, **appended** to whatever is there. Add a line when you learn something,
  don't restate the entry.
- `hidden_notes` - your own truth: what they are really after, what they are hiding, what the twist
  is. Appended as well.
- `status` - `alive`, `dead` or `unknown`. New NPCs start `alive`, everything else `unknown`.
- `kind` - never changes what the entry is *about*, so pick it once and keep sending the same one.

The reply carries the whole entry, whether it was `created`, and any `warnings`.

## The consistency guard

Every write is checked against what is already written - the entry's notes and the active canon facts
about the same subject. It never blocks anything; it answers with `warnings`:

- `near-duplicate of existing notes` - your text shares most of its wording with a note or a fact
  that is already there. The duplicate line is not appended. Either you are repeating yourself (fine,
  move on) or you meant to record something new and should say what actually changed.
- `status alive -> dead contradicts a canon fact: "..."` - you are killing someone canon says is
  alive, or reviving someone canon says is dead. The write happened. Decide which is true: if the
  death stands, record it with `remember {op: fact}` and `supersedes_id` on the old fact.

Treat a warning as a prompt to look, not as an error to work around.

## Voice cards

Call `entity {op: voice}` for anyone the player will talk to twice. Five short fields:

- `speech_pattern` - rhythm and vocabulary, in words rather than spelled-out accents. "Short
  sentences, never uses anybody's name."
- `catchphrase` - a line they actually say.
- `goal` - what they want in this story, concretely enough to act on.
- `fear` - what they will not risk.
- `attitude` - how they treat the party *right now*; update it when that changes.

Fields you send are merged into the card; an empty string clears one. The card comes back in the
briefing whenever that NPC is in the scene, and in full from `entity {op: get}`. Call
`entity {op: get}` before writing dialogue for an NPC the player has met - it costs one call and is
the difference between a character and a stranger wearing their name.

## Relationships

Call `entity {op: link}` as ties are revealed, not when you first imagine them - the codex is what the
story has established. Types:

- family: `parent`, `child`, `spouse`, `sibling`
- standing: `ally`, `enemy`, `rival`, `lover`, `knows`
- belonging: `member_of`, `owns`, `rules`, `serves`

Symmetric ties (`spouse`, `sibling`, `ally`, `enemy`, `rival`, `lover`, `knows`) are stored once and
read from both ends, so link them one way only. For the rest, `from` is the parent, the member, the
owner, the ruler, the servant: `entity {op: link, from: 'Mira', to: 'Ash Court', type: 'member_of'}`
reads "Mira is a member of the Ash Court", and the Ash Court's entry shows Mira as `has_member`.

`notes` on a link carries how it stands - "estranged since the fire". Sending the same link twice
changes nothing.

The companion window draws the family and faction ties around one entry. Before a scene where a
bloodline, a household or a hierarchy matters, `entity {op: get}` returns an entry's links, so walk
them one hop at a time and they come out the same way they did last time.

## Secrets

`hidden_notes` are yours. They are returned to you in full by `entity {op: get}` and
`entity {op: upsert}`, and they never reach the player's companion window unless the player turns the
spoiler toggle on themselves. Anything the player has not learned yet - the real identity, the
betrayal, the price of the bargain - goes there rather than in `notes`, which the player can read at
any time.

When a secret comes out in play, move it: append it to `notes` so the entry reads correctly from then
on, and record the durable part with `remember {op: fact}`.

## Portraits

An NPC entry gets a portrait of its own automatically when portraits are switched on, drawn from its
summary, and reuses one already generated for that name. So write the summary before you expect a
face: "a grey-haired dwarf innkeeper with a burned left hand" gives a better portrait than "the
innkeeper".

## In short

1. A name that will come back -> `entity {op: upsert}`.
2. Someone the player will speak to twice -> `entity {op: voice}`.
3. A tie the story revealed -> `entity {op: link}`.
4. About to write dialogue -> `entity {op: get}` first.
5. A warning in the reply -> look at what is already recorded before writing more.
