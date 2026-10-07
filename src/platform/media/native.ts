import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { accentFrom } from "../../lib/accent";
import type { MediaSource, NowPlaying } from "./types";

/** Shape of the data from Rust (src-tauri/src/media.rs). */
interface NativeNowPlaying {
  title: string;
  artist: string;
  artwork: string | null;
  isPlaying: boolean;
  position: number;
  duration: number;
  canSeek: boolean;
  appId: string;
}

function livePositionOf(np: NowPlaying): number {
  return np.isPlaying ? np.position + (performance.now() - np.updatedAt) / 1000 : np.position;
}

export function createNativeMedia(): MediaSource {
  let state: NowPlaying | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  // Ignore Rust's old positions briefly after a seek, otherwise the bar jumps back.
  let seekGuardUntil = 0;
  // A new track often arrives without a cover (GSMTC sends it ~0.5 s later): keep the
  // old one meanwhile instead of flashing the note icon.
  let artHoldUntil = 0;
  let artHoldTimer: number | undefined;
  const ART_HOLD_MS = 1500;

  let lastRaw: NativeNowPlaying | null = null;

  const apply = (np: NativeNowPlaying | null) => {
    lastRaw = np;
    if (np && state && performance.now() < seekGuardUntil && np.title === state.title) {
      np = { ...np, position: livePositionOf(state) };
    }
    if (!np) {
      state = null;
      return notify();
    }
    if (!np.artwork && state?.artwork) {
      if (np.title !== state.title) {
        artHoldUntil = performance.now() + ART_HOLD_MS;
        const raw = np;
        window.clearTimeout(artHoldTimer);
        // Nothing newer (including a cover) by then → take the state without a cover.
        artHoldTimer = window.setTimeout(() => lastRaw === raw && apply(raw), ART_HOLD_MS + 50);
      }
      if (performance.now() < artHoldUntil) np = { ...np, artwork: state.artwork };
    }
    // Keep the accent of the previous cover until the new one is computed, no flash.
    const sameArtwork = state?.artwork === np.artwork;
    state = { ...np, accent: sameArtwork && state ? state.accent : "#ffffff", updatedAt: performance.now() };
    notify();
    if (!sameArtwork) {
      void accentFrom(np.artwork).then((accent) => {
        if (state && state.artwork === np.artwork) {
          state = { ...state, accent };
          notify();
        }
      });
    }
  };

  void invoke<NativeNowPlaying | null>("media_get").then(apply);
  void listen<NativeNowPlaying | null>("media://update", (e) => apply(e.payload));

  // React immediately instead of waiting for GSMTC (~400 ms); Rust corrects afterwards.
  const optimistic = (patch: Partial<NowPlaying>) => {
    if (!state) return;
    state = { ...state, ...patch, updatedAt: performance.now() };
    notify();
  };
  // Rust only emits on changes. If the app ignored the command, nothing changes there
  // and the optimistic state would stick, so take Rust's state again shortly after.
  let resyncTimer: number | undefined;
  const resync = () => {
    window.clearTimeout(resyncTimer);
    resyncTimer = window.setTimeout(() => void invoke<NativeNowPlaying | null>("media_get").then(apply), 1500);
  };
  const control = (action: string, position?: number) => {
    void invoke("media_control", { action, position }).finally(resync);
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle() {
      if (state) {
        const elapsed = state.isPlaying ? (performance.now() - state.updatedAt) / 1000 : 0;
        optimistic({ isPlaying: !state.isPlaying, position: state.position + elapsed });
      }
      control("toggle");
    },
    next: () => control("next"),
    previous: () => control("previous"),
    seek(position) {
      seekGuardUntil = performance.now() + 1200;
      optimistic({ position });
      control("seek", position);
    },
    openSource: () => invoke<boolean>("media_open_source").catch(() => false),
  };
}
