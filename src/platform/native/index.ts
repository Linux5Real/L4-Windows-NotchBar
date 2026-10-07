import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Is the frontend running in the Tauri app (rather than a regular browser)? */
export const isNative = "__TAURI_INTERNALS__" in window;

/** Reports the hit zone in CSS px relative to the window to Rust (click-through). */
export function setHitRect(rect: { x: number; y: number; w: number; h: number }) {
  if (isNative) void invoke("set_hit_rect", { rect });
}

/** Keeps the window clickable even when the cursor is outside (e.g. while typing). */
export function setPinned(pinned: boolean) {
  if (isNative) void invoke("set_pinned", { pinned });
}

/** Cursor over the hit zone; comes from the Rust poll instead of DOM events. */
export function onNativeHover(handler: (inside: boolean) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<boolean>("notch://hover", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/** Window lost focus (click into another app). */
export function onNativeBlur(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => !focused && handler());
  return () => void off.then((f) => f());
}

/** Global shortcut (Ctrl+Alt+Space) was pressed. */
export function onShortcut(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = listen("notch://shortcut", handler);
  return () => void off.then((f) => f());
}

/** Tray: left click / "Open" (tab = null) or "Settings" (tab = "settings"). */
export function onTrayOpen(handler: (tab: string | null) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<string | null>("notch://open", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/**
 * true: the window takes keyboard focus (after opening via shortcut).
 * false: focus goes back to the previous app if we still have it.
 */
export function keyboardFocus(focus: boolean) {
  if (isNative) void invoke("keyboard_focus", { focus });
}

/** Focus mode: window fully click-through (Rust only counts clicks to exit). */
export function setPassthrough(on: boolean) {
  if (isNative) void invoke("set_passthrough", { on });
}

/** Mirrors focus mode into the tray menu's check item. */
export function syncFocusTray(on: boolean) {
  if (isNative) void invoke("tray_focus", { on });
}

/** Focus mode switched from the tray menu. */
export function onFocusFromTray(handler: (on: boolean) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<boolean>("notch://focus-set", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/** Three quick clicks on the notch in focus mode. */
export function onFocusExit(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = listen("notch://focus-exit", handler);
  return () => void off.then((f) => f());
}
