import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  subclassSchema,
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
import { registerOpTool } from './op.js';
import { reply } from './result.js';

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const CHARACTER_ID = z
  .number()
  .int()
  .optional()
  .describe('Who this is about. Leave it out for the player character; pass a companion id from the briefing.');

const MECHANICS = mechanicsSchema.describe(
  'The numbers behind the feature, so the server can price it. Leave out anything the feature does not do.',
);

const CLAUSES = clausesSchema.describe(
  'What the feature does, as clauses the engine can run: when (the trigger), if (what narrows it), do (the effects), uses (how often) and decide (who chooses). At most four. Run check_mechanics first and read_guide{section: "homebrew"} once.',
);

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

const SUBCLASS_SCHEMA = subclassSchema.describe(
  'The subclass itself: the class it belongs to, its name, a line of flavour, and its features keyed by the level they arrive at ("3", "6", "10", "14" for most classes).',
);

const SPELL_SCHEMA = spellSchema.describe(
  'The spell as data the engine can run: level 0-9, school, casting time, range, components, duration, concentration, ritual, the classes that may cast it, the effect, and how it reads.',
);

const SUGGESTION = z.object({
  name: z.string(),
  text: z.string().describe('How it reads on the sheet.'),
  mechanics: MECHANICS,
  clauses: CLAUSES.optional(),
  justification: z.string().describe('Why this fits how the player has been playing; the window shows it.'),
});

