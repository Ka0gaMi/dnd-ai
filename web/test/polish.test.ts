import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import Header from '../src/components/Header.svelte';
import Story from '../src/components/Story.svelte';
import { helpFor } from '../src/lib/rulesHelp';
import { DEFAULT_SETTINGS } from '../src/lib/settings';
import type { Snapshot } from '../src/lib/types';

const now = {
  year: 1, month: 1, day: 1, hour: 8, minute: 0,
  month_name: 'Deepfrost', date_text: '1 Deepfrost, year 1, 08:00',
  time_of_day: 'morning', season: 'winter', weather: 'clear',
};

const header = (snap: Snapshot): string =>
  render(Header, {
    props: { snapshot: snap, status: 'live', error: null, settings: DEFAULT_SETTINGS, onsettings: () => undefined, onswitch: () => undefined, onnew: () => undefined },
  }).body;

const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  campaign: { id: 1, name: 'Polish', story_shape: 'heroic', premise: null },
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
  now,
  ...extra,
});

describe('rewind control', () => {
  it('is replaced by a reason until a checkpoint exists', () => {
    const { body } = render(Story, { props: { snapshot: snapshot({ has_checkpoint: false }) } });
    expect(body).not.toContain('Rewind to last checkpoint');
    expect(body).toContain('Nothing to rewind to yet');
  });

  it('shows once a checkpoint exists, and on an older server', () => {
    expect(render(Story, { props: { snapshot: snapshot({ has_checkpoint: true }) } }).body).toContain('Rewind to last checkpoint');
    expect(render(Story, { props: { snapshot: snapshot() } }).body).toContain('Rewind to last checkpoint');
  });
});

describe('unset calendar', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  afterEach(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }));

  it('hides the date in the header and story until the calendar is set', () => {
    const unset = snapshot({ calendar_set: false });
    expect(header(unset)).not.toContain('Deepfrost');
    expect(render(Story, { props: { snapshot: unset } }).body).not.toContain('Deepfrost');
  });

  it('shows the date once the calendar is set', () => {
    expect(header(snapshot({ calendar_set: true }))).toContain('Deepfrost');
    expect(render(Story, { props: { snapshot: snapshot({ calendar_set: true }) } }).body).toContain('Deepfrost');
  });
});

describe('player-facing wording', () => {
  it('names no tool, host product or stale call in the play-rhythm tip', () => {
    const text = helpFor('session_rhythm')?.text ?? '';
    expect(text).not.toMatch(/ChatGPT|Claude|MCP|_checkpoint|load_campaign/);
  });
});
