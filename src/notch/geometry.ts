/*
 * Notch dimensions per state (CSS px = DIPs, scaled with Windows DPI).
 * Derived from NotchDrop (MIT) and the MacBook notch proportions.
 *
 *   w    width of the black body (without ears)
 *   h    height
 *   r    radius of the bottom corners
 *   ear  radius of the outward-curved "ears" at the top edge
 */
export interface NotchGeometry {
  w: number;
  h: number;
  r: number;
  ear: number;
}

/** Header height when open = height of the closed notch. */
export const HEADER_HEIGHT = 32;

/** Tool bar at the bottom of the open notch (like OmniNotch). */
export const DOCK_HEIGHT = 46;

/** Padding when open. Inner radii = r − PADDING (concentric). */
export const PADDING = 16;

export const geometry = {
  /** Idle: MacBook notch proportions (about 185 × 32 pt). */
  closed: { w: 188, h: 30, r: 10, ear: 6 },
  /** Hover: slightly larger, as feedback. */
  peek: { w: 204, h: 34, r: 12, ear: 7 },
  /** Closed with a live activity (music): side slots for cover + equalizer. */
  live: { w: 284, h: 30, r: 10, ear: 6 },
  /** Gaming mode: wider slots for FPS/CPU on the left and GPU/RAM on the right. */
  gaming: { w: 436, h: 30, r: 10, ear: 6 },
  /** Focus mode "line": a thin strip at the screen edge, just enough to find it again. */
  line: { w: 150, h: 5, r: 2.5, ear: 3 },
} satisfies Record<string, NotchGeometry>;

/** Open state: size comes from the active tab, radii are fixed. */
export function openGeometry(w: number, h: number): NotchGeometry {
  return { w, h, r: 30, ear: 14 };
}
