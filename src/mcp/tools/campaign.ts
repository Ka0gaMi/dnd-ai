import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
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
import { reply } from './result.js';

const presetIds = (): string => settingPresets().presets.map((p) => `${p.id} (${p.name})`).join(', ');

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

export function registerCampaignTools(server: McpServer, db: Db): void {
  server.registerTool(
    'list_campaigns',
    {
      title: 'List campaigns',
      description:
        'Lists every saved campaign with its id, name, story shape, creation date, a snippet of the latest session recap and the player character if one exists. Use it at the start of a chat when the player has not told you which story to continue, or when they ask what stories exist. Follow it with load_campaign for the campaign the player picks. It never changes anything.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => reply(db, null, { campaigns: listCampaigns(db) }),
  );

  server.registerTool(
    'create_campaign',
    {
      title: 'Create campaign',
      description:
        'Creates a new campaign, opens session 1 and records a system event. Use it after the new-story interview, once the player has settled on a name, a story shape (structured adventure with an ending, or open sandbox) and either a premise or a setting preset. A player who only gives you a name and a setting is fine: pass settings.setting_preset and settings.needs_ai_fill true, then invent the premise yourself and save it with mark_story_filled. Character creation happens afterwards, not here. Returns the new campaign_id, which every other tool needs.',
      inputSchema: {
        name: z.string().min(1).describe('Short title of the story, e.g. "The Ashfall Road".'),
        story_shape: z
          .enum(['structured', 'sandbox'])
          .describe('"structured" = an adventure with a planned ending; "sandbox" = open-ended play.'),
        premise: z.string().optional().describe('One or two sentences on the setting and hook.'),
        settings: z
          .looseObject({
            setting_preset: z.string().nullish().describe(`One of: ${presetIds()}.`),
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
            'Session-zero preferences: setting preset, tone dials, lines, veils, pacing, house rules. Dials that belong to the player (visibility, cheat_mode, luck_bias, roll_mode, player_rolls, roll_timeout_s, show_secrets) are set in the companion window and are ignored here.',
          ),
      },
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
      description:
        'Returns the full resume briefing for a campaign: header and premise, the setting preset with its tone dials, lines and veils, current session number, latest recap, the current and previous scene, the player character sheet summary, open quests with steps, active canon facts, the last events and the campaign glossary terms. Call it once at the start of every chat before you narrate anything, and again if you lose track of the state. When the briefing says the story still needs filling in, the player created it in the companion window from a name and a setting only: invent the premise, opening scene, hooks and first objectives that fit the setting before you narrate, and save them with mark_story_filled, add_canon_fact, update_objectives and save_checkpoint. It also opens a new session if the previous one was ended. The character\'s features are listed by name only and a running fight as its summary: get_character_sheet and get_battle_state carry the full detail. Read it as your memory of the story so far.',
      inputSchema: { campaign_id: z.number().int().describe('Campaign id from list_campaigns or create_campaign.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ campaign_id }) => {
      const briefing = loadCampaign(db, campaign_id);
      return reply(db, campaign_id, dmBriefing(briefing) as unknown as Record<string, unknown>, renderBriefing(briefing));
    },
  );

  server.registerTool(
    'mark_story_filled',
    {
      title: 'Save the premise you invented',
      description:
        'Writes the premise - and the name, when the player left the story unnamed - for a story created in the companion window, and clears the "needs filling in" flag so no later chat invents a different one. Call it once, right after you have worked out the name, the premise, the opening scene, the hooks and the first objectives from the setting preset and the tone dials; record those with add_canon_fact and update_objectives and then call save_checkpoint. Never call it with a premise or a name the player has not seen.',
      inputSchema: {
        campaign_id: z.number().int(),
        premise: z.string().min(1).describe('Two or three sentences: the setting, the hook and what is at stake.'),
        name: z
          .string()
          .min(1)
          .optional()
          .describe('The title you and the player settled on; pass it when the story is still called "Untitled story".'),
      },
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
  if (s.threads.length === 0) out.push('- None. Track what is still unanswered with add_plot_thread.');
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
    `The player left this story to you. Still yours to write: ${owed}. Invent that, plus an opening scene, two hooks and the first objectives that fit the setting and the dials above. Offer them to the player, then save them with mark_story_filled (pass name as well when the title is still yours to give), record the hooks and anything you fixed as fact with add_canon_fact, the objectives with update_objectives, and call save_checkpoint.`,
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

const DIFFICULTY_LINES: Record<string, string> = {
  story:
    'Difficulty: story — encounters are built to be survived; a fight the player deliberately picks keeps its real strength.',
  standard:
    'Difficulty: standard — encounter budgets are normalised for a solo party; a fight the player deliberately picks keeps its real strength.',
  deadly:
    'Difficulty: deadly — encounter budgets run above a solo party; a fight the player deliberately picks keeps its real strength.',
};

const TREASURE_LINES: Record<string, string> = {
  sparse: 'Treasure pacing: sparse — coin and magic are rare enough to be remembered.',
  standard: 'Treasure pacing: standard — treasure arrives at about the rate the rules assume.',
  generous: 'Treasure pacing: generous — hand out coin and magic freely.',
};

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

/** The briefing is read by an LLM, so it is rendered as headed prose rather than JSON. */
export function renderBriefing(b: Briefing): string {
  const lines: string[] = [];
  lines.push(`# ${b.campaign.name} (campaign ${b.campaign.id}, ${b.campaign.story_shape})`);
  if (b.campaign.premise) lines.push(`Premise: ${b.campaign.premise}`);
  // With a preset the Setting block below says all this in words; the raw line is for the legacy chat settings.
  if (b.campaign.settings && !b.campaign.setting_preset) {
    const shown = dmVisibleSettings(b.campaign.settings as Record<string, unknown>);
    if (Object.keys(shown).length) lines.push(`Settings: ${JSON.stringify(shown)}`);
  }
  lines.push(`Session ${b.session.number}, started ${b.session.started_at}.`);
  lines.push(...tableBlock({ ...DEFAULT_SETTINGS, ...((b.campaign.settings as Partial<CampaignSettings>) ?? {}) }));
  if (b.campaign.setting_preset) lines.push(...settingBlock(b.campaign));
  if (b.campaign.needs_ai_fill) lines.push(...unfinishedStory(b.campaign.needs_fill));

  lines.push('', '## Recap');
  lines.push(b.last_recap?.trim() ? b.last_recap : 'No recap yet - this story has not been played.');

  lines.push(...storyArcBlock(b));

  const now = b.now;
  lines.push('', '## Now');
  lines.push(`${now.date_text} - ${now.time_of_day}, ${now.season}, ${now.weather}. Move it with advance_time.`);

  lines.push('', '## Scene');
  if (b.previous_scene?.summary) {
    lines.push(`Previously: ${b.previous_scene.title ?? 'untitled scene'} - ${b.previous_scene.summary}`);
  }
  if (b.current_scene) {
    const c = b.current_scene;
    lines.push(
      `Current: ${c.title ?? 'untitled scene'}${c.location_name ? ` at ${c.location_name}` : ''}${
        c.summary ? ` - ${c.summary}` : ' (in progress)'
      }`,
    );
  } else {
    lines.push('No scene open yet.');
  }

  lines.push('', '## Player character');
  if (b.pc) {
    const pc = b.pc;
    lines.push(
      `${pc.name}, level ${pc.level} ${pc.species ?? '?'} ${pc.class ?? '?'}${pc.subclass ? ` (${pc.subclass})` : ''}, ` +
        `HP ${pc.hp_current ?? '?'}/${pc.hp_max ?? '?'}${pc.temp_hp ? ` +${pc.temp_hp} temp` : ''}, AC ${pc.ac ?? '?'}, ` +
        `speed ${pc.speed ?? '?'}, XP ${pc.xp}, gold ${pc.gold}, status ${pc.status}.`,
    );
    if (pc.abilities) lines.push(`Abilities: ${JSON.stringify(pc.abilities)}`);
    if (pc.conditions) lines.push(`Conditions: ${JSON.stringify(pc.conditions)}`);
  } else {
    lines.push('No player character yet.');
  }
  if (b.character_draft && !b.pc) lines.push(...completeCharacter(b.character_draft));

  lines.push('', '## Party');
  if (b.pc) {
    lines.push(
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
    lines.push(
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
  if (!b.pc && b.companions.length === 0) lines.push('Nobody yet.');

  if (b.encounter) {
    lines.push('', '## Combat in progress');
    lines.push(
      `Encounter ${b.encounter.encounter.id}, round ${b.encounter.round}${
        b.encounter.active ? `, ${b.encounter.active.name} is up` : ''
      }. Call get_battle_state for the grid.`,
    );
    for (const c of b.encounter.combatants) {
      lines.push(`- ${c.name} (${c.team}) ${c.hp_current}/${c.hp_max} HP at ${c.x},${c.y}${c.alive ? '' : ' - down'}`);
    }
  }

  lines.push('', '## Open quests');
  if (b.open_quests.length === 0) lines.push('None.');
  for (const q of b.open_quests) {
    lines.push(`- [${q.kind}] ${q.title} (id ${q.id})${q.summary ? `: ${q.summary}` : ''}`);
    for (const s of q.steps) lines.push(`  - [${s.done ? 'x' : ' '}] ${s.text} (id ${s.id})`);
  }

  lines.push('', '## Canon facts (established, do not contradict)');
  if (b.canon_facts.length === 0) lines.push('None.');
  for (const f of b.canon_facts) lines.push(`- ${f.subject}: ${f.fact}`);

  lines.push('', '## Last events');
  if (b.recent_events.length === 0) lines.push('None.');
  for (const e of b.recent_events) lines.push(`- [${e.kind}] ${e.text}`);

  lines.push('', '## Heard (rumours the player already has)');
  if (b.rumours.length === 0) lines.push('None. Hand some out with add_rumour and get_rumours.');
  for (const r of b.rumours) lines.push(`- [${r.scope}] ${r.text} (${r.truth}, id ${r.id})`);

  lines.push('', `## Journal (the player's own words, last ${b.journal.length})`);
  if (b.journal.length === 0) lines.push('Nothing written yet.');
  for (const j of b.journal) lines.push(`- ${j.text}`);

  if (b.codex_briefing) lines.push('', b.codex_briefing);
  if (b.progression_briefing) lines.push('', b.progression_briefing);

  lines.push('', '## Campaign glossary terms');
  lines.push(b.glossary_terms.length ? b.glossary_terms.join(', ') : 'None.');

  lines.push('', `Events since last checkpoint: ${b.events_since_checkpoint}.`);
  return lines.join('\n');
}
