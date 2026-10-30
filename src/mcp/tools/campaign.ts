import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { backfillEmblems } from '../../core/auto-portraits.js';
import {
  allocateBriefing,
  BACKGROUND,
  MUST_ACT,
  NEAR_PARTY,
  type BriefingSection,
} from '../../core/briefing-allocator.js';
import {
  characterDraftSummary,
  createCampaign,
  getCampaign,
  listCampaigns,
  loadCampaign,
  needsFill,
  snippet,
  type Briefing,
  type NeedsFill,
} from '../../core/campaign.js';
import { findPreset, settingPresets, toneDialWords } from '../../core/presets.js';
import { renderBattle, type BattleState } from '../../combat/state.js';
import {
  DEFAULT_SETTINGS,
  dmVisibleSettings,
  getSettings,
  updateSettings,
  type CampaignSettings,
} from '../../core/settings.js';
import { BRIEFING_ENVELOPE, estimateTokens, RUMOURS } from '../../core/token-budget.js';
import { dueDuties } from '../../core/duties.js';
import { CAMPAIGN_ID } from './fields.js';
import { reply } from './result.js';

const presetIds = (): string => settingPresets().presets.map((p) => p.id).join(', ');

/** The shape a feature row takes here, narrow enough to accept the `unknown` on CharacterSummary. */
const isFeatureList = (value: unknown): value is Array<{ name: string; source: unknown }> =>
  Array.isArray(value) &&
  value.every(
    (f): f is { name: string; source: unknown } => Boolean(f) && typeof f === 'object' && 'name' in f && 'source' in f,
  );

/** The briefing the DM's tool returns: the two heaviest blocks slimmed, everything else as it was. */
type DmBriefing = Omit<Briefing, 'encounter'> & {
  encounter:
    | Pick<BattleState, 'round' | 'turn_index' | 'active' | 'legal_actions'> & { summary: string }
    | null;
};

/**
 * What the DM reads here anyway: features by name and the fight as its grid summary, since the full
 * detail lives in get_character_sheet and get_battle_state. The text body keeps the original briefing.
 */
function dmBriefing(briefing: Briefing): DmBriefing {
  const out: DmBriefing = { ...briefing, encounter: null };
  const fight = briefing.encounter;
  if (fight) {
    out.encounter = {
      round: fight.round,
      turn_index: fight.turn_index,
      active: fight.active,
      legal_actions: fight.legal_actions,
      summary: renderBattle(fight),
    };
  }
  if (out.pc && isFeatureList(out.pc.features)) {
    out.pc = { ...out.pc, features: out.pc.features.map((f) => ({ name: f.name, source: f.source })) };
  }
  return out;
}

const LOAD_CAMPAIGN_DESCRIPTION =
  'Without campaign_id, lists the saved campaigns (id, name, shape, latest recap, character) and changes nothing: use it when the player has not said which story to continue. With campaign_id, returns the resume briefing - premise, setting, session, recap, scenes, character, quests, canon facts, recent events, glossary - and opens a new session if the last one was ended. Call it once at the start of every chat before you narrate, and again if you lose track; read it as your memory of the story. If the briefing says the story still needs filling in, invent the premise, opening scene, hooks and first objectives before you narrate, and save them with mark_story_filled, remember {op: fact}, update_objectives and checkpoint {op: save}. Features are listed by name and a fight as its summary: get_character_sheet and get_battle_state carry the detail.';

/** Room for what createGameServer adds to the reply: the Next line, the mode header and its hints on a mode change. */
const REPLY_NOTE_TOKENS = 120;

/** The briefing lists at most this many due duties of urgency 2 or more. */
const BRIEFING_DUTIES = 8;

/** Where load_campaign's description quotes the tools hash; the hash itself never covers this stamp. */
const HASH_STAMP = ' Always pass tools_hash "';

