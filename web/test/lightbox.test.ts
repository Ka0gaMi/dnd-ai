import { describe, expect, it } from 'vitest';
import { close, lightbox, open } from '../src/lib/lightbox.svelte';

describe('lightbox', () => {
  it('starts closed', () => {
    expect(lightbox.src).toBeNull();
    expect(lightbox.caption).toBeNull();
  });

  it('opens with a source and caption, then closes back to null', () => {
    open('/portraits/1.png', 'Aria Nightshade');
    expect(lightbox.src).toBe('/portraits/1.png');
    expect(lightbox.caption).toBe('Aria Nightshade');

    close();
    expect(lightbox.src).toBeNull();
    expect(lightbox.caption).toBeNull();
  });

  it('opening a second portrait replaces the first', () => {
    open('/portraits/1.png', 'Aria Nightshade');
    open('/portraits/2.png', 'Goblin Warrior');
    expect(lightbox.src).toBe('/portraits/2.png');
    expect(lightbox.caption).toBe('Goblin Warrior');
    close();
  });
});
