import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import LastScene, { SCENE_CLAMP, sceneText } from '../src/components/LastScene.svelte';
import Story from '../src/components/Story.svelte';
import type { Scene, Snapshot } from '../src/lib/types';

const paragraphs = Array.from(
  { length: 7 },
  (_, index) => `Paragraph ${index + 1}. Something happened in the dark.`,
);
const recap = paragraphs.join('\n\n');

const scene = (summary: string | null): Scene => ({
  id: 1,
  title: 'The Flooded Warren',
  summary,
  location_name: 'The Warren',
});

describe('sceneText', () => {
  it('falls back to the recap when the scene has no summary', () => {
    const shown = sceneText(scene(null), recap);
    expect(shown.text).toBe(recap);
    expect(shown.more).toBeNull();
  });

  it('prefers the summary and hides a recap that says the same thing', () => {
    const shown = sceneText(scene(recap), recap);
    expect(shown.text).toBe(recap);
    expect(shown.more).toBeNull();
  });

  it('keeps a differing recap behind "more"', () => {
    const shown = sceneText(scene(paragraphs[6]), recap);
    expect(shown.text).toBe(paragraphs[6]);
    expect(shown.more).toBe(recap);
  });

  it('passes the title and place through, or nothing at all', () => {
    expect(sceneText(scene(paragraphs[6]), recap)).toMatchObject({
      title: 'The Flooded Warren',
      location: 'The Warren',
    });
    expect(sceneText(null, null)).toEqual({ title: null, location: null, text: null, more: null });
  });
});

describe('the Now block in the panel', () => {
  const snapshot = (): Snapshot => ({
    campaign: { id: 1, name: 'Testing now', story_shape: 'heroic', premise: null },
    session: { id: 1, number: 1, started_at: '2026-09-11T10:00:00.000Z' },
    last_recap: null,
    current_scene: null,
    previous_scene: null,
    pc: null,
    open_quests: [],
    canon_facts: [],
    recent_events: [],
    glossary_terms: [],
    events_since_checkpoint: 0,
    now: { year: 1491, month: 7, day: 11, hour: 10, minute: 30, month_name: 'Flamerule', date_text: '11 Flamerule', time_of_day: 'midmorning', season: 'summer', weather: 'light rain' },
  });

  it('shows the chapter line, the clock and the last scene without a separate Recap heading', () => {
    const full = snapshot();
    full.last_recap = recap;
    full.previous_scene = scene(paragraphs[6]);
    full.current_scene = { id: 2, title: null, summary: null, location_name: 'The Warren' };
    const { body } = render(Story, { props: { snapshot: full } });
    expect(body).not.toContain('Recap');
    expect(body).not.toContain('Previous scene');
    expect(body).toContain('11 Flamerule');
    expect(body).toContain('midmorning');
    expect(body).toContain('The Flooded Warren');
    expect(body).toContain('Paragraph 7.');
  });

  it('never renders the same text twice when the summary repeats the recap', () => {
    const full = snapshot();
    full.last_recap = recap;
    full.previous_scene = scene(paragraphs[6]);
    const { body } = render(Story, { props: { snapshot: full } });
    expect(body.match(/Paragraph 7\./g)).toHaveLength(1);
    expect(body).not.toContain('Paragraph 1.');
  });

  it('keeps the chapter timeline toggle behind the block', () => {
    const full = snapshot();
    full.story = {
      outline: { premise: null, ending: null, secret_notes: null },
      act: null,
      chapter: { id: 8, act_id: null, number: 8, title: 'Chapter 8', goal: null, summary: null, status: 'open', started_at: '2026-09-11T10:00:00.000Z', closed_at: null },
      recaps: [{ id: 7, chapter_id: 7, number: 7, title: 'Chapter 7', summary: 'What happened in 7.' }],
      threads: [],
      clues: [],
    };
    const { body } = render(Story, { props: { snapshot: full } });
    expect(body).toContain('Chapters so far (1)');
    expect(body).not.toContain('What happened in 7.');
  });
});

describe('the last scene block', () => {
  it('clamps a seven paragraph recap with a more control', () => {
    expect(SCENE_CLAMP).toBe(4);
    const { body } = render(LastScene, { props: { scene: null, recap } });
    expect(body).toContain('clamp');
    expect(body).toContain('more');
    // The collapsed block keeps the whole text in the markup for the clamp to cut.
    expect(body).toContain('Paragraph 7.');
  });

  it('drops the clamp and shows the recap once expanded — what clicking more does', () => {
    const { body } = render(LastScene, { props: { scene: null, recap, expanded: true } });
    expect(body).not.toContain('clamp');
  });

  it('never renders the same text twice, even expanded', () => {
    const { body } = render(LastScene, { props: { scene: scene(recap), recap, expanded: true } });
    expect(body.match(/Paragraph 1\./g)).toHaveLength(1);
  });

  it('renders the full summary and the differing recap beneath it once expanded', () => {
    const { body } = render(LastScene, { props: { scene: scene(paragraphs[6]), recap, expanded: true } });
    expect(body).toContain('Paragraph 7.');
    expect(body).toContain('Recap');
    expect(body.indexOf('Paragraph 7.')).toBeLessThan(body.indexOf('Paragraph 1.'));
  });

  it('says the scene is still in progress when there is nothing to show', () => {
    const { body } = render(LastScene, { props: { scene: null, recap: null } });
    expect(body).toContain('Scene in progress.');
    expect(body).not.toContain('more');
  });
});
