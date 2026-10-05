export interface NowPlaying {
  title: string;
  artist: string;
  /** Bild-URL des Covers (in der App: Data-URL aus dem GSMTC-Thumbnail). */
  artwork: string | null;
  /** Akzentfarbe aus dem Cover, steuert Equalizer & Fortschrittsbalken. */
  accent: string;
  isPlaying: boolean;
  /** Position in Sekunden zum Zeitpunkt `updatedAt` (ms, performance.now()). */
  position: number;
  /** Sekunden; 0 = unbekannt (Livestream, manche Browser-Player). */
  duration: number;
  /** Erlaubt die Quelle Spulen? */
  canSeek: boolean;
  updatedAt: number;
}

/**
 * Brücke zur Medienquelle. Im Browser ein Mock, in Tauri die
 * Windows-API GlobalSystemMediaTransportControls (siehe docs/ARCHITECTURE.md).
 */
export interface MediaSource {
  get(): NowPlaying | null;
  subscribe(listener: () => void): () => void;
  toggle(): void;
  next(): void;
  previous(): void;
  /** Springt zu `position` Sekunden. */
  seek(position: number): void;
}

/** Aktuelle Wiedergabeposition, aus dem letzten Stand hochgerechnet. */
export function livePosition(np: NowPlaying, now = performance.now()): number {
  if (!np.isPlaying) return np.position;
  const pos = np.position + (now - np.updatedAt) / 1000;
  return np.duration > 0 ? Math.min(np.duration, pos) : pos;
}
