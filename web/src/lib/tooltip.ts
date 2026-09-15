// Tooltips are positioned against the viewport, not their column: a column scrolls and clips,
// and a neighbouring column paints over anything that leaks out of it.

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Right-aligned to the anchor because the left edge ran out of room. */
  flippedX: boolean;
  /** Above the anchor because there was no room below. */
  flippedY: boolean;
}

const GAP = 4;
const EDGE = 8;

/** Under the anchor and left-aligned with it, flipped and then clamped to stay on screen. */
export function tooltipPosition(anchor: AnchorRect, tip: Size, view: Size): Placement {
  let left = anchor.left;
  let flippedX = false;
  if (left + tip.width > view.width - EDGE) {
    left = anchor.right - tip.width;
    flippedX = true;
  }
  left = Math.max(EDGE, Math.min(left, view.width - tip.width - EDGE));

  let top = anchor.bottom + GAP;
  let flippedY = false;
  if (top + tip.height > view.height - EDGE && anchor.top - tip.height - GAP >= EDGE) {
    top = anchor.top - tip.height - GAP;
    flippedY = true;
  }
  top = Math.max(EDGE, Math.min(top, view.height - tip.height - EDGE));

  return { left, top, flippedX, flippedY };
}
