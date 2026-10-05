export interface NowPlaying {
  title: string;
  artist: string;
  /** Cover image URL (in the app: data URL from the GSMTC thumbnail). */
  artwork: string | null;
  /** Accent color from the cover, drives the equalizer & progress bar. */
  accent: string;
  isPlaying: boolean;
  /** Position in seconds at `updatedAt` (ms, performance.now()). */
  position: number;
  /** Seconds; 0 = unknown (live stream, some browser players). */
  duration: number;
  /** Does the source allow seeking? */
  canSeek: boolean;
  updatedAt: number;
}

/**
 * Bridge to the media source. A mock in the browser, in Tauri the
 * Windows API GlobalSystemMediaTransportControls.
 */
export interface MediaSource {
  get(): NowPlaying | null;
  subscribe(listener: () => void): () => void;
  toggle(): void;
  next(): void;
  previous(): void;
  /** Seeks to `position` seconds. */
  seek(position: number): void;
}

/** Current playback position, extrapolated from the last state. */
export function livePosition(np: NowPlaying, now = performance.now()): number {
  if (!np.isPlaying) return np.position;
  const pos = np.position + (now - np.updatedAt) / 1000;
  return np.duration > 0 ? Math.min(np.duration, pos) : pos;
}
