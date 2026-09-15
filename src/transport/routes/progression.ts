import type { Express } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { levelUp, levelUpOptions } from '../../core/character.js';
import {
  listHomebrew,
  listLibrary,
  playProfile,
  saveToLibrary,
  withOptionDetails,
  type LevelUpRecommendations,
} from '../../core/progression.js';
import { levelForXp } from '../../core/rules.js';

// An enum-keyed z.record is exhaustive in zod 4, so partialRecord is what accepts "+2 to dex" alone.
const ABILITY = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);
const swap = z.object({ old: z.string(), new: z.string() });

// Zod strips what it does not name, so every key level_up accepts has to stand here too.
const choicesSchema = z.object({
  hp: z.enum(['average', 'roll']).optional(),
  subclass: z.string().optional(),
  subclass_homebrew_id: z.number().int().optional(),
  ability_increases: z.partialRecord(ABILITY, z.number().int()).optional(),
  feat: z.string().optional(),
  feat_choices: z
    .object({
      ability: ABILITY.optional(),
      ability_increases: z.partialRecord(ABILITY, z.number().int()).optional(),
      skills: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      spell_list: z.string().optional(),
      spellcasting_ability: z.enum(['int', 'wis', 'cha']).optional(),
      cantrips: z.array(z.string()).optional(),
      spell: z.string().optional(),
    })
    .optional(),
  feature_options: z.record(z.string(), z.array(z.string())).optional(),
  cantrips: z.array(z.string()).optional(),
  spells: z.array(z.string()).optional(),
  replace_cantrip: swap.optional(),
  replace_spell: swap.optional(),
  spellbook: z.array(z.string()).optional(),
  homebrew_ids: z.array(z.number().int()).optional(),
});

const levelUpBody = z.object({
  choices: choicesSchema.default({}),
  /** The window sends the homebrew picks beside the choices; either place works. */
  homebrew_ids: z.array(z.number().int()).optional(),
});

interface CharacterRow {
  id: number;
  campaign_id: number;
  is_pc: number;
  level: number;
  xp: number;
  pending_level_up_json: string | null;
}

function characterRow(db: Db, id: number): CharacterRow | undefined {
  return db
    .prepare('SELECT id, campaign_id, is_pc, level, xp, pending_level_up_json FROM character WHERE id = ?')
    .get(id) as CharacterRow | undefined;
}

/** The level-up panel, the personal library and the play profile card in the player's window. */
export default function registerProgressionRoutes(app: Express, db: Db): void {
  app.get('/api/characters/:id/level-up', (req, res) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? characterRow(db, id) : undefined;
    if (!row) {
      res.status(404).json({ error: 'no such character' });
      return;
    }
    const prepared = row.pending_level_up_json
      ? (JSON.parse(row.pending_level_up_json) as {
          to_level: number | null;
          prepared_at: string;
          suggestions: unknown[];
          recommendations?: LevelUpRecommendations | null;
        })
      : null;
    // The options are read fresh, so the details the tooltips use are rebuilt with them.
    const srd = withOptionDetails(levelUpOptions(db, row.campaign_id, row.id) as Record<string, unknown>, db, row.campaign_id);
    // A milestone level is granted by raising the XP to its threshold, so one check answers both modes.
    res.json({
      character_id: row.id,
      available: levelForXp(row.xp) > row.level,
      level_up: prepared
        ? {
            to_level: (srd.to_level as number | undefined) ?? prepared.to_level ?? null,
            prepared_at: prepared.prepared_at,
            srd,
            suggestions: prepared.suggestions,
            recommendations: prepared.recommendations ?? null,
          }
        : null,
    });
  });

  app.post('/api/characters/:id/level-up', (req, res) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? characterRow(db, id) : undefined;
    if (!row) {
      res.status(404).json({ error: 'no such character' });
      return;
    }
    if (row.is_pc !== 1) {
      res.status(400).json({ error: 'only the player character levels up here' });
      return;
    }
    const parsed = levelUpBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid choices', details: parsed.error.issues });
      return;
    }
    const choices = { ...parsed.data.choices, homebrew_ids: parsed.data.homebrew_ids ?? parsed.data.choices.homebrew_ids };
    try {
      res.json(levelUp(db, { campaign_id: row.campaign_id, choices }));
    } catch (err) {
      // The engine's messages name exactly what is missing, so they go to the player as they are.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/campaigns/:id/library', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    res.json({
      campaign: listHomebrew(db, id).filter((entry) => entry.scope === 'campaign'),
      library: listLibrary(db),
    });
  });

  app.post('/api/homebrew/:id/library', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad homebrew id' });
      return;
    }
    try {
      res.json(saveToLibrary(db, id));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get('/api/campaigns/:id/play-profile', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'bad campaign id' });
      return;
    }
    const characterId = Number(req.query.character_id);
    try {
      res.json(playProfile(db, id, Number.isInteger(characterId) ? characterId : undefined));
    } catch {
      res.status(404).json({ error: 'no such campaign' });
    }
  });
}