const RECOMMENDATION = z.object({
  name: z.string().describe('The option as it is spelled in the level-up options.'),
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

/** The tiers propose_subclass and propose_spell share: strict refuses, flexible asks, freeform applies. */
async function proposeHomebrew(
  db: Db,
  input: {
    campaign_id: number;
    decision_kind: 'homebrew_subclass' | 'homebrew_spell';
    what: string;
    payload: HomebrewDecisionPayload;
    allow_over_budget: boolean;
    apply: () => Record<string, unknown>;
  },
): Promise<ReturnType<typeof reply>> {
  const settings = getSettings(db, input.campaign_id);
  const report = input.payload.report;
  const overBudget = report.verdict === 'over_budget' || input.allow_over_budget;

  if (settings.rules_mode === 'strict' && overBudget) {
    return reply(db, input.campaign_id, {
      status: 'refused',
      rules_mode: 'strict',
      report,
      message: `"${input.payload.name}" is above the power budget for a ${input.what} and this campaign runs strict. Cut it down, or the player can change rules_mode in their settings.`,
    });
  }

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

export function registerProgressionTools(server: McpServer, db: Db): void {
  server.registerTool(
    'note_play',
    {
      title: 'Note how the player played',
      description:
        'Records one line about how the player solved something, with tags from a fixed list. Call it when they do something characteristic - rigging a trap, talking their way past a guard, setting the room on fire - one or two lines per session, in their own words where you can. Each note is logged as a play_note event. The notes build the play profile that the briefing carries and that your level-up suggestions should be based on, so this is how the game learns to offer them things they will actually enjoy.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        tags: z.array(z.enum(PLAY_TAGS)).min(1),
        text: z.string().describe('What they did, in one sentence.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, addPlayNote(db, input)),
  );

  registerOpTool(server, 'propose', {
    title: 'Propose homebrew content',
    description:
      "Prices homebrew you invented and then, depending on the campaign's rules_mode, refuses it (strict), asks the player through the window (flexible) or applies it with a warning (freeform). op=feature prices a feature against the power budget - one feat's worth - and carries one story boon per chapter: if a homebrew feature has already gone on the sheet since this chapter opened, a second one is refused in strict, put to the player in flexible and applied with a warning in freeform; use it when the player earns something the rules do not cover: a trick they invented, a boon from a patron, a scar that became an ability. op=subclass prices a subclass you wrote for one class against the SRD subclass of that class, bundle by bundle - what it gives at level 3 is measured against what the rulebook subclass gives at level 3, and so on - use it when the player wants an order, a patron or a tradition the rulebook does not have, and know that storing it does not put anything on the sheet: it joins the SRD subclass on the level-up window's subclass list, where the player chooses it, and its later bundles then arrive at the levels they are written for. op=spell prices a spell you wrote against the SRD spells of the same level - a per-level budget taken from what those spells actually roll, single target and area counted apart, healing likewise, and a spell that only changes the fiction priced as a flat small cost; write it as data, not prose: level, school, casting time, range, components, duration, and an effect saying whether it is an attack, a save, automatic, healing or utility, with the damage dice and type, the saving throw ability, the area shape, the healing dice or the condition it leaves, because that data is what the engine executes, so use_action resolves the spell by name in a fight - the save DC comes from the caster sheet and the slot is spent the usual way. op=background writes a 2024-shaped background for this campaign: three ability scores, an origin feat (an SRD feat by name, or one you invent with mechanics), two skill proficiencies, a tool proficiency and starting equipment; use it when the player wants to come from somewhere the SRD list does not have; the origin feat is measured against the power budget, and the background is then usable by name in create_character like any SRD one, and in a strict campaign an over-budget origin feat is refused. Every effect must be written as clauses - when, if, do, uses, decide - never as the older flat mechanics fields, which are refused: clauses are what the engine runs, and a clause is priced by how narrow and how often it is, so a rider on one damage type once a turn costs a quarter of what it costs on every hit, a subclass carries at most two clauses per level and every level must carry clauses, and an invented origin feat is written as clauses the same way. Run check_mechanics before you propose and read read_guide {section: \"homebrew\"} once, because prose alone the budget cannot see and the engine cannot run. The play profile shapes what you propose, so offer what follows how the player actually plays rather than what their class says. In flexible mode the player gets a dialog with the report; if they do not answer within the roll timeout the result says awaiting_player, and their answer arrives later as an event and in the next briefing. Set allow_over_budget only when the player asked for something deliberately overpowered and never on your own: it is applied with an over-budget marker on the sheet. Pass character_id to also put a feature or a spell on that character sheet (a cantrip among their cantrips, anything else among their prepared spells); without it the entry is only stored for the campaign, and a subclass joins the level-up window either way. When the player asked for a subclass the official books have and this is your recreation of it, pass recreated_from with that subclass's name: it is stored and returned as a label only, and nothing of the original is bundled with the app. Save an entry to the personal library with library {op: save} once the player accepts it and says they want to keep it.",
    fields: {
      campaign_id: z.number().int(),
      character_id: z
        .number()
        .int()
        .optional()
        .describe(
          '(op=feature, op=subclass, op=spell) Who this is about. Leave it out for the player character; pass a companion id from the briefing.',
        ),
      name: z
        .string()
        .optional()
        .describe("(op=feature, op=background) feature: the feature's name; background: the background's name."),
      text: z
        .string()
        .optional()
        .describe(
          '(op=feature, op=background) feature: how it reads on the sheet; background: what this background is, in a sentence or two.',
        ),
      mechanics: MECHANICS.optional().describe(
        '(op=feature) The numbers behind the feature, so the server can price it. Leave out anything the feature does not do.',
      ),
      clauses: CLAUSES.optional(),
      justification: z
        .string()
        .optional()
        .describe('(op=feature, op=subclass, op=spell) Why this fits the story and how they play; the player sees it in the dialog.'),
      allow_over_budget: z
        .boolean()
        .optional()
        .describe('(op=feature, op=subclass, op=spell) The player asked for it knowing it is too strong. Never set this on your own.'),
      schema: z
        .union([SUBCLASS_SCHEMA, SPELL_SCHEMA])
        .optional()
        .describe(
          '(op=subclass, op=spell) subclass: the class it belongs to, its name, a line of flavour, and its features keyed by the level they arrive at ("3", "6", "10", "14" for most classes); spell: the spell as data the engine can run: level 0-9, school, casting time, range, components, duration, concentration, ritual, the classes that may cast it, the effect, and how it reads.',
        ),
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
          z.object({ name: z.string(), text: z.string(), mechanics: MECHANICS, clauses: CLAUSES.optional() }),
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
        summary: 'Propose a homebrew feature against the power budget',
        requires: ['name', 'text', 'mechanics', 'justification'],
        uses: ['character_id', 'clauses', 'allow_over_budget'],
        run: async (args) => {
      const { op, ...input } = args;
      const settings = getSettings(db, input.campaign_id);
      const legacy = legacyMechanicsFields(input.mechanics! as Mechanics);
      if (legacy.length) throw new Error(LEGACY_REFUSAL(legacy));
      const mechanics: Mechanics = input.allow_over_budget
        ? { ...(input.mechanics! as Mechanics), over_budget: true }
        : (input.mechanics! as Mechanics);
      const clauses = input.clauses as Clause[] | undefined;
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

      if (settings.rules_mode === 'strict' && (overBudget || secondBoon)) {
        return reply(db, input.campaign_id, {
          status: 'refused',
          rules_mode: 'strict',
          report,
          message: overBudget
            ? `"${input.name}" is above the power budget and this campaign runs strict. Cut it down to a feat's worth, or the player can change rules_mode in their settings.`
            : ONE_BOON_PER_CHAPTER,
        });
      }

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
        summary: 'Propose a custom subclass measured against the SRD one',
        requires: ['schema', 'justification'],
        uses: ['character_id', 'recreated_from', 'allow_over_budget'],
        run: async (args) => {
          const { op, ...input } = args;
          const schema = validateSubclass(input.schema);
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
            what: 'subclass',
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
        summary: 'Propose a custom spell priced against the SRD spells of its level',
        requires: ['schema', 'justification'],
        uses: ['character_id', 'allow_over_budget'],
        run: async (args) => {
          const { op, ...input } = args;
          const schema = validateSpell(input.schema);
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
            what: 'spell',
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
          const schema = validateBackground(input);
          if (typeof schema.origin_feat !== 'string') {
            const legacy = legacyMechanicsFields(schema.origin_feat.mechanics as Mechanics);
            if (legacy.length) throw new Error(LEGACY_REFUSAL(legacy));
          }
          const report =
            typeof schema.origin_feat === 'string'
              ? srdFeatReport(findFeat(schema.origin_feat).name)
              : powerReport({ ...(schema.origin_feat.mechanics as Mechanics), clauses: schema.origin_feat.clauses });
          if (getSettings(db, input.campaign_id).rules_mode === 'strict' && report.verdict === 'over_budget') {
            return reply(db, input.campaign_id, {
              status: 'refused',
              rules_mode: 'strict',
              report,
              message: `The origin feat of "${schema.name}" is above the power budget and this campaign runs strict.`,
            });
          }
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
        'Prices a mechanic and says, clause by clause, whether the engine will run it or only remind you of it - and changes nothing, so you can rewrite it until the report says what you meant. Call it before every propose {op: feature} and propose {op: subclass} call, and before revise_mechanics. Write what you invented as clauses: when it fires, what narrows it, what it does, how often, and who decides; read_guide{section: "homebrew"} has the verbs and the worked examples. The reply carries the power budget with the three factors behind each price (what it does, how narrow it is, how often it fires), one plain English line per clause, and one of three states with the reason: runs (the engine applies it at the hook and logs it), planned (the hook is there but this part of it has no seam yet) or reminds ("light is not modelled until R7"). Anything that does not run comes back to you as a reminder at the moment it would have fired, so nothing is silently dropped. The older flat mechanics fields are refused: a feature must be written as clauses before it is priced.',
      inputSchema: {
        campaign_id: z.number().int(),
        text: z.string().describe('How the feature reads on the sheet; the wording decides who chooses.'),
        clauses: CLAUSES.optional(),
        mechanics: MECHANICS.optional(),
      },
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
        'Restates a piece of homebrew as clauses and prices it again: use it for a feature the character already has whose text the engine never ran - "Forceful Focus", "Goblin-Bane" - and whenever you find prose on the sheet that should be a rule. Run check_mechanics first. It replaces that entry\'s clauses, prices that entry alone (every other report and label stands as it was), logs a homebrew_revised event and answers with the new report and what each clause does. A revision is held to the same budget as a proposal: in a strict campaign one above a feat\'s worth is refused, and so it is in a flexible one - the player agreed to the feature they have, so trim the clauses or offer the extra as a new boon with propose {op: feature}, which is the call that asks them - while a freeform campaign stores it with an over-budget marker.',
      inputSchema: {
        campaign_id: z.number().int(),
        homebrew_id: z
          .number()
          .int()
          .describe('The entry to restate; library {op: list} and the level-up window carry it. A feature or a feat.'),
        clauses: CLAUSES,
        reason: z.string().describe('Why it is being restated, in one line; it goes into the event.'),
      },
      annotations: { ...WRITES },
    },
    (input) => {
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
      const clauses = input.clauses as Clause[];
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
        "Puts the SRD options for the next level, plus your recommendations among them and your own suggestions with their power reports and your reasons, into the player's level-up window, where they choose. Call it once the character can level - xp {op: award} or xp {op: milestone} says so. Recommend from the options on offer first: name the spells, cantrips, subclass, feat, ability scores or hit point method you would take, each with a why tied to how they have been playing (the play profile in the briefing) and to what the option does at the table - \"Web pins the room down, which is how you have won every fight this chapter\". Names must match the options exactly, or the call is refused with the valid ones listed. Then you may still add suggestions of your own for what the rules do not cover; those above the power budget are kept and shown as such, and the player still decides. Each suggestion is stored as campaign homebrew and comes back with a homebrew_id, which is what the window sends back with the player's choices; the ones they do not take are dropped when the level-up is applied. It logs a level_up_ready event. Nothing goes on the sheet until the player confirms in their window (or you call level_up with their choices). The older flat mechanics fields are refused, so every effect must be written as clauses. Write each suggestion's clauses the same way propose {op: feature} asks for them and run check_mechanics on them first.",
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        suggestions: z.array(SUGGESTION).default([]),
        recommendations: RECOMMENDATIONS.optional(),
      },
      annotations: { ...WRITES },
    },
    (input) => {
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
      for (const suggestion of input.suggestions) {
        const legacy = legacyMechanicsFields(suggestion.mechanics as Mechanics);
        if (legacy.length) throw new Error(LEGACY_REFUSAL(legacy));
      }
      // One homebrew suggestion per level-up: the first is kept and the rest are named back to the DM.
      const [kept, ...extra] = input.suggestions;
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
      "Moves a piece of homebrew - a background, feat, feature, subclass or spell - out of this campaign and into the personal library, where every campaign can use it, or lists what is already there. op=save is for when the player says they want to keep something for their next character: the entry keeps its power report and label, and is stamped with balanced_at_level - the level the character stood at when it was kept - so a later campaign knows what it was written for. op=list shows the homebrew kept across campaigns: backgrounds, feats, features, subclasses and spells with their power labels, the level each was balanced at (balanced_at_level) and, for a subclass written as a recreation of an official one, recreated_from; each entry also carries clause_status: what every clause of it says and whether the engine runs it, has it planned or only reminds you of it - a subclass bundle shows the clauses of all its levels; read it when the player says \"the thing I made last time\" or when you are preparing level-up options, and offer library entries by name; use op=list to find one to reuse by name. Library subclasses and spells also turn up on their own in the level-up window. It changes nothing.",
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
