import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { fetchSystem, type SystemStats } from "../../platform/services";
import { settings } from "../../settings/store";

/** 60 values = one minute of history at one value per second. */
export const HISTORY = 60;

export type SystemKey = "cpu" | "mem" | "gpu" | "ping";

export interface SystemState {
  stats: SystemStats | null;
  history: Record<SystemKey, number[]>;
  /** Counts polls (restarts the history's glide animation). */
  tick: number;
}

/**
 * Runs in the background from app start (not only while the tool is open), so the
 * history is a minute long when opened and gaming mode shares the same values.
 * Only pauses when neither the Hardware tool nor gaming mode is active.
 *
 * While shown (Hardware tool open, gaming overlay): everything once a second. In the
 * background: CPU and RAM every 3 s, filled in linearly so the history keeps one value
 * per second; GPU and ping stay gaps until shown (their counters are the expensive part).
 */
export const system = createStore<SystemState>({ stats: null, history: { cpu: [], mem: [], gpu: [], ping: [] }, tick: 0 });

const SHOWN_MS = 1000;
const BACKGROUND_MS = 3000;

let timer: ReturnType<typeof setInterval> | null = null;
let timerMs = 0;
/** Mounted views that show the values (see `useSystemShown`). */
const shown = createStore(0);

function poll() {
  const full = shown.get() > 0;
  void fetchSystem(full).then((next) => {
    const steps = full ? 1 : Math.round(BACKGROUND_MS / SHOWN_MS);
    system.set(({ stats, history: h, tick }) => {
      const mem = (next.memUsed / next.memTotal) * 100;
      // Linear from the previous value, so a slow poll still adds one value per second.
      const fill = (prev: number[], v: number) => {
        const from = prev.at(-1);
        if (steps === 1 || from === undefined || Number.isNaN(from)) return Array<number>(steps).fill(v);
        return Array.from({ length: steps }, (_, i) => from + ((v - from) * (i + 1)) / steps);
      };
      const push = (prev: number[], values: number[]) => [...prev, ...values].slice(-HISTORY);
      const gaps = Array<number>(steps).fill(Number.NaN);
      return {
        // Background: keep the last GPU/ping numbers for the first frame when opened.
        stats: full || !stats ? next : { ...next, gpu: stats.gpu, gpuMemUsed: stats.gpuMemUsed, ping: stats.ping },
        tick: tick + 1,
        history: {
          cpu: push(h.cpu, fill(h.cpu, next.cpu)),
          mem: push(h.mem, fill(h.mem, mem)),
          gpu: push(h.gpu, full ? [next.gpu ?? Number.NaN] : gaps),
          ping: push(h.ping, full ? [next.ping ?? Number.NaN] : gaps),
        },
      };
    });
  });
}

function wanted(): boolean {
  const s = settings.get();
  return s.tools.some((x) => x.id === "system" && x.enabled) || s.gaming.mode !== "off";
}

function apply() {
  const ms = shown.get() > 0 ? SHOWN_MS : BACKGROUND_MS;
  if (!wanted()) {
    if (timer) clearInterval(timer);
    timer = null;
    return;
  }
  if (timer && timerMs === ms) return;
  if (timer) clearInterval(timer);
  // Switching to shown: fresh values right away, not after the next tick.
  poll();
  timer = setInterval(poll, ms);
  timerMs = ms;
}

export function startSystemPolling() {
  apply();
  settings.subscribe(apply);
  shown.subscribe(apply);
}

/** For views that show the values: full polling once a second while mounted. */
export function useSystemShown() {
  useEffect(() => {
    shown.set((n) => n + 1);
    return () => shown.set((n) => n - 1);
  }, []);
}
