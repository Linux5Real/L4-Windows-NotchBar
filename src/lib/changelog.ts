import bundled from "../changelog.json";
import { lang } from "../i18n";
import { firstRun } from "../settings/store";
import type { ChangelogEntry } from "../platform/services";
import { createStore } from "./store";
import { update } from "./update";

/*
 * "What's new": the changelog ships with the app (src/changelog.json). After an update,
 * every version since the last one you saw is new (skipped updates included) and a dot
 * on the gear points to it. Nothing pops up by itself.
 */
export const changelog: ChangelogEntry[] = bundled;

/** Last version whose changes were seen. */
const seen = createStore<string | null>(null, { persist: "changelog-seen" });

/** -1 / 0 / 1, numeric per part ("1.10.0" > "1.9.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Entries after `from` up to and including `to`. */
export function between(entries: ChangelogEntry[], from: string | null, to: string): ChangelogEntry[] {
  return entries.filter((e) => compareVersions(e.version, to) <= 0 && (!from || compareVersions(e.version, from) > 0));
}

export function itemText(item: ChangelogEntry["items"][number]): string {
  return lang() === "en" ? item.en : item.de;
}

/**
 * First start of a version with changelog support: a fresh install has nothing new;
 * an update from an older version (no "seen" yet) gets the current version's changes.
 */
function initSeen() {
  const current = update.get().current;
  if (!current || seen.get() !== null) return;
  seen.set(firstRun ? current : (changelog.find((e) => compareVersions(e.version, current) < 0)?.version ?? "0.0.0"));
}
update.subscribe(initSeen);
initSeen();

/** Versions not seen yet (newest first). Empty = no dot. */
export function useUnseen(): ChangelogEntry[] {
  const from = seen.use();
  const current = update.use().current;
  if (!current || from === null) return [];
  return between(changelog, from, current);
}

export function markSeen() {
  const current = update.get().current;
  if (current) seen.set(current);
}
