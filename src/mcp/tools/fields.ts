import { z } from 'zod';

// Id fields many tools share, described once so tools/list does not repeat a sentence per tool.
export const CAMPAIGN_ID = z.number().int();

export const CHARACTER_ID = z
  .number()
  .int()
  .optional()
  .describe('Leave out for the player character; a companion id from the briefing otherwise.');
