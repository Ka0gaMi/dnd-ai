import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findPreset, settingPresets } from '../core/presets.js';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'resume',
    {
      title: 'Resume a story',
      description: 'Pick up an existing campaign where it was left off.',
      argsSchema: {
        campaign_id: z.string().optional().describe('Leave empty to choose from the list of saved campaigns.'),
      },
    },
    ({ campaign_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: campaign_id
              ? [
                  `Resume campaign ${campaign_id}.`,
                  'Call load_campaign with that id first, read the briefing, and do whatever it asks you to finish first',
                  '(naming the story, writing the premise, completing the character I half-made in the companion window).',
                  'Then give me a short "previously on..." recap',
                  '(5 sentences at most) and set the scene where we stopped. Do not invent anything that is not in the briefing.',
                  'Then ask me what I do. Call roll with roller: "player" for my character\'s and my companions\' checks,',
                  'attacks and saves, so I roll those dice myself.',
              ].join(' ')
              : [
                  "Let's continue one of my stories.",
                  'Call list_campaigns, show me the campaigns as a short numbered list (name, story shape, last recap snippet, character),',
                  'and ask which one to continue. Once I pick, call load_campaign with its id, finish anything the briefing asks you to',
                  '(the name, the premise, my half-made character), give me a short "previously on..." recap,',
                  'set the scene and ask what I do. Call roll with roller: "player" for my character\'s and my companions\' checks,',
                  'attacks and saves, so I roll those dice myself.',
              ].join(' '),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'new_story',
    {
      title: 'Start a new story',
      description: 'Run the session-zero interview and create a new campaign.',
      argsSchema: {
        preset: z
          .string()
          .optional()
          .describe('A setting preset id or name to start from; leave empty to be offered the list.'),
      },
    },
    ({ preset }) => {
      const chosen = preset ? presetByIdOrName(preset) : undefined;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'I want to start a new D&D story with you as the Dungeon Master. Interview me first, one question at a time, and keep it short:',
                chosen
                  ? `0) Setting: I already picked "${chosen.name}" (preset id ${chosen.id}) - ${chosen.pitch} Tone: ${chosen.tone.join(', ')}. Themes: ${chosen.themes.join(', ')}. Take it as given and do not ask me about it again; pass setting_preset "${chosen.id}" in the settings.`
                  : `0) Setting: offer me these presets and let me pick one (or say I want something else): ${settingList()}. Pass the one I pick as settings.setting_preset.`,
                '1) Story shape: a structured adventure with a planned ending, or an open sandbox?',
                '2) Tone and content: the dials lethality, grimness, humour, horror, romance and moral_greyness from 1 to 3; lines (never appear) and veils (off-screen only); how much combat versus talking?',
                '3) Premise: setting, hook and a name for the story - offer me two or three options if I am unsure.',
                '4) Starting date and era: what in-world date and era should the story open on (or say "surprise me" and pick one that fits the setting)?',
                'If I only give you a name and a setting and do not want the rest of the interview, take the one-click path instead:',
                'call create_campaign with the name, a story shape you think fits and settings { setting_preset, needs_ai_fill: true },',
                'then invent a premise (2-3 sentences), an opening scene, two hooks, the first objectives and a starting date and era',
                'that fit that setting, show them to me, and save them with mark_story_filled, add_canon_fact, update_objectives,',
                'set_calendar and save_checkpoint.',
                'Otherwise, when I have answered all four, call create_campaign with the name, story shape, premise and my answers as settings',
                '(setting_preset, tone_dials, lines, veils), and tell me the campaign id.',
                'Then write the outline before we play: call set_story_outline with the premise, the ending you are steering towards',
                'and your DM-only notes (the twist - I do not see those), add_act for two or three acts with their goals,',
                'open_chapter for the first chapter, and set_calendar with the starting date and era I gave you (or one you picked).',
                'Show me the acts, keep the secrets to yourself.',
                'If the briefing for this story already carries a character draft I left in the companion window, build from that instead of',
                'asking me again: fill the gaps with legal options that fit it, write a backstory and an appearance, and call create_character.',
                'Otherwise build my character from scratch. I am new to D&D, so interview me instead of handing me a form:',
                'call list_character_options and offer me the classes in one or two lines each, then ask for a species,',
                'then a background, then call it again with my picks to get the skill, equipment and spell choices,',
                'and walk me through those one question at a time. Explain the ability score methods and suggest an assignment',
                'that fits the class before asking me to confirm.',
                'Finally call create_character with everything, read back the resulting hit points, AC and skills.',
                'Then offer me one companion to travel with - a party of one is fragile - and if I want one, suggest two or three',
                'who fit the premise (a hired sword, a rescued NPC, a loyal animal) and call create_companion with my pick.',
                'Then start the story. Call roll with roller: "player" for my character\'s and my companions\' checks,',
                'attacks and saves, so I roll those dice myself.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );
}

/** The preset list the prompt reads out, so a chat-created story can pick the same settings the wizard offers. */
function settingList(): string {
  return settingPresets()
    .presets.map((p) => `${p.name} (${p.id}) - ${p.pitch}`)
    .join('; ');
}

function presetByIdOrName(value: string) {
  const wanted = value.trim().toLowerCase();
  return findPreset(wanted) ?? settingPresets().presets.find((p) => p.name.toLowerCase() === wanted);
}
