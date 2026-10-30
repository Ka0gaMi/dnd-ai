import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { logEvent, pcRow } from '../../core/campaign.js';
import { levelUpOptions, refreshHomebrewHolders } from '../../core/character.js';
import {
  applyHomebrewFeature,
  applyHomebrewSpell,
  applyHomebrewSubclass,
  awaitDecision,
  createDecision,
  type HomebrewDecisionPayload,
} from '../../core/decisions.js';
import {
  classifyClause,
  clausesSchema,
  defaultDecide,
  describeClause,
  type Clause,
} from '../../core/mechanics.js';
import {
  ONE_BOON_PER_CHAPTER,
  PLAY_TAGS,
  addPlayNote,
  boonsThisChapter,
  getHomebrew,
  listLibrary,
  mechanicsSchema,
  powerReport,
  reviseHomebrewClauses,
  saveHomebrew,
  saveToLibrary,
  schemaClauses,
  spellReport,
  spellSchema,
  srdFeatReport,
  subclassReport,
  validateBackground,
  validateRecommendations,
  validateSpell,
  validateSubclass,
  withOptionDetails,
  type HomebrewClauseStatus,
  type HomebrewKind,
  type LevelUpRecommendations,
  type Mechanics,
  type PowerReport,
} from '../../core/progression.js';
import { getSettings } from '../../core/settings.js';
import { findFeat } from '../../srd/lookup.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const MECHANICS = mechanicsSchema.describe('The older flat fields, refused unless empty: the effect goes in clauses.');

const CLAUSES = clausesSchema.describe(
  'What it does, as clauses the engine can run: when (the trigger), if (what narrows it), do (the effects), uses (how often), decide (who chooses). At most four.',
);

// check_mechanics alone publishes the clause grammar and the legacy fields; the other tools admit any objects
// here and parse them with parseHomebrew before anything is written.
const CLAUSE_LIST = z.array(z.looseObject({}));
const CLAUSES_REF =
  'What it does, as clauses (when, if, do, uses, decide), at most four. check_mechanics publishes the grammar: run it first.';
const LEGACY_MECHANICS = z.looseObject({});
const MECHANICS_REF = 'Pass {}: the older flat fields (see check_mechanics) are refused, so the effect goes in clauses.';
const CLAUSE_GRAMMAR_HINT = 'check_mechanics publishes the clause grammar: run it on these clauses, then call again.';

