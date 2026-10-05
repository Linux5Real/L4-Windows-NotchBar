import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createStore } from "../lib/store";
import { isNative } from "./native";

/*
 * Quick Drop: Dateien aus dem Explorer auf die Notch ziehen.
 * Überall ein normales HTML5-Drop. In der App reicht WebView2 die `File`-Objekte an Rust
 * weiter (`src-tauri/src/drop.rs`), das echte Pfade zurückschickt; im Browser gibt es nur
 * Dateinamen (zum Gestalten).
 *
 * `dragging` steuert die Notch (öffnet sich zum Converter), `dropped` sind die Pfade,
 * die der Converter übernimmt und danach leert.
 */
export const drop = createStore<{ dragging: boolean; dropped: string[] | null }>({ dragging: false, dropped: null });

export function takeDropped(): string[] | null {
  const paths = drop.get().dropped;
  if (paths) drop.set((s) => ({ ...s, dropped: null }));
  return paths;
}

/**
 * Strg+V: Dateien (oder ein kopiertes Bild/Screenshot) aus der Zwischenablage landen
 * genauso wie ein Drop im aktiven Tool. Gibt false zurück, wenn nichts Passendes drin war.
 */
export async function pasteFiles(): Promise<boolean> {
  const paths = isNative
    ? await invoke<string[]>("clipboard_paste_files").catch(() => [])
    : [`C:\\Users\\Demo\\Pictures\\Notch\\Eingefügt ${new Date().toLocaleTimeString("de-DE").replaceAll(":", "-")}.png`];
  if (paths.length === 0) return false;
  drop.set({ dragging: false, dropped: paths });
  return true;
}

/** Strg+V außerhalb von Textfeldern → `pasteFiles`. Für Ablage und Converter. */
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

/** WebView2-Brücke (nur in der App). */
const webview = (window as { chrome?: { webview?: { postMessageWithAdditionalObjects(msg: string, objects: unknown[]): void } } }).chrome?.webview;

let started = false;

export function startDropListener() {
  if (started) return;
  started = true;

  if (isNative) void listen<string[]>("notch://drop", ({ payload }) => drop.set({ dragging: false, dropped: payload }));

  // HTML5-Drag. Nur Dateien zählen, keine markierten Texte.
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
      // Pfade kommen asynchron als "notch://drop" zurück.
      drop.set((s) => ({ ...s, dragging: false }));
      webview.postMessageWithAdditionalObjects("notch-drop", files);
      return;
    }
    drop.set({ dragging: false, dropped: files.map((f) => `C:\\Users\\Demo\\Downloads\\${f.name}`) });
  });
}
