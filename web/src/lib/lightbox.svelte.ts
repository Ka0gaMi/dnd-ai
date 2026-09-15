// The portrait lightbox: one shared instance for every clickable portrait on the screen.
const state = $state<{ src: string | null; caption: string | null }>({ src: null, caption: null });

export const lightbox = state;

export function open(src: string, caption: string): void {
  state.src = src;
  state.caption = caption;
}

export function close(): void {
  state.src = null;
  state.caption = null;
}
