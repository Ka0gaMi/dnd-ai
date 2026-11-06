# Working in this repository

A fully local D&D 5e (SRD 5.2.1 / 2024 rules) client: a Node MCP server owns all state and all dice, a
Svelte companion window shows the table, and an AI DM connects over MCP. Notes for this project live in
the vault configured as the `notes` reference (`.opencode/opencode.json`); read it before re-deriving
something already researched, and record durable findings there rather than in code comments.

## Hard rules

- `src/core/dice.ts` is the only source of randomness **for anything the engine resolves**. The window
  may use `Math.random` for non-outcome picks (a preset chosen by "Surprise me", a fallback key), never
  for a roll, a result or a modifier.
- SRD 5.2.1 is the base for table play; adopted house rules may live in the engine, labelled "house
  rule" in guides and logs. DM homebrew still reaches the engine only through the clause language. This
  binds table rules and SRD content; the living-world and management layer derives its own numbers,
  anchored to SRD gold but not capped by it.
- Plan → validate → spend → apply. A refused call must cost nothing; `underSnapshot` rollback and undo
  stay intact.
- Nothing DM-only (player settings, luck, secret rolls, unidentified items) reaches the player window.
- Secrets never enter the repository. `data/*.sqlite*`, `tunnel/secret.txt`, `logs/`, `.opencode/` and
  `.worktrees/` are gitignored for that reason.
- `main` is pull-request only, even for the owner. Branches are prefixed `kk/`.
- **Agents never commit, push, or edit the Obsidian vault.** The orchestrator commits, merges into one
  integration branch, and opens one pull request per milestone.

## Delegation: one package per concern, parallel only when independent

One agent implements **one package**: one concern, its own test file, one acceptance command, and the
source files that concern needs. Split by concern, never by file count: every agent pays a fixed
read-in (its system prompt, these rules and every file it opens) before it changes a line, so two
agents on one concern cost twice the reading for the same change. A package that needs a file outside
its ownership stops and reports instead of reaching across. Checks, lookups and verifying a package
stay with the orchestrator; an agent is for a package of edits.

Implementers are Claude `implementer` subagents, and every brief passes the model. **Sonnet** when the
brief names every file to change and every behaviour to produce, with no decision left to the agent
(wiring, tests from a given spec, applying a fix list, a change copied from an existing pattern).
**Opus** for judgement: rules interpretation, engine design, unfamiliar or cross-module code,
root-causing a bug. A big feature is usually both — an Opus package for the core, then Sonnet
packages for the follow-ups it makes mechanical. A Sonnet package that fails its gate is re-briefed
on Opus.

Before spawning, list packages with their owned files and test files; **no two agents may share any
file**, including tests. Give every agent its own worktree and branch:

```
git worktree add .worktrees/<slug> -b kk/<slug> main
New-Item -ItemType Junction -Path .worktrees/<slug>/node_modules -Target <repo>/node_modules
New-Item -ItemType Junction -Path .worktrees/<slug>/web/node_modules -Target <repo>/web/node_modules
```

`.worktrees/` is where parallel work belongs (also set as the `worktree.directory` in
`.opencode/opencode.json`); never create folders outside the repository. Delete junctions before
`git worktree remove --force`.

Every brief carries: the owned files, explicit read-only context, the standing invariants, the exact
acceptance commands, the test files to extend, and the report format. Independent packages run
concurrently; anything sharing a file runs in sequence.

## Evidence over narration

Verify a package against the artefact, not its summary: read the diff, run the named gate, and for
behaviour questions inspect the data (a `pending_roll` row, a `combat_log` entry, `logs/server.log`).
A claim that contradicts the data is a finding. Reports must end with what was not done, not
reproduced, or left alone.

## Review

One independent reviewer per integrated milestone diff (per feature only when a feature ships on its
own) — never one per package, never a whole-repository audit — using the Claude `reviewer` subagent
on Opus. Findings are triaged, not applied blindly: some are design decisions for the user. At most
two bounded fix rounds, then the remainder becomes a written follow-up list; re-run the reviewer at
most once, and only after a fix that added new logic.

## Gates

`npm run typecheck`, `npm test`, `npm --prefix web run check`, `npm --prefix web test` — all four must
pass before a pull request, and CI repeats them. Never weaken or delete an existing test to pass; if a
test encodes the old behaviour, update it and say so explicitly.

Keep comments and docstrings to at most two sentences. Long-form history belongs in the vault.
