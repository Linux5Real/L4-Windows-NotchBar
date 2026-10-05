import { createStore } from "../lib/store";

/*
 * A tool can change its open size at runtime (e.g. the image preview in the
 * clipboard). The notch then morphs there with a spring; `null` = default size
 * from tabs.ts. Only applies while that tool is active.
 */
export const sizeOverride = createStore<{ tabId: string; w: number; h: number } | null>(null);

/** Maximum usable area in the window (tauri.conf.json: 760 × 560). */
export const MAX_SIZE = { w: 740, h: 540 };

export function requestSize(tabId: string, size: { w: number; h: number } | null) {
  sizeOverride.set(
    size ? { tabId, w: Math.min(MAX_SIZE.w, Math.round(size.w)), h: Math.min(MAX_SIZE.h, Math.round(size.h)) } : null,
  );
}
