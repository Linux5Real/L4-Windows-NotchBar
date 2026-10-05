import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "../native";

export type Levels = [number, number, number, number];
type Listener = (levels: Levels) => void;

/*
 * Echte Pegel aus dem Rust-Loopback (src-tauri/src/audio.rs).
 * Die Aufnahme läuft nur, solange mindestens ein sichtbarer Equalizer sie anfordert.
 */
const listeners = new Set<Listener>();
let wanted = 0;
let unlisten: Promise<() => void> | null = null;

export const audioLevelsAvailable = isNative;

export function subscribeLevels(listener: Listener): () => void {
  if (!isNative) return () => {};
  listeners.add(listener);
  wanted++;
  if (wanted === 1) {
    unlisten = listen<Levels>("audio://levels", (e) => listeners.forEach((l) => l(e.payload)));
    void invoke("audio_levels", { enabled: true });
  }
  return () => {
    listeners.delete(listener);
    wanted--;
    if (wanted === 0) {
      void invoke("audio_levels", { enabled: false });
      void unlisten?.then((f) => f());
      unlisten = null;
    }
  };
}
