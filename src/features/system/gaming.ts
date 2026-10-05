import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { display, fetchFps } from "../../platform/services";
import { settings } from "../../settings/store";

/** Fullscreen app on the notch's monitor (from display.rs). */
const fullscreen = createStore(false);

export function startGamingWatch() {
  display.onFullscreen((on) => fullscreen.set(on));
}

/** Is the closed notch showing FPS and load right now? */
export function useGamingLive(): boolean {
  const mode = settings.use().gaming.mode;
  const full = fullscreen.use();
  return mode === "on" || (mode === "fullscreen" && full);
}

export const fps = createStore<{ value: number | null; error: string | null }>({ value: null, error: null });

/** Poll FPS once a second while the overlay is visible. */
export function useFpsPolling() {
  useEffect(() => {
    let alive = true;
    const load = () => void fetchFps().then((r) => alive && fps.set({ value: r.fps, error: r.error }));
    load();
    const id = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
}
