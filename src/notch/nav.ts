import { createStore } from "../lib/store";

/**
 * Welches Tool ist offen? Global, damit Tools untereinander verlinken können
 * (z. B. Depot ohne Schlüssel → "In Einstellungen verbinden").
 * `section` scrollt die Einstellungen zu einem Abschnitt.
 */
export const nav = createStore<{ tabId: string; section: string | null }>({ tabId: "media", section: null });

export function navigate(tabId: string, section: string | null = null) {
  nav.set({ tabId, section });
}
