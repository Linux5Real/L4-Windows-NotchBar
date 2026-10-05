import { createStore } from "../lib/store";
import { onFocusExit, setPassthrough } from "../platform/native";

/*
 * Fokus-Modus: Die Notch bleibt sichtbar, aber halb durchsichtig und komplett
 * klick-durchlässig — Klicks landen in der App darunter (z. B. Browser-Tabs ganz oben).
 * Rein und raus: drei schnelle Klicks auf die Notch (oder der Knopf in der Kopfzeile).
 * Nativ zählt Rust die Klicks, weil das Fenster selbst keine mehr bekommt.
 */
export const focusMode = createStore(false, { persist: "focus-mode" });

/** So viele schnelle Klicks schalten um (wie EXIT_CLICKS in hit_test.rs). */
export const FOCUS_CLICKS = 3;

export function setFocusMode(on: boolean) {
  focusMode.set(on);
}

let started = false;

export function startFocusMode() {
  if (started) return;
  started = true;
  const apply = () => setPassthrough(focusMode.get());
  apply();
  focusMode.subscribe(apply);
  onFocusExit(() => setFocusMode(false));
}
