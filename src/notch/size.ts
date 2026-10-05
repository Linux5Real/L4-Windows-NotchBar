import { createStore } from "../lib/store";

/*
 * Ein Tool kann seine offene Größe zur Laufzeit ändern (z. B. Bildvorschau in der
 * Zwischenablage). Die Notch morpht dann per Spring dorthin; `null` = Standardgröße
 * aus tabs.ts. Gilt nur, solange dieses Tool aktiv ist.
 */
export const sizeOverride = createStore<{ tabId: string; w: number; h: number } | null>(null);

/** Maximal nutzbare Fläche im Fenster (tauri.conf.json: 760 × 560). */
export const MAX_SIZE = { w: 740, h: 540 };

export function requestSize(tabId: string, size: { w: number; h: number } | null) {
  sizeOverride.set(
    size ? { tabId, w: Math.min(MAX_SIZE.w, Math.round(size.w)), h: Math.min(MAX_SIZE.h, Math.round(size.h)) } : null,
  );
}
