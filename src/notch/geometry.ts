/*
 * Maße der Notch in jedem Zustand (CSS-px = DIPs, skaliert mit Windows-DPI).
 * Abgeleitet aus NotchDrop (MIT) und den Proportionen der MacBook-Notch.
 *
 *   w    Breite des schwarzen Körpers (ohne Ohren)
 *   h    Höhe
 *   r    Radius der unteren Ecken
 *   ear  Radius der nach außen gewölbten "Ohren" an der Oberkante
 */
export interface NotchGeometry {
  w: number;
  h: number;
  r: number;
  ear: number;
}

/** Höhe der Kopfzeile im offenen Zustand = Höhe der geschlossenen Notch. */
export const HEADER_HEIGHT = 32;

/** Tool-Leiste am unteren Rand der offenen Notch (wie OmniNotch). */
export const DOCK_HEIGHT = 46;

/** Innenabstand im offenen Zustand. Innere Radien = r − PADDING (konzentrisch). */
export const PADDING = 16;

export const geometry = {
  /** Ruhezustand: MacBook-Notch-Proportionen (ca. 185 × 32 pt). */
  closed: { w: 188, h: 30, r: 10, ear: 6 },
  /** Hover: minimal größer, als Bestätigung. */
  peek: { w: 204, h: 34, r: 12, ear: 7 },
  /** Geschlossen, aber mit Live-Aktivität (Musik): seitliche Slots für Cover + Equalizer. */
  live: { w: 284, h: 30, r: 10, ear: 6 },
  /** Gaming-Modus: breitere Slots für FPS/CPU links und GPU/RAM rechts. */
  gaming: { w: 436, h: 30, r: 10, ear: 6 },
} satisfies Record<string, NotchGeometry>;

/** Offener Zustand — Größe kommt vom aktiven Tab, Radien sind fix. */
export function openGeometry(w: number, h: number): NotchGeometry {
  return { w, h, r: 30, ear: 14 };
}
