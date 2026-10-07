import type { MediaSource, NowPlaying } from "./types";
import { livePosition } from "./types";
import { showcase, showcaseStartPosition, showcaseTracks } from "../../dev/showcase-data";

// Generated SVG covers so the prototype needs no external images.
function cover(a: string, b: string, c: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs>
      <radialGradient id="g" cx="30%" cy="25%" r="90%">
        <stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/>
      </radialGradient>
    </defs>
    <rect width="100" height="100" fill="url(#g)"/>
    <circle cx="68" cy="70" r="22" fill="${a}" opacity="0.35"/>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const defaultTracks: Omit<NowPlaying, "isPlaying" | "position" | "updatedAt" | "canSeek">[] = [
  {
    title: "Midnight City",
    artist: "M83",
    artwork: cover("#ff7ac6", "#7b3fe4", "#1b0b3a"),
    accent: "#e07bff",
    duration: 243,
  },
  {
    title: "Tadow",
    artist: "Masego, FKJ",
    artwork: cover("#ffd27a", "#e8642c", "#3a1206"),
    accent: "#ff9f5a",
    duration: 301,
  },
  {
    title: "Blinding Lights",
    artist: "The Weeknd",
    artwork: cover("#7affd8", "#1f8fa8", "#04202a"),
    accent: "#5ce1e6",
    duration: 200,
  },
];

const tracks = showcase ? showcaseTracks : defaultTracks;

export function createMockMedia(): MediaSource {
  let index = 0;
  // Showcase starts paused, so the video can open on an idle notch.
  let state: NowPlaying = showcase
    ? { ...tracks[0], isPlaying: false, position: showcaseStartPosition, canSeek: true, updatedAt: performance.now() }
    : { ...tracks[0], isPlaying: true, position: 42, canSeek: true, updatedAt: performance.now() };
  const listeners = new Set<() => void>();

  const set = (patch: Partial<NowPlaying>) => {
    state = { ...state, ...patch, updatedAt: performance.now() };
    listeners.forEach((l) => l());
  };

  const load = (i: number) => {
    index = (i + tracks.length) % tracks.length;
    set({ ...tracks[index], position: 0, isPlaying: true });
  };

  // Simulate the end of a track.
  setInterval(() => {
    if (state.isPlaying && livePosition(state) >= state.duration) load(index + 1);
  }, 1000);

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle: () => set({ position: livePosition(state), isPlaying: !state.isPlaying }),
    next: () => load(index + 1),
    previous: () => (livePosition(state) > 3 ? set({ position: 0 }) : load(index - 1)),
    seek: (position) => set({ position: Math.max(0, Math.min(state.duration, position)) }),
    openSource: () => {
      console.info("[media] would bring the source app to the front");
      return Promise.resolve(true);
    },
  };
}
