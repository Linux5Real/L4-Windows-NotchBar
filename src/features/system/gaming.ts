import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { display, fetchFps } from "../../platform/services";
import { settings } from "../../settings/store";

/** Vollbild-App auf dem Monitor der Notch (kommt aus display.rs). */
const fullscreen = createStore(false);

export function startGamingWatch() {
  display.onFullscreen((on) => fullscreen.set(on));
}

/** Zeigt die geschlossene Notch gerade FPS und Auslastung? */
export function useGamingLive(): boolean {
  const mode = settings.use().gaming.mode;
  const full = fullscreen.use();
  return mode === "on" || (mode === "fullscreen" && full);
}

export const fps = createStore<{ value: number | null; error: string | null }>({ value: null, error: null });

/** FPS 1×/s abfragen, solange die Anzeige sichtbar ist. */
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