/** Parses homebrew a tool schema admits as any object, refusing with each bad index and field before anything is written. */
export function parseHomebrew<S extends z.ZodType>(schema: S, raw: unknown, where: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const path = issue.path.map((key) => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`)).join('');
    return `${where}${path}: ${issue.message.replace(/\.$/, '')}`;
  });
  throw new Error(`${problems.join('; ')}. ${CLAUSE_GRAMMAR_HINT} Nothing was written.`);
}

/** The per-clause line check_mechanics and revise_mechanics answer with. */
const clauseLines = (clauses: Clause[], prose: string) =>
  clauses.map((clause) => {
    const suggested = defaultDecide(prose, clause);
    return {
      describe: describeClause(clause),
      ...classifyClause(clause),
      decide: clause.decide,
      ...(suggested !== clause.decide ? { suggested_decide: suggested } : {}),
    };
  });

/** The same line the Library carries, so a proposal can say what the engine will actually run. */
const clauseStatus = (clauses: Clause[]): HomebrewClauseStatus[] =>
  clauses.map((clause) => ({ describe: describeClause(clause), ...classifyClause(clause) }));

const LEGACY_REFUSAL = (fields: string[]): string =>
  `Legacy mechanics are no longer accepted: ${fields.join(', ')} must be written as clauses (when, if, do, uses, decide). Read read_guide {section: "homebrew"} and run check_mechanics on the clauses first. Nothing was priced or stored.`;

/** The flat mechanics fields a proposal still carries: everything but the clauses and the budget flag. */
function legacyMechanicsFields(mechanics: Mechanics): string[] {
  return Object.entries(mechanics)
    .filter(([key, value]) => {
      if (key === 'clauses' || key === 'over_budget') return false;
      if (value === undefined || value === null) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
      return true;
    })
    .map(([key]) => key);
}

// Documentation only: loose at every level so nothing is stripped before validateSubclass checks the real shape.
const SUBCLASS_SCHEMA = z
  .looseObject({
    class: z.string(),
    name: z.string(),
    flavour_text: z.string(),
    features: z.record(
      z.string(),
      z.array(
        z.looseObject({
          name: z.string(),
          text: z.string(),
          clauses: CLAUSE_LIST.optional().describe('At most two per level. check_mechanics publishes the grammar.'),
        }),
      ),
    ),
  })
  .describe('The subclass: its class, name, a line of flavour, and features keyed by the level they arrive at ("3", "6", "10", "14" mostly).');

const SPELL_SCHEMA = spellSchema.describe(
  'The spell as data the engine runs: level 0-9, school, casting time, range, components, duration, concentration, ritual, classes, effect, text.',
);

const SUGGESTION = z.object({
  name: z.string(),
  text: z.string().describe('How it reads on the sheet.'),
  mechanics: LEGACY_MECHANICS.describe(MECHANICS_REF),
  clauses: CLAUSE_LIST.optional().describe(CLAUSES_REF),
  justification: z.string().describe('Why this fits how the player has been playing; the window shows it.'),
});

const RECOMMENDATION = z.object({
  name: z.string().describe('The option as spelled in the level-up options.'),
  why: z.string().describe('Why it suits this character, in words a new player understands.'),
});

const RECOMMENDATIONS = z
  .object({
    spells: z.array(RECOMMENDATION).optional(),
    cantrips: z.array(RECOMMENDATION).optional(),
    subclass: RECOMMENDATION.optional(),
    feat: RECOMMENDATION.optional(),
    asi: z
      .object({ abilities: z.array(z.string()).describe('Ability keys such as "dex".'), why: z.string() })
      .optional(),
    hp: z.enum(['average', 'roll']).optional(),
  })
  .describe('What you would pick from the SRD options on offer, and why. Every name must be one of them.');

/** A suggestion worth a whole feat, or one that raises an ability score, is stored as a feat. */
const suggestionKind = (mechanics: Mechanics, report: PowerReport, clauses?: Clause[]): HomebrewKind =>
  (mechanics.asi?.length ?? 0) > 0 ||
  (clauses?.some((clause) => clause.do.some((effect) => effect.kind === 'asi')) ?? false) ||
  report.budget_used >= 1
    ? 'feat'
    : 'feature';

/** Which character a progression call is about, so the level-up window is stored on the right row. */
function characterIdFor(db: Db, campaignId: number, characterId?: number): number {
  if (characterId !== undefined) return characterId;
  const pc = pcRow(db, campaignId);
  if (!pc) throw new Error(`Campaign ${campaignId} has no character yet. Run create_character first.`);
  return pc.id as number;
}

/** The tiers propose_subclass and propose_spell share: flexible asks, freeform applies. */
async function proposeHomebrew(
  db: Db,
  input: {
    campaign_id: number;
    decision_kind: 'homebrew_subclass' | 'homebrew_spell';
    payload: HomebrewDecisionPayload;
    allow_over_budget: boolean;
    apply: () => Record<string, unknown>;
  },
): Promise<ReturnType<typeof reply>> {
  const settings = getSettings(db, input.campaign_id);
  const report = input.payload.report;
  const overBudget = report.verdict === 'over_budget' || input.allow_over_budget;

  // Flexible is the only mode that asks; "make it OP" is the player's own call and needs no dialog.
  if (settings.rules_mode === 'flexible' && !input.allow_over_budget) {
    const decision = createDecision(db, {
      campaign_id: input.campaign_id,
      kind: input.decision_kind,
      payload: input.payload,
    });
    const answer = await awaitDecision(db, decision.id, settings.roll_timeout_s * 1000);
    if (!answer) {
      return reply(db, input.campaign_id, {
        status: 'awaiting_player',
        decision_id: decision.id,
        report,
        message:
          'The player has not answered yet. Carry on with the scene; their answer applies itself and arrives as an event and in the next briefing.',
      });
    }
    return reply(db, input.campaign_id, {
      status: answer.applied ? 'applied' : 'rejected',
      decision_id: decision.id,
      report,
      decision: answer,
    });
  }

  return reply(db, input.campaign_id, {
    status: 'applied',
    rules_mode: settings.rules_mode,
    report,
    ...input.apply(),
    ...(overBudget
      ? { warning: `"${input.payload.name}" is above the power budget; it is stored with an over-budget marker.` }
      : {}),
  });
}

/** The schema field admits any object so the validator's own message reaches the DM instead of a bare union failure. */
function checkedSchema<T>(op: 'subclass' | 'spell', raw: unknown, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const keys = raw && typeof raw === 'object' ? Object.keys(raw as Record<string, unknown>) : [];
    const other = op === 'spell' && keys.includes('features') ? 'subclass' : op === 'subclass' && keys.includes('school') ? 'spell' : null;
    const hint = other ? ` That looks like a ${other}: call propose {op: ${other}}.` : '';
    const grammar = error.issues.some((issue) => issue.path.includes('clauses')) ? ` ${CLAUSE_GRAMMAR_HINT}` : '';
    throw new Error(`The schema does not fit op=${op}: ${z.prettifyError(error)}${hint}${grammar}`);
  }
}

export function registerProgressionTools(server: McpServer, db: Db): void {
  server.registerTool(
    'note_play',
    {
      title: 'Note how the player played',
      description:
        'Records one line, with tags, on how the player solved something characteristic - rigging a trap, talking past a guard - one or two a session, in their words where you can; it is logged as play_note. The notes build the play profile the briefing carries, which your level-up suggestions should follow.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        character_id: CHARACTER_ID,
        tags: z.array(z.enum(PLAY_TAGS)).min(1),
        text: z.string().describe('What they did, in one sentence.'),
      }),
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, addPlayNote(db, input)),
  );

  registerOpTool(server, 'propose', {
    title: 'Propose homebrew content',
    description:
      "Prices homebrew you invented, then asks the player in their window (flexible rules_mode; unanswered, it returns awaiting_player and the answer arrives later as an event) or applies it with a warning (freeform); a background is never put to the player. Write every effect as clauses (when, if, do, uses, decide) and run check_mechanics first: the older flat mechanics fields are refused, and a clause is priced by how narrow and how often it is. A feature is one feat's worth and one story boon per chapter: a second that chapter goes to the player even with allow_over_budget (flexible) or carries a warning (freeform). A subclass carries clauses at every level, at most two each, and joins the level-up window's subclass list rather than the sheet. A spell is data use_action runs by name. A background is then usable in create_character. Set allow_over_budget only when the player asked for something deliberately overpowered. character_id picks whose sheet a feature or spell goes on; a spell without it is only stored. Keep accepted entries with library {op: save}.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      character_id: CHARACTER_ID,
      name: z.string().optional().describe('(op=feature, op=background) Its name.'),
      text: z
        .string()
        .optional()
        .describe('(op=feature, op=background) How it reads on the sheet; for a background, a sentence or two.'),
      mechanics: LEGACY_MECHANICS.optional().describe(`(op=feature) ${MECHANICS_REF}`),
      clauses: CLAUSE_LIST.optional().describe(`(op=feature) ${CLAUSES_REF}`),
      justification: z
        .string()
        .optional()
        .describe('(op=feature, op=subclass, op=spell) Why it fits the story and how they play; the player sees it.'),
      allow_over_budget: z
        .boolean()
        .optional()
        .describe('(op=feature, op=subclass, op=spell) The player asked for it knowing it is too strong; never on your own.'),
      schema: z
        .union([SUBCLASS_SCHEMA, SPELL_SCHEMA, z.record(z.string(), z.unknown())])
        .optional()
        .describe('(op=subclass, op=spell) The subclass or the spell itself, in one of the shapes described here.'),
      recreated_from: z
        .string()
        .optional()
        .describe('(op=subclass) The official subclass this one recreates, e.g. "Oath of Vengeance"; a label, not its text.'),
      abilities: z
        .array(z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']))
        .length(3)
        .optional()
        .describe('(op=background) The three ability scores it raises, e.g. ["dex", "int", "wis"].'),
      origin_feat: z
        .union([
          z.string().describe('An SRD feat by name, e.g. "Alert".'),
          z.object({
            name: z.string(),
            text: z.string(),
            mechanics: LEGACY_MECHANICS.describe(MECHANICS_REF),
            clauses: CLAUSE_LIST.optional().describe(CLAUSES_REF),
          }),
        ])
        .optional()
        .describe('(op=background) The origin feat: an SRD feat by name, or one you invent with clauses.'),
      skills: z.array(z.string()).length(2).optional().describe('(op=background) The two skill proficiencies it grants.'),
      tool: z.string().optional().describe('(op=background) The tool proficiency it grants.'),
      equipment: z
        .object({
          items: z.array(z.object({ name: z.string(), qty: z.number().int().min(1).default(1) })).default([]),
          gold: z.number().int().min(0).default(0),
        })
        .optional()
        .describe('(op=background) The starting equipment: items and gold.'),
    },
    ops: {
      feature: {
        summary: 'Price a homebrew feature against the power budget',
        requires: ['name', 'text', 'mechanics', 'justification'],
        uses: ['character_id', 'clauses', 'allow_over_budget'],
        run: async (args) => {
      const { op, ...input } = args;
      const settings = getSettings(db, input.campaign_id);
      const given = parseHomebrew(mechanicsSchema, input.mechanics, 'mechanics');
      const clauses = input.clauses === undefined ? undefined : parseHomebrew(clausesSchema, input.clauses, 'clauses');
      const legacy = legacyMechanicsFields(given);
      if (legacy.length) throw new Error(LEGACY_REFUSAL(legacy));
      const mechanics: Mechanics = input.allow_over_budget ? { ...given, over_budget: true } : given;
      const report: PowerReport = powerReport({ ...mechanics, clauses });
      // What the entry will run on once it is stored: the clauses it carries.
      const proposed = clauses ?? [];
      const payload: HomebrewDecisionPayload = {
        name: input.name!,
        text: input.text!,
        mechanics,
        ...(clauses ? { clauses } : {}),
        ...(proposed.length ? { clause_status: clauseStatus(proposed) } : {}),
        justification: input.justification!,
        report,
        character_id: input.character_id ?? null,
      };
      const overBudget = report.verdict === 'over_budget' || input.allow_over_budget === true;
      // 2024 boons are a chapter's worth of reward: a second one in the same chapter is held to rules_mode.
      const secondBoon = boonsThisChapter(db, input.campaign_id) > 0;

      // Flexible is the only mode that asks; "make it OP" is the player's own call and needs no dialog.
      if (settings.rules_mode === 'flexible' && (!input.allow_over_budget || secondBoon)) {
        const decision = createDecision(db, { campaign_id: input.campaign_id, kind: 'homebrew_feature', payload });
        const answer = await awaitDecision(db, decision.id, settings.roll_timeout_s * 1000);
        if (!answer) {
          return reply(db, input.campaign_id, {
            status: 'awaiting_player',
            decision_id: decision.id,
            report,
            message:
              'The player has not answered yet. Carry on with the scene; their answer applies itself and arrives as an event and in the next briefing.',
          });
        }
        return reply(db, input.campaign_id, {
          status: answer.applied ? 'applied' : 'rejected',
          decision_id: decision.id,
          report,
          decision: answer,
        });
      }

      const applied = applyHomebrewFeature(db, input.campaign_id, payload);
      return reply(db, input.campaign_id, {
        status: 'applied',
        rules_mode: settings.rules_mode,
        report,
        ...applied,
        ...(overBudget
          ? { warning: `"${input.name}" is above the power budget; it is on the sheet with an over-budget marker.` }
          : {}),
        ...(secondBoon ? { cadence_warning: ONE_BOON_PER_CHAPTER } : {}),
      });
        },
      },
      subclass: {
        summary: 'Price a custom subclass against the SRD one',
        requires: ['schema', 'justification'],
        uses: ['character_id', 'recreated_from', 'allow_over_budget'],
        run: async (args) => {
          const { op, ...input } = args;
          const schema = checkedSchema('subclass', input.schema, () => validateSubclass(input.schema));
          for (const level of Object.keys(schema.features).sort((a, b) => Number(a) - Number(b))) {
            for (const feature of schema.features[level] ?? []) {
              const legacy = legacyMechanicsFields((feature.mechanics ?? {}) as Mechanics);
              if (legacy.length) throw new Error(`Level ${level} "${feature.name}": ${LEGACY_REFUSAL(legacy)}`);
            }
          }
          const report = subclassReport(schema);
          // The bundle's clauses in level order, which is the order the Library reads them back in.
          const proposed = schemaClauses(schema as unknown as Record<string, unknown>, 'subclass');
          const payload: HomebrewDecisionPayload = {
            name: schema.name,
            text: schema.flavour_text,
            mechanics: input.allow_over_budget ? { over_budget: true } : {},
            ...(proposed.length ? { clause_status: clauseStatus(proposed) } : {}),
            justification: input.justification!,
            report,
            character_id: input.character_id ?? null,
            homebrew_kind: 'subclass',
            schema: schema as unknown as Record<string, unknown>,
            recreated_from: input.recreated_from ?? null,
          };
          return proposeHomebrew(db, {
            campaign_id: input.campaign_id,
            decision_kind: 'homebrew_subclass',
            payload,
            allow_over_budget: input.allow_over_budget === true,
            apply: () => ({
              ...applyHomebrewSubclass(db, input.campaign_id, payload),
              recreated_from: input.recreated_from ?? null,
              hint: `"${schema.name}" is now on the subclass list for ${schema.class}; the player picks it in the level-up window.`,
            }),
          });
        },
      },
      spell: {
        summary: 'Price a custom spell against SRD spells of its level',
        requires: ['schema', 'justification'],
        uses: ['character_id', 'allow_over_budget'],
        run: async (args) => {
          const { op, ...input } = args;
          const schema = checkedSchema('spell', input.schema, () => validateSpell(input.schema));
          const report = spellReport(schema);
          const payload: HomebrewDecisionPayload = {
            name: schema.name,
            text: schema.text,
            mechanics: input.allow_over_budget ? { over_budget: true } : {},
            justification: input.justification!,
            report,
            character_id: input.character_id ?? null,
            homebrew_kind: 'spell',
            schema: schema as unknown as Record<string, unknown>,
          };
          return proposeHomebrew(db, {
            campaign_id: input.campaign_id,
            decision_kind: 'homebrew_spell',
            payload,
            allow_over_budget: input.allow_over_budget === true,
            apply: () => ({
              ...applyHomebrewSpell(db, input.campaign_id, payload),
              hint: `Cast it in a fight with use_action{action_name: "${schema.name}"}; the engine reads its numbers from here.`,
            }),
          });
        },
      },
      background: {
        summary: 'Write a custom 2024 background with an origin feat',
        requires: ['name', 'abilities', 'origin_feat', 'skills', 'tool', 'equipment', 'text'],
        uses: [],
        run: (args) => {
          const { op, ...input } = args;
          if (typeof input.origin_feat === 'object') {
            parseHomebrew(mechanicsSchema, input.origin_feat.mechanics, 'origin_feat.mechanics');
            if (input.origin_feat.clauses !== undefined) {
              parseHomebrew(clausesSchema, input.origin_feat.clauses, 'origin_feat.clauses');
            }
          }
          const schema = validateBackground(input);
          if (typeof schema.origin_feat !== 'string') {
            const legacy = legacyMechanicsFields(schema.origin_feat.mechanics as Mechanics);
            if (legacy.length) throw new Error(LEGACY_REFUSAL(legacy));
          }
          const report =
            typeof schema.origin_feat === 'string'
              ? srdFeatReport(findFeat(schema.origin_feat).name)
              : powerReport({ ...(schema.origin_feat.mechanics as Mechanics), clauses: schema.origin_feat.clauses });
          const clauses = typeof schema.origin_feat === 'string' ? [] : (schema.origin_feat.clauses ?? []);
          const entry = saveHomebrew(db, {
            campaign_id: input.campaign_id,
            kind: 'background',
            name: schema.name,
            schema: schema as unknown as Record<string, unknown>,
            report,
          });
          return reply(db, input.campaign_id, {
            status: 'created',
            homebrew_id: entry.id,
            background: entry,
            report,
            ...(clauses.length ? { clause_status: clauseStatus(clauses) } : {}),
            hint: `Pass background: "${schema.name}" to create_character to use it.`,
          });
        },
      },
    },
    annotations: { ...WRITES },
  });

  server.registerTool(
    'check_mechanics',
    {
      title: 'Check a mechanic before you propose it',
      description:
        'Prices a mechanic and says, clause by clause, whether the engine runs it, has it planned or only reminds you of it - and changes nothing, so rewrite until the report says what you meant. Call it before every propose {op: feature} or {op: subclass} and before revise_mechanics. Write what you invented as clauses: when it fires, what narrows it, what it does, how often and who decides; read_guide {section: "homebrew"} has the verbs and worked examples. The reply carries the power budget with the three factors behind each price and one plain line per clause. Anything that does not run comes back to you as a reminder at the moment it would have fired. The older flat mechanics fields are refused.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        text: z.string().describe('How the feature reads on the sheet; the wording decides who chooses.'),
        clauses: CLAUSES.optional(),
        mechanics: MECHANICS.optional(),
      }),
      annotations: { ...READS },
    },
    (input) => {
      const mechanics = (input.mechanics ?? {}) as Mechanics;
      const legacy = legacyMechanicsFields(mechanics);
      if (legacy.length) {
        // No report: a refusal is not a price, and a verdict of 'within' would read as one.
        return reply(db, input.campaign_id, {
          refused: LEGACY_REFUSAL(legacy),
          clauses: [],
          hint: 'Nothing was stored. Rewrite the feature as clauses and run check_mechanics again.',
        });
      }
      const clauses = input.clauses as Clause[] | undefined;
      const report = powerReport({ clauses });
      return reply(db, input.campaign_id, {
        report,
        clauses: clauseLines(clauses ?? [], input.text),
        hint: 'Nothing was stored. When the report says what you meant, pass the same clauses to propose {op: feature} or revise_mechanics.',
      });
    },
  );

  server.registerTool(
    'revise_mechanics',
    {
      title: 'Restate what a feature does',
      description:
        "Restates a piece of homebrew as clauses and prices it again: a feature whose text the engine never ran, or prose on a sheet that should be a rule. Run check_mechanics first. It replaces that entry's clauses, prices that entry alone, logs a homebrew_revised event and answers with the new report and what each clause does. A revision is held to the proposal budget: over a feat's worth is refused in a flexible campaign - trim it, or offer the extra as a new boon with propose {op: feature} - and stored with an over-budget marker in freeform.",
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        homebrew_id: z
          .number()
          .int()
          .describe('The feature or feat to restate; library {op: list} and the level-up window carry it.'),
        clauses: CLAUSE_LIST.describe(CLAUSES_REF),
        reason: z.string().describe('Why it is restated, in one line; logged.'),
      }),
      annotations: { ...WRITES },
    },
    (input) => {
      const clauses = parseHomebrew(clausesSchema, input.clauses, 'clauses');
      const entry = getHomebrew(db, input.homebrew_id);
      if (!entry) throw new Error(`No homebrew with id ${input.homebrew_id}.`);
      // A level-up suggestion priced at a feat or more is stored as a feat; it is restated the same way.
      if (entry.kind !== 'feature' && entry.kind !== 'feat') {
        return reply(db, input.campaign_id, {
          status: 'refused',
          message: `revise_mechanics restates a feature or a feat; "${entry.name}" is a ${entry.kind}. A spell is re-proposed with propose {op: spell}, a subclass with propose {op: subclass}.`,
        });
      }
      if (entry.campaign_id !== input.campaign_id && entry.scope !== 'library') {
        return reply(db, input.campaign_id, {
          status: 'refused',
          message: `Homebrew ${entry.id} belongs to another campaign. Only this campaign's own entries and the personal library can be restated here.`,
        });
      }
      const report = powerReport({ clauses });
      const rulesMode = getSettings(db, input.campaign_id).rules_mode;
      if (report.verdict === 'over_budget' && rulesMode !== 'freeform') {
        return reply(db, input.campaign_id, {
          status: 'refused',
          rules_mode: rulesMode,
          report,
          message: `The restated "${entry.name}" is above the power budget, and a revision is not something the player can be asked to accept. Cut it down to what they already have, or offer the extra as a new boon with propose {op: feature}.`,
        });
      }
      const revised = reviseHomebrewClauses(db, input.homebrew_id, clauses, report);
      // The restated clauses may move an armour class or a speed: the sheets that hold it follow.
      refreshHomebrewHolders(db, input.campaign_id, input.homebrew_id);
      logEvent(db, {
        campaign_id: input.campaign_id,
        kind: 'homebrew_revised',
        text: `${entry.name} restated: ${input.reason}`,
        payload: { homebrew_id: entry.id, reason: input.reason, budget_used: report.budget_used },
      });
      return reply(db, input.campaign_id, {
        status: 'revised',
        homebrew: revised,
        report,
        clauses: clauseLines(clauses, String(entry.schema.text ?? entry.name)),
        ...(report.verdict === 'over_budget'
          ? { warning: `"${entry.name}" is above the power budget; it is stored with an over-budget marker.` }
          : {}),
      });
    },
  );

  server.registerTool(
    'propose_level_up_options',
    {
      title: 'Prepare the level-up window',
      description:
        "Puts the SRD options for the next level into the player's level-up window, with your recommendations among them and any suggestion of your own; the player chooses there. Call it once the character can level - xp says so. Recommend first: name the spells, cantrips, subclass, feat, ability scores or hit point method you would take, each with a why tied to how they play (the play profile in the briefing) and to what it does at the table. Names must match the options exactly, or the call is refused with the valid ones. Then you may add one homebrew suggestion for what the rules do not cover, as clauses run through check_mechanics first; it is stored with a homebrew_id, shown as over budget when it is, and dropped if not taken. It logs level_up_ready. Nothing goes on the sheet until the player confirms, or you call level_up with their choices.",
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        character_id: CHARACTER_ID,
        suggestions: z.array(SUGGESTION).default([]),
        recommendations: RECOMMENDATIONS.optional(),
      }),
      annotations: { ...WRITES },
    },
    (input) => {
      const given = input.suggestions.map(({ mechanics, clauses, ...suggestion }, at) => ({
        ...suggestion,
        mechanics: parseHomebrew(mechanicsSchema, mechanics, `suggestions[${at}].mechanics`),
        ...(clauses === undefined ? {} : { clauses: parseHomebrew(clausesSchema, clauses, `suggestions[${at}].clauses`) }),
      }));
      const characterId = characterIdFor(db, input.campaign_id, input.character_id);
      const srd = withOptionDetails(
        levelUpOptions(db, input.campaign_id, input.character_id) as Record<string, unknown>,
        db,
        input.campaign_id,
      );
      const recommendations = input.recommendations
        ? validateRecommendations(srd, input.recommendations as LevelUpRecommendations)
        : null;
      // Every suggestion is checked before any is stored, so a legacy field in a later one still refuses the call.
      for (const suggestion of given) {
        const legacy = legacyMechanicsFields(suggestion.mechanics as Mechanics);
        if (legacy.length) throw new Error(LEGACY_REFUSAL(legacy));
      }
      // One homebrew suggestion per level-up: the first is kept and the rest are named back to the DM.
      const [kept, ...extra] = given;
      const suggestions = (kept ? [kept] : []).map((suggestion) => {
        const mechanics = suggestion.mechanics as Mechanics;
        const clauses = suggestion.clauses as Clause[] | undefined;
        const report = powerReport({ ...mechanics, clauses });
        const entry = saveHomebrew(db, {
          campaign_id: input.campaign_id,
          kind: suggestionKind(mechanics, report, clauses),
          name: suggestion.name,
          schema: { text: suggestion.text, mechanics, justification: suggestion.justification, ...(clauses ? { clauses } : {}) },
          report,
          power_label: report.verdict,
          created_by: 'dm',
        });
        return {
          ...suggestion,
          report,
          homebrew_id: entry.id,
          ...(clauses?.length ? { clause_status: clauseStatus(clauses) } : {}),
        };
      });
      const toLevel = (srd.to_level as number | undefined) ?? null;
      const window = {
        to_level: toLevel,
        prepared_at: new Date().toISOString(),
        srd,
        suggestions,
        recommendations,
      };
      db.prepare('UPDATE character SET pending_level_up_json = ? WHERE id = ?').run(JSON.stringify(window), characterId);
      logEvent(db, {
        campaign_id: input.campaign_id,
        kind: 'level_up_ready',
        text: `Level-up${toLevel === null ? '' : ` to ${toLevel}`} is ready — choose in the window`,
        payload: {
          character_id: characterId,
          to_level: toLevel,
          suggestions: suggestions.map((s) => ({ name: s.name, homebrew_id: s.homebrew_id })),
        },
      });
      return reply(db, input.campaign_id, {
        character_id: characterId,
        level_up: window,
        ...(extra.length
          ? {
              suggestions_refused: extra.map((s) => s.name),
              message: `One homebrew suggestion per level-up: "${kept!.name}" was kept and ${extra
                .map((s) => `"${s.name}"`)
                .join(', ')} ${extra.length === 1 ? 'was' : 'were'} not stored. Offer the rest at a later level.`,
            }
          : {}),
      });
    },
  );

  registerOpTool(server, 'library', {
    title: 'The homebrew library',
    description:
      'The personal library of homebrew kept across campaigns. op=save copies an entry (background, feat, feature, subclass or spell) there when the player wants to keep it for a next character; it keeps its power report and is stamped with balanced_at_level. op=list shows the entries with power labels, balanced_at_level, recreated_from and clause_status (what each clause says and whether the engine runs it); read it when the player says "the thing I made last time" or before level-up options, and offer entries by name. Library subclasses and spells also appear in the level-up window. Listing changes nothing.',
    fields: {
      homebrew_id: z
        .number()
        .int()
        .optional()
        .describe('(op=save) The entry to keep; the level-up window and library {op: list} carry it.'),
      kind: z
        .enum(['background', 'feat', 'feature', 'subclass', 'spell'])
        .optional()
        .describe('(op=list) Only show entries of this kind; leave it out for every kind.'),
    },
    ops: {
      save: {
        summary: 'Keep a piece of homebrew for every campaign',
        requires: ['homebrew_id'],
        uses: [],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, null, { saved: saveToLibrary(db, input.homebrew_id!) });
        },
      },
      list: {
        summary: 'List the homebrew kept across campaigns',
        requires: [],
        uses: ['kind'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, null, { library: listLibrary(db, input.kind) });
        },
      },
    },
    annotations: { ...WRITES },
  });
}
