import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Läuft das Frontend in der Tauri-App (statt im normalen Browser)? */
export const isNative = "__TAURI_INTERNALS__" in window;

/** Trefferzone in CSS-px relativ zum Fenster an Rust melden (Klick-Durchlass). */
export function setHitRect(rect: { x: number; y: number; w: number; h: number }) {
  if (isNative) void invoke("set_hit_rect", { rect });
}

/** Fenster klickbar halten, auch wenn die Maus außerhalb ist (z. B. beim Tippen). */
export function setPinned(pinned: boolean) {
  if (isNative) void invoke("set_pinned", { pinned });
}

/** Maus über der Trefferzone — kommt aus dem Rust-Poll statt aus DOM-Events. */
export function onNativeHover(handler: (inside: boolean) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<boolean>("notch://hover", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/** Fenster verliert den Fokus (Klick in eine andere App). */
export function onNativeBlur(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => !focused && handler());
  return () => void off.then((f) => f());
}

/** Globales Tastenkürzel (Strg+Alt+Leertaste) wurde gedrückt. */
export function onShortcut(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = listen("notch://shortcut", handler);
  return () => void off.then((f) => f());
}

/** Tray: Linksklick / "Notch öffnen" (tab = null) bzw. "Einstellungen" (tab = "settings"). */
export function onTrayOpen(handler: (tab: string | null) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<string | null>("notch://open", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/**
 * true: Fenster holt den Tastaturfokus (nach Öffnen per Kürzel).
 * false: Fokus geht an die vorherige App zurück, falls wir ihn noch haben.
 */
export function keyboardFocus(focus: boolean) {
  if (isNative) void invoke("keyboard_focus", { focus });
}

/** Fokus-Modus: Fenster komplett klick-durchlässig (Rust zählt nur Klicks zum Verlassen). */
export function setPassthrough(on: boolean) {
  if (isNative) void invoke("set_passthrough", { on });
}

/** Drei schnelle Klicks auf die Notch im Fokus-Modus. */
export function onFocusExit(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = listen("notch://focus-exit", handler);
  return () => void off.then((f) => f());
}
