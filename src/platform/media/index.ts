import { useSyncExternalStore } from "react";
import { isNative } from "../native";
import { createMockMedia } from "./mock";
import { createNativeMedia } from "./native";
import type { MediaSource } from "./types";

export type { NowPlaying } from "./types";
export { livePosition } from "./types";

// In der App: Windows-Medien (GSMTC). Im Browser: Beispieldaten zum Gestalten.
export const media: MediaSource = isNative ? createNativeMedia() : createMockMedia();

export function useNowPlaying() {
  return useSyncExternalStore(media.subscribe, media.get);
}
