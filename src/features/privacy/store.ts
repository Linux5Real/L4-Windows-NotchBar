import { createStore } from "../../lib/store";
import { fetchPrivacy, type PrivacyState } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";

/*
 * Mic/camera/screen use, polled once for the privacy dots and the presentation mode.
 * Only runs while one of them needs it.
 */
const POLL_MS = 1500;

export const privacy = createStore<PrivacyState>({ mic: false, camera: false, screen: false });

/** "Off for now" during an auto-detected recording; resets when the recording ends. */
const snoozed = createStore(false);

let poll: number | undefined;

function syncPolling() {
  const s = settings.get();
  const needed = s.privacyDots || s.presentation.auto;
  if (needed && poll === undefined) {
    const load = () =>
      void fetchPrivacy().then((next) => {
        const prev = privacy.get();
        if (prev.mic === next.mic && prev.camera === next.camera && prev.screen === next.screen) return;
        if (!next.screen) snoozed.set(false);
        privacy.set(next);
      });
    load();
    poll = window.setInterval(load, POLL_MS);
  } else if (!needed && poll !== undefined) {
    window.clearInterval(poll);
    poll = undefined;
    snoozed.set(false);
    privacy.set({ mic: false, camera: false, screen: false });
  }
}
settings.subscribe(syncPolling);
syncPolling();

function isPresenting(manual: boolean, auto: boolean, screen: boolean, off: boolean): boolean {
  return manual || (auto && screen && !off);
}

/**
 * Presentation mode: hides clipboard previews, balances and the vault.
 * On by hand, or automatically while the screen is recorded or shared.
 */
export function usePresenting(): boolean {
  const { manual, auto } = settings.use().presentation;
  const { screen } = privacy.use();
  const off = snoozed.use();
  return isPresenting(manual, auto, screen, off);
}

/** One switch for both cases: during an auto-detected recording "off" only lasts until it ends. */
export function togglePresentation() {
  const { manual, auto } = settings.get().presentation;
  const { screen } = privacy.get();
  if (isPresenting(manual, auto, screen, snoozed.get())) {
    if (manual) updateSettings((s) => ({ presentation: { ...s.presentation, manual: false } }));
    if (auto && screen) snoozed.set(true);
  } else {
    snoozed.set(false);
    updateSettings((s) => ({ presentation: { ...s.presentation, manual: true } }));
  }
}
