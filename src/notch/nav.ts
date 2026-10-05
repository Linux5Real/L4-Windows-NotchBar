import { createStore } from "../lib/store";

/**
 * Which tool is open? Global so tools can link to each other
 * (e.g. Portfolio without a key → "Connect in settings").
 * `section` scrolls the settings to a section.
 */
export const nav = createStore<{ tabId: string; section: string | null }>({ tabId: "media", section: null });

export function navigate(tabId: string, section: string | null = null) {
  nav.set({ tabId, section });
}
