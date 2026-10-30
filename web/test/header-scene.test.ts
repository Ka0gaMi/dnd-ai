import { describe, expect, it } from 'vitest';
import { sceneLine } from '../src/components/Header.svelte';
import type { Scene, Snapshot } from '../src/lib/types';

const scene = (title: string | null, location_name: string | null, summary: string | null = null): Scene => ({
  id: 1,
  title,
  summary,
  location_name,
});

const snapshot = (current_scene: Scene | null, previous_scene: Scene | null): Snapshot =>
  ({ current_scene, previous_scene }) as Snapshot;

describe("the header's scene line", () => {
  it('names where a seeded scene stands, though it has no title yet', () => {
    expect(sceneLine(snapshot(scene(null, 'Tallowmere'), null))).toEqual({ title: null, place: 'Tallowmere' });
  });

  it("never shows a closed scene's title as the scene in progress", () => {
    const weir = scene('The weir at night', 'Redham', 'They found Tobias.');
    // A new session has no scene open yet; the party is still where the last one ended.
    expect(sceneLine(snapshot(null, weir))).toEqual({ title: null, place: 'Redham' });
    expect(sceneLine(snapshot(scene(null, 'Redham'), weir))).toEqual({ title: null, place: 'Redham' });
  });

  it('shows the title of the scene in progress when it has one', () => {
    expect(sceneLine(snapshot(scene('Wolves on the road', 'The lake road'), null))).toEqual({
      title: 'Wolves on the road',
      place: 'The lake road',
    });
  });

  it('has nothing to show before any scene', () => {
    expect(sceneLine(snapshot(null, null))).toEqual({ title: null, place: null });
    expect(sceneLine(null)).toEqual({ title: null, place: null });
  });
});
