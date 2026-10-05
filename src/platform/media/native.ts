import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { accentFrom } from "../../lib/accent";
import type { MediaSource, NowPlaying } from "./types";

/** So kommt es aus Rust (src-tauri/src/media.rs). */
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
  // Nach einem Sprung kurz die alten Positionen aus Rust ignorieren, sonst springt der Balken zurück.
  let seekGuardUntil = 0;
  // Neuer Song kommt oft erst ohne Cover (GSMTC liefert es ~0,5 s später): so lange das
  // alte stehen lassen statt kurz auf das Noten-Symbol zu springen.
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
        // Kam bis dahin nichts Neueres (also auch kein Cover), den Stand ohne Cover übernehmen.
        artHoldTimer = window.setTimeout(() => lastRaw === raw && apply(raw), ART_HOLD_MS + 50);
      }
      if (performance.now() < artHoldUntil) np = { ...np, artwork: state.artwork };
    }
    // Akzent vom bisherigen Cover behalten, bis der neue berechnet ist — kein Aufblitzen.
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

  // Sofort reagieren statt auf GSMTC zu warten (~400 ms) — Rust korrigiert danach.
  const optimistic = (patch: Partial<NowPlaying>) => {
    if (!state) return;
    state = { ...state, ...patch, updatedAt: performance.now() };
    notify();
  };
  const control = (action: string, position?: number) => void invoke("media_control", { action, position });

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
  };
}
