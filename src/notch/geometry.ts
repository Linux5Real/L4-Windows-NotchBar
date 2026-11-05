import { useMemo } from "react";
import { settings, type NotchScale } from "../settings/store";

/*
 * Notch dimensions per state (CSS px = DIPs, scaled with Windows DPI).
 * Derived from NotchDrop (MIT) and the MacBook notch proportions.
 *
 *   w    width of the black body (without ears)
 *   h    height
 *   r    radius of the bottom corners
 *   ear  radius of the outward-curved "ears" at the top edge
 *
 * The closed looks are multiplied by the size setting (`display.scale`).
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

/** The states whose size the setting changes (open stays per tool). */
export type ClosedShape = "closed" | "peek" | "live" | "gaming" | "prayer" | "line" | "linePeek";

export type NotchShapes = Record<ClosedShape, NotchGeometry>;

const baseGeometry = {
  /** Idle: MacBook notch proportions (about 185 × 32 pt). */
  closed: { w: 188, h: 30, r: 10, ear: 6 },
  /** Hover: slightly larger, as feedback. */
  peek: { w: 204, h: 34, r: 12, ear: 7 },
  /** Closed with a live activity (music): side slots for cover + equalizer. */
  live: { w: 284, h: 30, r: 10, ear: 6 },
  /** Gaming mode: wider slots for FPS/CPU on the left and GPU/RAM on the right. */
  gaming: { w: 436, h: 30, r: 10, ear: 6 },
  /** Prayer arrival: a compact banner with artwork, Arabic name, time and place. */
  prayer: { w: 288, h: 56, r: 16, ear: 7 },
  /** Focus mode "line": a thin strip at the screen edge, just enough to find it again. */
  line: { w: 150, h: 5, r: 2.5, ear: 3 },
  /** Hover on the line: it stays a line, just a touch bigger, then opens straight away. */
  linePeek: { w: 166, h: 7, r: 3.5, ear: 3.5 },
} satisfies NotchShapes;

/** Multipliers of the size setting. */
export const notchScaleFactor: Record<NotchScale, number> = { s: 0.85, m: 1, l: 1.15, xl: 1.3 };

/** All closed-state shapes for one size setting. Width and height stay whole px. */
export function notchGeometry(scale: NotchScale): NotchShapes {
  const f = notchScaleFactor[scale] ?? 1;
  if (f === 1) return baseGeometry;
  const scaled = {} as NotchShapes;
  for (const key of Object.keys(baseGeometry) as ClosedShape[]) {
    const g = baseGeometry[key];
    scaled[key] = {
      w: Math.round(g.w * f),
      h: Math.round(g.h * f),
      r: Math.round(g.r * f * 2) / 2,
      ear: Math.round(g.ear * f * 2) / 2,
    };
  }
  return scaled;
}

/** Shapes for the current size setting; re-renders when it changes. */
export function useNotchGeometry(): NotchShapes {
  const scale = settings.use().display.scale ?? "m";
  return useMemo(() => notchGeometry(scale), [scale]);
}

/** Open state: size comes from the active tab, radii are fixed. */
export function openGeometry(w: number, h: number): NotchGeometry {
  return { w, h, r: 30, ear: 14 };
}
