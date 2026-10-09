import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "../native";
import { showcase, showcaseClips } from "../../dev/showcase-data";

export interface ClipItem {
  id: number;
  kind: "text" | "link" | "image" | "files";
  /** Text, link, "1920 × 1080" for images, file names (one per line) for files. */
  text: string;
  thumbnail: string | null;
  /** Files: how many entries are folders. */
  folders: number;
  /** Unix time in ms. */
  copiedAt: number;
}

/** all = clipboard tool on, text = only Ask needs the latest text, off = neither. */
export type ClipboardMode = "all" | "text" | "off";

export interface ClipPreview {
  src: string;
  width: number;
  height: number;
}

interface ClipboardSource {
  get(): ClipItem[];
  /** Large image preview (images and copied image files). */
  preview(id: number): Promise<ClipPreview | null>;
  subscribe(listener: () => void): () => void;
  copy(id: number): Promise<void>;
  remove(id: number): void;
  clear(): void;
  /** What gets recorded (from the enabled tools); drops entries the mode doesn't keep. */
  mode(mode: ClipboardMode): void;
}

function createNative(): ClipboardSource {
  let items: ClipItem[] = [];
  const listeners = new Set<() => void>();
  const set = (next: ClipItem[]) => {
    items = next;
    listeners.forEach((l) => l());
  };
  void invoke<ClipItem[]>("clipboard_list").then(set);
  void listen<ClipItem[]>("clipboard://update", (e) => set(e.payload));

  return {
    get: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    copy: (id) => invoke("clipboard_copy", { id }),
    preview: (id) => invoke<ClipPreview | null>("clipboard_preview", { id }),
    remove: (id) => void invoke("clipboard_delete", { id }),
    clear: () => void invoke("clipboard_clear"),
    mode: (mode) => void invoke("clipboard_mode", { mode }),
  };
}

// Sample data for the browser prototype.
function createMock(): ClipboardSource {
  const now = Date.now();
  let items: ClipItem[] = showcase ? showcaseClips.map(({ age, ...c }) => ({ ...c, copiedAt: now - age })) : [
    { id: 7, kind: "image", text: "1600 × 1000", thumbnail: demoImage(1600, 1000), folders: 0, copiedAt: now - 5_000 },
    { id: 8, kind: "image", text: "900 × 1400", thumbnail: demoImage(900, 1400), folders: 0, copiedAt: now - 60_000 },
    { id: 1, kind: "link", text: "https://github.com/Lakr233/NotchDrop", thumbnail: null, folders: 0, copiedAt: now - 20_000 },
    { id: 2, kind: "text", text: "Die letzten 10 % Feinschliff kosten die meiste Zeit.", thumbnail: null, folders: 0, copiedAt: now - 120_000 },
    { id: 3, kind: "files", text: "Rechnung-Oktober.pdf\nVertrag.docx", thumbnail: null, folders: 0, copiedAt: now - 840_000 },
    { id: 4, kind: "files", text: "Projekte", thumbnail: null, folders: 1, copiedAt: now - 1_800_000 },
    { id: 5, kind: "text", text: "SpringVector3NaturalMotionAnimation", thumbnail: null, folders: 0, copiedAt: now - 3_600_000 },
    { id: 6, kind: "text", text: "npm run tauri dev", thumbnail: null, folders: 0, copiedAt: now - 7_200_000 },
  ];
  const listeners = new Set<() => void>();
  const set = (next: ClipItem[]) => {
    items = next;
    listeners.forEach((l) => l());
  };
  return {
    get: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async copy(id) {
      const item = items.find((i) => i.id === id);
      if (item) set([{ ...item, copiedAt: Date.now() }, ...items.filter((i) => i.id !== id)]);
    },
    async preview(id) {
      const item = items.find((i) => i.id === id);
      const [w, h] = item?.text.split(" × ").map(Number) ?? [];
      return item?.thumbnail && w ? { src: item.thumbnail, width: w, height: h } : null;
    },
    remove: (id) => set(items.filter((i) => i.id !== id)),
    clear: () => set([]),
    mode(mode) {
      const keep = (i: ClipItem) => mode === "all" || (mode === "text" && (i.kind === "text" || i.kind === "link"));
      if (items.some((i) => !keep(i))) set(items.filter(keep));
    },
  };
}

/** Browser prototype: generated image in the requested aspect ratio. */
function demoImage(w: number, h: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a5a"/><stop offset="0.5" stop-color="#c2417a"/><stop offset="1" stop-color="#2a1b5e"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.35}" r="${Math.min(w, h) * 0.18}" fill="#ffd27a" opacity="0.85"/>
    <path d="M0 ${h * 0.78} Q ${w * 0.3} ${h * 0.6} ${w * 0.55} ${h * 0.75} T ${w} ${h * 0.7} V ${h} H 0 Z" fill="#1b0f33" opacity="0.8"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const clipboard: ClipboardSource = isNative ? createNative() : createMock();

export function useClipboard(): ClipItem[] {
  return useSyncExternalStore(clipboard.subscribe, clipboard.get);
}
