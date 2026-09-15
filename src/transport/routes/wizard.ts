import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import {
  campaignListItem,
  characterDraftSummary,
  createCampaign,
  getCampaign,
  setCharacterDraft,
  type CharacterDraft,
} from '../../core/campaign.js';
import { createCharacter, listCharacterOptions, type FeatChoices } from '../../core/character.js';
import { findPreset, settingPresets } from '../../core/presets.js';
import { speciesLineages } from '../../srd/lookup.js';

const abilityScores = z.object({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});

/** Every field is optional: whatever the player leaves empty, the DM writes on first play. */
const newCampaignBody = z.object({
  name: z.string().optional(),
  story_shape: z.enum(['structured', 'sandbox']).optional(),
  setting_preset: z.string().optional(),
  tone_dials: z.record(z.string(), z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
  lines: z.string().optional(),
  veils: z.string().optional(),
  premise: z.string().optional(),
});

const abilityMethod = z.enum(['standard_array', 'point_buy', 'manual']);

/** The create_character input minus campaign_id, all of it optional: less than this is a draft. */
const newCharacterBody = z.object({
  name: z.string().optional(),
  species: z.string().optional(),
  lineage: z.string().optional(),
  class: z.string().optional(),
  background: z.string().optional(),
  ability_method: abilityMethod.optional(),
  abilities: abilityScores.optional(),
  ability_bonuses: abilityScores.partial().optional(),
  skill_choices: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  feature_options: z.record(z.string(), z.array(z.string())).optional(),
  feat_choices: z.record(z.string(), z.unknown()).optional(),
  equipment_choice: z.union([z.string(), z.number().int()]).optional(),
  background_equipment_choice: z.union([z.string(), z.number().int()]).optional(),
  equipment_picks: z.array(z.string()).optional(),
  cantrips: z.array(z.string()).optional(),
  spells: z.array(z.string()).optional(),
  spellbook: z.array(z.string()).optional(),
  alignment: z.string().optional(),
  backstory: z.string().optional(),
  /** Draft-only: what the player wants the DM to build from. */
  gender: z.string().optional(),
  idea: z.string().optional(),
});

type NewCharacterBody = z.infer<typeof newCharacterBody>;

const trimmed = (value: string | undefined): string => (value ?? '').trim();

/** A story the player did not name is dated instead, until the DM gives it a real one. */
function placeholderName(): string {
  return `Untitled story (${new Date().toISOString().slice(0, 10)})`;
}

/** An empty list means "choose for me": the server fills it in and says what it picked. */
const filled = <T>(list: T[] | undefined): T[] | undefined => (list?.length ? list : undefined);

/** create_character needs all of these; anything less stays a draft for the DM to finish. */
function isComplete(body: NewCharacterBody): boolean {
  return (
    trimmed(body.name) !== '' &&
    trimmed(body.species) !== '' &&
    // A species with lineages needs one: without it the character stays a draft for the DM to finish.
    (trimmed(body.lineage) !== '' || speciesLineages(trimmed(body.species)).length === 0) &&
    trimmed(body.class) !== '' &&
    trimmed(body.background) !== '' &&
    body.ability_method !== undefined &&
    body.abilities !== undefined &&
    body.ability_bonuses !== undefined
  );
}

/** What the player did answer, kept for the DM; empty answers are left out entirely. */
function draftOf(body: NewCharacterBody): CharacterDraft {
  const draft: CharacterDraft = {};
  if (trimmed(body.name)) draft.name = trimmed(body.name);
  if (trimmed(body.class)) draft.class = trimmed(body.class);
  if (trimmed(body.species)) draft.species = trimmed(body.species);
  if (trimmed(body.lineage)) draft.lineage = trimmed(body.lineage);
  if (trimmed(body.background)) draft.background = trimmed(body.background);
  if (trimmed(body.gender)) draft.gender = trimmed(body.gender);
  if (trimmed(body.idea)) draft.idea = trimmed(body.idea);
  if (body.ability_method) draft.ability_method = body.ability_method;
  return draft;
}

/** The "New story" wizard: setting presets, the campaign shell and the character step. */
export default function registerWizardRoutes(app: Express, db: Db): void {
  app.get('/api/presets', (_req, res) => {
    res.json(settingPresets());
  });

  app.post('/api/campaigns', (req, res) => {
    const parsed = newCampaignBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid campaign', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    if (body.setting_preset !== undefined && !findPreset(body.setting_preset)) {
      res.status(400).json({ error: `unknown setting preset "${body.setting_preset}"` });
      return;
    }
    const name = trimmed(body.name);
    const premise = trimmed(body.premise);
    const fill = { ...(name ? {} : { name: true }), ...(premise ? {} : { premise: true }) };
    const created = createCampaign(db, {
      name: name || placeholderName(),
      story_shape: body.story_shape ?? 'structured',
      premise: premise || undefined,
      settings: {
        setting_preset: body.setting_preset ?? null,
        tone_dials: body.tone_dials ?? {},
        lines: body.lines ?? '',
        veils: body.veils ?? '',
        needs_ai_fill: Object.keys(fill).length ? fill : false,
      },
    });
    res.status(201).json(campaignListItem(db, created.campaign_id));
  });

  app.get('/api/srd/options', (req, res) => {
    const pick = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const campaignId = Number(req.query.campaign_id);
    res.json(
      listCharacterOptions(
        {
          class: pick(req.query.class),
          species: pick(req.query.species),
          background: pick(req.query.background),
          // With a campaign the list also carries its custom backgrounds.
          campaign_id: Number.isInteger(campaignId) ? campaignId : undefined,
        },
        db,
      ),
    );
  });

  app.post('/api/campaigns/:id/character', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const parsed = newCharacterBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid character', details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    try {
      getCampaign(db, id);
      if (!isComplete(body)) {
        // Half an answer is still worth keeping: the DM finishes the sheet from it on first play.
        const draft = draftOf(body);
        setCharacterDraft(db, id, draft);
        res.status(201).json({ character: null, character_draft: draft, draft_summary: characterDraftSummary(draft) });
        return;
      }
      res.status(201).json(
        createCharacter(db, {
          campaign_id: id,
          name: trimmed(body.name),
          species: body.species!,
          lineage: body.lineage,
          class: body.class!,
          background: body.background!,
          ability_method: body.ability_method!,
          abilities: body.abilities!,
          ability_bonuses: body.ability_bonuses!,
          skill_choices: body.skill_choices,
          languages: filled(body.languages),
          tools: filled(body.tools),
          feature_options: Object.keys(body.feature_options ?? {}).length ? body.feature_options : undefined,
          feat_choices: Object.keys(body.feat_choices ?? {}).length ? (body.feat_choices as FeatChoices) : undefined,
          equipment_choice: body.equipment_choice,
          background_equipment_choice: body.background_equipment_choice,
          equipment_picks: filled(body.equipment_picks),
          cantrips: body.cantrips,
          spells: body.spells,
          spellbook: body.spellbook,
          alignment: body.alignment,
          backstory: body.backstory,
        }),
      );
    } catch (err) {
      // The engine's messages already list the legal options, so they go to the player as they are.
      res.status(400).json({ error: (err as Error).message });
    }
  });
}
