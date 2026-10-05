import { createStore } from "../lib/store";
import { onFocusExit, setPassthrough } from "../platform/native";

/*
 * Focus mode: the notch stays visible but half transparent and fully click-through,
 * so clicks reach the app below (e.g. browser tabs at the very top).
 * In and out: three quick clicks on the notch (or the header button).
 * Natively Rust counts the clicks, because the window no longer gets any.
 */
export const focusMode = createStore(false, { persist: "focus-mode" });

/** This many quick clicks toggle it (like EXIT_CLICKS in hit_test.rs). */
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
