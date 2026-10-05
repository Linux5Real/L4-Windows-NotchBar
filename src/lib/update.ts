import { createStore } from "./store";
import { settings } from "../settings/store";
import { updater, type UpdateHandle } from "../platform/services";

/*
 * Updates: check (anonymously, only the latest.json of the newest GitHub release), show the
 * version, download + install only on click. Signed: the app only installs updates with a
 * valid signature (key in tauri.conf.json → plugins.updater.pubkey).
 */

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "error";

export const update = createStore<{
  current: string | null;
  phase: Phase;
  /** New version, if available. */
  version: string | null;
  progress: number;
  checkedAt: number | null;
}>({ current: null, phase: "idle", version: null, progress: 0, checkedAt: null });

let found: UpdateHandle | null = null;

export async function checkForUpdate() {
  const phase = update.get().phase;
  if (phase === "checking" || phase === "downloading") return;
  update.set((s) => ({ ...s, phase: "checking" }));
  try {
    found = await updater.check();
    update.set((s) => ({ ...s, phase: found ? "available" : "current", version: found?.version ?? null, checkedAt: Date.now() }));
  } catch {
    found = null;
    update.set((s) => ({ ...s, phase: "error", checkedAt: Date.now() }));
  }
}

export async function installUpdate() {
  if (!found || update.get().phase !== "available") return;
  update.set((s) => ({ ...s, phase: "downloading", progress: 0 }));
  try {
    await found.install((progress) => update.set((s) => ({ ...s, progress })));
  } catch {
    update.set((s) => ({ ...s, phase: "error" }));
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** On start (slightly delayed to keep startup fast) and daily after that, if allowed. */
export function startUpdateWatch() {
  void updater.current().then((current) => update.set((s) => ({ ...s, current })));
  const auto = () => settings.get().updates.auto && void checkForUpdate();
  setTimeout(auto, 15_000);
  setInterval(auto, DAY);
}