const staleTools = (yours: string, current: string): string =>
  `STALE TOOLS (your tool list ${yours}, the server ${current}): the dnd-ai tools changed - reconnect the dnd-ai server (start a new chat, or /mcp then Reconnect, or restart the app). Tell the player this before you narrate.`;

/** JSON with object keys sorted, so a hash does not depend on the key order a client parses a schema into. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** A short hash of a tools/list surface (names, descriptions, input schemas), so a host holding stale tools can be told. */
export function toolSurfaceHash(tools: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>): string {
  const surface = [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => [t.name, (t.description ?? '').split(HASH_STAMP)[0], t.inputSchema ?? null]);
  return createHash('sha256').update(canonicalJson(surface)).digest('hex').slice(0, 8);
}

/** load_campaign's description with the tools hash quoted at its end, where a host's cached tool list keeps it. */
export const stampedLoadDescription = (hash: string): string => `${LOAD_CAMPAIGN_DESCRIPTION}${HASH_STAMP}${hash}".`;

/** `toolsHash` reads the served surface's hash, undefined when it could not be computed or nobody computes it. */
export function registerCampaignTools(
  server: McpServer,
  db: Db,
  toolsHash: () => string | undefined = () => undefined,
): void {
  server.registerTool(
    'create_campaign',
    {
      title: 'Create campaign',
      description: `Creates a campaign and opens session 1, after the new-story interview has settled a name, a story shape and a premise or a setting preset. Given only a name and a setting, pass settings.setting_preset and settings.needs_ai_fill true, then invent the premise and save it with mark_story_filled. Characters come afterwards. Returns the campaign_id every other tool needs. setting_preset is one of: ${presetIds()}.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Short title, e.g. "The Ashfall Road".'),
        story_shape: z.enum(['structured', 'sandbox']).describe('"structured" has a planned ending; "sandbox" is open-ended.'),
        premise: z.string().optional().describe('One or two sentences: setting and hook.'),
        settings: z
          .looseObject({
            setting_preset: z.string().nullish().describe('A preset id from the description.'),
            tone_dials: z
              .record(z.string(), z.number().int().min(1).max(3))
              .optional()
              .describe('1-3 per dial: lethality, grimness, humour, horror, romance, moral_greyness.'),
            lines: z.string().optional().describe('Things that never appear in this story.'),
            veils: z.string().optional().describe('Things that happen off-screen only.'),
            needs_ai_fill: z
              .boolean()
              .optional()
              .describe('True when the player gave only a name and a setting and you still owe them a premise.'),
          })
          .optional()
          .describe(
            'Session-zero preferences. Player-owned dials (visibility, cheat_mode, luck_bias, roll_mode, player_rolls, roll_timeout_s, show_secrets) are ignored here.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => {
      // Dials that belong to the player are set in their window only; one passed here is dropped, not stored.
      const created = createCampaign(db, { ...args, settings: args.settings && dmVisibleSettings(args.settings) });
      return reply(db, created.campaign_id, created);
    },
  );

  server.registerTool(
    'load_campaign',
    {
      title: 'Load campaign (resume briefing)',
      description: LOAD_CAMPAIGN_DESCRIPTION,
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID.optional().describe('Leave out to list the saved campaigns; pass an id to load one.'),
        tools_hash: z.string().optional().describe('The hash quoted at the end of this description, so the server can tell a stale tool list.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ campaign_id, tools_hash }) => {
      const current = toolsHash();
      // A host that cached an older tools/list quotes the hash stamped into that older description.
      const stale =
        current !== undefined && tools_hash !== undefined && tools_hash !== current ? staleTools(tools_hash, current) : '';
      const warning = stale ? { tools_warning: stale } : {};
      if (campaign_id === undefined) return reply(db, null, { campaigns: listCampaigns(db), ...warning });
      const briefing = loadCampaign(db, campaign_id);
      // Faction and deity emblems missing one are queued behind this call, never awaited here.
      backfillEmblems(db, campaign_id);
      const before = stale ? `${stale}\n\n` : '';
      const after = current ? `\nTools hash: ${current}.` : '';
      // The warning, the hash line and what the server appends share the envelope with the briefing.
      const budget = BRIEFING_ENVELOPE - estimateTokens(before + after) - REPLY_NOTE_TOKENS;
      const duties = dueDuties(db, campaign_id).filter((d) => d.urgency >= 2).map((d) => d.text);
      const text = renderBriefing(briefing, getSettings(db, campaign_id), budget, duties);
      return reply(
        db,
        campaign_id,
        { ...dmBriefing(briefing), tools_hash: current, ...warning } as unknown as Record<string, unknown>,
        `${before}${text}${after}`,
      );
    },
  );

  server.registerTool(
    'mark_story_filled',
    {
      title: 'Save the premise you invented',
      description:
        'Saves the premise you invented for a story created in the companion window, and its name when the player left it unnamed, and clears the "needs filling in" flag so no later chat invents another. Call it once, after working out name, premise, opening scene, hooks and first objectives from the preset and dials; then record those with remember {op: fact} and update_objectives and call checkpoint {op: save}. Never pass a premise or name the player has not seen.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        premise: z.string().min(1).describe('Two or three sentences: setting, hook and stakes.'),
        name: z.string().min(1).optional().describe('The title you settled on, while the story is still "Untitled story".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ campaign_id, premise, name }) => {
      getCampaign(db, campaign_id);
      const fill = needsFill(getSettings(db, campaign_id).needs_ai_fill);
      if (name) db.prepare('UPDATE campaign SET name = ? WHERE id = ?').run(name, campaign_id);
      db.prepare('UPDATE campaign SET premise = ? WHERE id = ?').run(premise, campaign_id);
      // A story still waiting for its title keeps that one flag, so the next chat is asked again.
      const left = fill.name && !name ? { name: true } : false;
      updateSettings(db, campaign_id, { needs_ai_fill: left });
      return reply(db, campaign_id, {
        campaign_id,
        name: getCampaign(db, campaign_id).name,
        premise,
        needs_ai_fill: left,
      });
    },
  );
}

/** One party line: the player character or a companion, class or creature, level, HP and what is on them. */
function partyLine(m: {
  id: number;
  name: string;
  what: string | null;
  level: number;
  hp_current: number | null;
  hp_max: number | null;
  conditions: string[];
  inspiration: number;
}): string {
  return (
    `- ${m.name} (id ${m.id}), ${m.what ?? '?'} ${m.level}, HP ${m.hp_current ?? '?'}/${m.hp_max ?? '?'}` +
    `${m.conditions.length ? `, ${m.conditions.join(', ')}` : ''}${m.inspiration ? `, inspiration ${m.inspiration}` : ''}`
  );
}

/** The session-zero setting, rendered for the DM: what the world is like and what to keep out of it. */
function settingBlock(c: Briefing['campaign']): string[] {
  const preset = c.setting_preset ? findPreset(c.setting_preset) : undefined;
  const out = ['', '## Setting'];
  out.push(preset ? `${preset.name}: ${preset.pitch}` : `Setting preset "${c.setting_preset}" (unknown here).`);
  if (preset) {
    out.push(`Tone: ${preset.tone.join(', ')}.`);
    out.push(`Themes: ${preset.themes.join(', ')}.`);
  }
  const dials = Object.entries(c.tone_dials).map(([id, value]) => toneDialWords(id, value));
  if (dials.length) out.push(`Dials: ${dials.join('; ')}.`);
  if (c.lines.trim()) out.push(`Lines - never put these on screen: ${c.lines}`);
  if (c.veils.trim()) out.push(`Veils - keep these off screen: ${c.veils}`);
  return out;
}

/**
 * Where the story stands: act and chapter, what earlier chapters came to, the threads still running
 * and the clues planted. Hidden rows are here because this is the DM's copy - they carry [secret].
 */
function storyArcBlock(b: Briefing): string[] {
  const s = b.story;
  const out = ['', '## Story arc'];
  if (s.outline.ending) out.push(`Planned ending: ${s.outline.ending}`);
  if (s.outline.secret_notes) out.push(`[secret] DM notes: ${s.outline.secret_notes}`);
  if (s.act) out.push(`Act ${s.act.number}: ${s.act.title}${s.act.goal ? ` - ${s.act.goal}` : ''}`);
  out.push(
    s.chapter
      ? `Chapter ${s.chapter.number}: ${s.chapter.title}${s.chapter.goal ? ` - ${s.chapter.goal}` : ''}`
      : 'No chapter open. Call story {op: open_chapter} (or story {op: outline} and {op: act} first) before you play on.',
  );
  if (s.recaps.length) {
    out.push('Earlier chapters:');
    for (const r of s.recaps) out.push(`- ${r.number}. ${r.title}: ${snippet(r.summary ?? '', 200)}`);
  }
  out.push('Open threads:');
  if (s.threads.length === 0) out.push('- None. Track what is still unanswered with thread {op: add}.');
  for (const t of s.threads) {
    out.push(`- ${t.hidden ? '[secret] ' : ''}${t.title} (id ${t.id})${t.summary ? `: ${t.summary}` : ''}`);
  }
  const planted = s.clues.filter((c) => c.status === 'planted');
  if (planted.length) {
    out.push('Clues planted, not yet found:');
    for (const c of planted) out.push(`- ${c.hidden ? '[secret] ' : ''}${c.text} (id ${c.id})`);
  }
  return out;
}

/** Shown until mark_story_filled runs, so a story the player half-made gets finished before play. */
function unfinishedStory(fill: NeedsFill): string[] {
  const owed = [fill.name ? 'a name' : '', fill.premise ? 'a premise (2-3 sentences)' : ''].filter(Boolean).join(' and ');
  return [
    '',
    '## THIS STORY IS NOT FINISHED - FILL IT IN BEFORE YOU NARRATE',
    `The player left this story to you. Still yours to write: ${owed}. Invent that, plus an opening scene, two hooks and the first objectives that fit the setting and the dials above. Offer them to the player, then save them with mark_story_filled (pass name as well when the title is still yours to give), record the hooks and anything you fixed as fact with remember {op: fact}, the objectives with update_objectives, and call checkpoint {op: save}.`,
  ];
}

/** The character the player half-made in the companion window and left for the DM to finish. */
function completeCharacter(draft: NonNullable<Briefing['character_draft']>): string[] {
  return [
    '',
    '## COMPLETE THE CHARACTER BEFORE PLAY',
    `The player started their character and left the rest to you: ${characterDraftSummary(draft)}.`,
    'Fill the gaps with legal options that fit what they chose (ability scores, skills, equipment, languages, spells), write a short backstory and an appearance of two or three sentences, then call create_character with all of it, appearance included. Read the sheet back to them with get_character_sheet. Ask them only about what the draft leaves genuinely open.',
  ];
}

// Nothing sizes encounters yet: the region decides what is out there, and difficulty sets tactics and warnings.
const DIFFICULTY_LINES: Record<string, string> = {
  story:
    'Difficulty: story — the engine does not size encounters; the region decides what is out there. Play foes forgivingly and warn plainly before any fight that could kill.',
  standard:
    'Difficulty: standard — the engine does not size encounters; the region decides what is out there. Foes fight sensibly, and a deadly threat shows its signs before it strikes.',
  deadly:
    'Difficulty: deadly — the engine does not size encounters; the region decides what is out there. Foes fight hard and smart; signs still warn before a deadly fight.',
};

const TREASURE_LINES: Record<string, string> = {
  sparse: 'Treasure pacing: sparse — coin and magic are rare enough to be remembered.',
  standard: 'Treasure pacing: standard — treasure arrives at about the rate the rules assume.',
  generous: 'Treasure pacing: generous — hand out coin and magic freely.',
};

/** The proficient skills, proficient saves and feature names: what the DM needs without opening the sheet. */
function proficiencyLines(pc: NonNullable<Briefing['pc']>): string[] {
  const skills = Object.entries((pc.skills ?? {}) as Record<string, { proficient?: boolean; expertise?: boolean }>)
    .filter(([, s]) => s.proficient)
    .map(([key, s]) => `${key.replace(/_/g, ' ')}${s.expertise ? ' (expertise)' : ''}`);
  const saves = Object.entries((pc.saves ?? {}) as Record<string, { proficient?: boolean }>)
    .filter(([, s]) => s.proficient)
    .map(([key]) => key.toUpperCase());
  const features = isFeatureList(pc.features) ? [...new Set(pc.features.map((f) => f.name))] : [];
  return [
    `Skills: ${skills.join(', ') || 'none'}; Saves: ${saves.join(', ') || 'none'}`,
    ...(features.length ? [`Features: ${features.join(', ')}`] : []),
  ];
}

/** How this table runs, in the three lines the DM has to act on. */
function tableBlock(settings: CampaignSettings): string[] {
  return [
    '',
    '## How this table runs',
    DIFFICULTY_LINES[settings.difficulty] ?? DIFFICULTY_LINES.standard!,
    TREASURE_LINES[settings.treasure_pacing] ?? TREASURE_LINES.standard!,
    settings.rules_coach
      ? 'Rules coach: on — the first time a rule matters this session, explain it in one sentence'
      : 'Rules coach: off — do not explain rules unless asked',
  ];
}

/** A rendered block as an allocator section: its blank line and heading stay, the lines under them may be trimmed. */
const headed = (tier: BriefingSection['tier'], lines: string[], more?: string): BriefingSection => ({
  tier,
  head: lines.slice(0, 2),
  items: lines.slice(2),
  more,
});

/**
 * The briefing is read by an LLM, so it is rendered as headed prose rather than JSON. Pass `settings` from
 * getSettings, so the briefing shows the values the server applies rather than the ones stored.
 */
export function renderBriefing(
  b: Briefing,
  settings: CampaignSettings = { ...DEFAULT_SETTINGS, ...((b.campaign.settings as Partial<CampaignSettings>) ?? {}) },
  budget = BRIEFING_ENVELOPE,
  duties: string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`# ${b.campaign.name} (campaign ${b.campaign.id}, ${b.campaign.story_shape})`);
  if (b.campaign.premise) lines.push(`Premise: ${b.campaign.premise}`);
  // With a preset the Setting block below says all this in words; the raw line is for the legacy chat settings.
  if (b.campaign.settings && !b.campaign.setting_preset) {
    const stored = b.campaign.settings as Record<string, unknown>;
    // The keys that were stored, with the values read back: a retired value shows as what replaced it.
    const shown = dmVisibleSettings(Object.fromEntries(Object.entries(settings).filter(([key]) => key in stored)));
    if (Object.keys(shown).length) lines.push(`Settings: ${JSON.stringify(shown)}`);
  }
  lines.push(`Session ${b.session.number}, started ${b.session.started_at}.`);
  lines.push(...tableBlock(settings));
  if (settings.dc_disclosure === 'shown') lines.push('DC disclosure: shown — the player may be told DCs and AC.');
  const sections: BriefingSection[] = [{ tier: MUST_ACT, head: lines }];
  if (duties.length > 0) {
    const shown = duties.slice(0, BRIEFING_DUTIES).map((d) => `- ${d}`);
    const more = duties.length > BRIEFING_DUTIES ? [`+${duties.length - BRIEFING_DUTIES} more`] : [];
    sections.push({ tier: MUST_ACT, head: ['', '## Duties (owed before you play on)', ...shown, ...more] });
  }
  if (b.campaign.setting_preset) sections.push({ tier: MUST_ACT, head: settingBlock(b.campaign) });
  if (b.campaign.needs_ai_fill) sections.push({ tier: MUST_ACT, head: unfinishedStory(b.campaign.needs_fill) });

  if (b.region_briefing) sections.push(headed(NEAR_PARTY, ['', ...b.region_briefing.split('\n')], 'region {op: get}'));
  if (b.world_briefing) sections.push(headed(BACKGROUND, ['', ...b.world_briefing.split('\n')], 'world {op: get}'));
  sections.push(
    b.last_recap?.trim()
      ? { tier: NEAR_PARTY, head: ['', '## Recap'], items: [b.last_recap] }
      : { tier: NEAR_PARTY, head: ['', '## Recap', 'No recap yet - this story has not been played.'] },
  );

  sections.push(headed(NEAR_PARTY, storyArcBlock(b)));

  const now = b.now;
  sections.push({
    tier: NEAR_PARTY,
    head: ['', '## Now'],
    items: [`${now.date_text} - ${now.time_of_day}, ${now.season}, ${now.weather}. Move it with time {op: advance}.`],
  });

  const scene: string[] = [];
  if (b.previous_scene?.summary) {
    scene.push(`Previously: ${b.previous_scene.title ?? 'untitled scene'} - ${b.previous_scene.summary}`);
  }
  if (b.current_scene) {
    const c = b.current_scene;
    scene.push(
      `Current: ${c.title ?? 'untitled scene'}${c.location_name ? ` at ${c.location_name}` : ''}${
        c.summary ? ` - ${c.summary}` : ' (in progress)'
      }`,
    );
  } else {
    scene.push('No scene open yet.');
  }
  sections.push({ tier: NEAR_PARTY, head: ['', '## Scene'], items: scene });

  if (b.pc) {
    const pc = b.pc;
    const sheet = [
      `${pc.name}, level ${pc.level} ${pc.species ?? '?'} ${pc.class ?? '?'}${pc.subclass ? ` (${pc.subclass})` : ''}, ` +
        `HP ${pc.hp_current ?? '?'}/${pc.hp_max ?? '?'}${pc.temp_hp ? ` +${pc.temp_hp} temp` : ''}, AC ${pc.ac ?? '?'}, ` +
        `speed ${pc.speed ?? '?'}, XP ${pc.xp}, gold ${pc.gold}, status ${pc.status}.`,
    ];
    if (pc.abilities) sheet.push(`Abilities: ${JSON.stringify(pc.abilities)}`);
    sheet.push(...proficiencyLines(pc));
    if (pc.conditions) sheet.push(`Conditions: ${JSON.stringify(pc.conditions)}`);
    sections.push({ tier: NEAR_PARTY, head: ['', '## Player character'], items: sheet, more: 'get_character_sheet' });
  } else {
    sections.push({ tier: NEAR_PARTY, head: ['', '## Player character', 'No player character yet.'] });
  }
  if (b.character_draft && !b.pc) sections.push({ tier: MUST_ACT, head: completeCharacter(b.character_draft) });

  const party: string[] = [];
  if (b.pc) {
    party.push(
      partyLine({
        id: b.pc.id,
        name: b.pc.name,
        what: b.pc.class ?? b.pc.species,
        level: b.pc.level,
        hp_current: b.pc.hp_current,
        hp_max: b.pc.hp_max,
        conditions: (b.pc.conditions as string[] | null) ?? [],
        inspiration: b.pc.inspiration,
      }),
    );
  }
  for (const c of b.companions) {
    party.push(
      partyLine({
        id: c.id,
        name: c.name,
        what: c.class ?? c.creature,
        level: c.level,
        hp_current: c.hp_current,
        hp_max: c.hp_max,
        conditions: c.conditions,
        inspiration: c.inspiration,
      }),
    );
  }
  sections.push(
    party.length > 0
      ? { tier: NEAR_PARTY, head: ['', '## Party'], items: party }
      : { tier: NEAR_PARTY, head: ['', '## Party', 'Nobody yet.'] },
  );

  if (b.encounter) {
    const fight = [
      '',
      '## Combat in progress',
      `Encounter ${b.encounter.encounter.id}, round ${b.encounter.round}${
        b.encounter.active ? `, ${b.encounter.active.name} is up` : ''
      }. Call get_battle_state for the grid.`,
    ];
    for (const c of b.encounter.combatants) {
      fight.push(`- ${c.name} (${c.team}) ${c.hp_current}/${c.hp_max} HP at ${c.x},${c.y}${c.alive ? '' : ' - down'}`);
    }
    sections.push({ tier: MUST_ACT, head: fight });
  }

  const quests = ['', '## Open quests'];
  if (b.open_quests.length === 0) quests.push('None.');
  for (const q of b.open_quests) {
    quests.push(`- [${q.kind}] ${q.title} (id ${q.id})${q.summary ? `: ${q.summary}` : ''}`);
    for (const s of q.steps) quests.push(`  - [${s.done ? 'x' : ' '}] ${s.text} (id ${s.id})`);
  }
  sections.push({ tier: MUST_ACT, head: quests });

  sections.push({
    tier: NEAR_PARTY,
    head: ['', '## Canon facts (established, do not contradict)', ...(b.canon_facts.length === 0 ? ['None.'] : [])],
    items: b.canon_facts.map((f) => `- ${f.subject} (id ${f.id}): ${f.fact}`),
  });

  sections.push({
    tier: NEAR_PARTY,
    head: ['', '## Last events', ...(b.recent_events.length === 0 ? ['None.'] : [])],
    items: b.recent_events.map((e) => `- [${e.kind}] ${e.text}`),
    oldestFirst: true,
  });

  sections.push({
    tier: BACKGROUND,
    head: [
      '',
      '## Heard (rumours the player already has)',
      ...(b.rumours.length === 0 ? ['None. Hand some out with rumour {op: add} and rumour {op: get}.'] : []),
    ],
    items: b.rumours.map((r) => `- [${r.scope}] ${r.text} (${r.truth}, id ${r.id})`),
    more: 'rumour {op: get}',
    oldestFirst: true,
    cap: RUMOURS,
  });

  sections.push({
    tier: BACKGROUND,
    head: [
      '',
      `## Journal (the player's own words, last ${b.journal.length})`,
      ...(b.journal.length === 0 ? ['Nothing written yet.'] : []),
    ],
    items: b.journal.map((j) => `- ${j.text}`),
    more: 'read_journal',
    oldestFirst: true,
  });

  if (b.codex_briefing) {
    // Who is present is near the party; the long "Known <kind>:" lists are background with their own read.
    const [heading, ...codex] = b.codex_briefing.split('\n');
    const known = codex.findIndex((line) => line.startsWith('Known '));
    const at = known === -1 ? codex.length : known;
    sections.push({ tier: NEAR_PARTY, head: ['', heading!], items: codex.slice(0, at), more: 'entity {op: get}' });
    sections.push({ tier: BACKGROUND, head: [], items: codex.slice(at), more: 'get_codex' });
  }
  if (b.progression_briefing) sections.push({ tier: MUST_ACT, head: ['', ...b.progression_briefing.split('\n')] });

  sections.push(
    b.glossary_terms.length > 0
      ? { tier: BACKGROUND, head: ['', '## Campaign glossary terms'], items: b.glossary_terms, inline: ', ' }
      : { tier: BACKGROUND, head: ['', '## Campaign glossary terms', 'None.'] },
  );

  sections.push({ tier: MUST_ACT, head: ['', `Events since last checkpoint: ${b.events_since_checkpoint}.`] });
  return allocateBriefing(sections, budget);
}
