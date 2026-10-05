import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createStore } from "../lib/store";
import { isNative } from "./native";

/*
 * Quick drop: drag files from Explorer onto the notch.
 * A normal HTML5 drop everywhere. In the app WebView2 hands the `File` objects to Rust
 * (`src-tauri/src/drop.rs`), which sends back real paths; the browser only gets
 * file names (for design work).
 *
 * `dragging` drives the notch (opens to the converter), `dropped` holds the paths
 * the converter takes and then clears.
 */
export const drop = createStore<{ dragging: boolean; dropped: string[] | null }>({ dragging: false, dropped: null });

export function takeDropped(): string[] | null {
  const paths = drop.get().dropped;
  if (paths) drop.set((s) => ({ ...s, dropped: null }));
  return paths;
}

/**
 * Ctrl+V: files (or a copied image/screenshot) from the clipboard land in the active
 * tool just like a drop. Returns false if there was nothing suitable.
 */
export async function pasteFiles(): Promise<boolean> {
  const paths = isNative
    ? await invoke<string[]>("clipboard_paste_files").catch(() => [])
    : [`C:\\Users\\Demo\\Pictures\\Notch\\Eingefügt ${new Date().toLocaleTimeString("de-DE").replaceAll(":", "-")}.png`];
  if (paths.length === 0) return false;
  drop.set({ dragging: false, dropped: paths });
  return true;
}

/** Ctrl+V outside text fields → `pasteFiles`. For Shelf and Converter. */
export function usePasteFiles(onEmpty?: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.key.toLowerCase() === "v")) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      void pasteFiles().then((ok) => !ok && onEmpty?.());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEmpty]);
}

/** WebView2 bridge (app only). */
const webview = (window as { chrome?: { webview?: { postMessageWithAdditionalObjects(msg: string, objects: unknown[]): void } } }).chrome?.webview;

let started = false;

export function startDropListener() {
  if (started) return;
  started = true;

  if (isNative) void listen<string[]>("notch://drop", ({ payload }) => drop.set({ dragging: false, dropped: payload }));

  // HTML5 drag. Only files count, not selected text.
  let depth = 0;
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    drop.set((s) => ({ ...s, dragging: true }));
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) drop.set((s) => ({ ...s, dragging: false }));
  });
  window.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (webview) {
      // Paths come back asynchronously as "notch://drop".
      drop.set((s) => ({ ...s, dragging: false }));
      webview.postMessageWithAdditionalObjects("notch-drop", files);
      return;
    }
    drop.set({ dragging: false, dropped: files.map((f) => `C:\\Users\\Demo\\Downloads\\${f.name}`) });
  });
}
