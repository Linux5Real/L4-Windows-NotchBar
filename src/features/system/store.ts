import { createStore } from "../../lib/store";
import { fetchSystem, type SystemStats } from "../../platform/services";
import { settings } from "../../settings/store";

/** 60 values = one minute of history at one poll per second. */
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
 */
export const system = createStore<SystemState>({ stats: null, history: { cpu: [], mem: [], gpu: [], ping: [] }, tick: 0 });

let timer: ReturnType<typeof setInterval> | null = null;

function poll() {
  void fetchSystem().then((next) => {
    const push = (h: number[], v: number | null) => [...h, v ?? Number.NaN].slice(-HISTORY);
    system.set(({ history: h, tick }) => ({
      stats: next,
      tick: tick + 1,
      history: {
        cpu: push(h.cpu, next.cpu),
        mem: push(h.mem, (next.memUsed / next.memTotal) * 100),
        gpu: push(h.gpu, next.gpu),
        ping: push(h.ping, next.ping),
      },
    }));
  });
}

function wanted(): boolean {
  const s = settings.get();
  return s.tools.some((x) => x.id === "system" && x.enabled) || s.gaming.mode !== "off";
}

export function startSystemPolling() {
  const apply = () => {
    if (wanted() && !timer) {
      poll();
      timer = setInterval(poll, 1000);
    } else if (!wanted() && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  apply();
  settings.subscribe(apply);
}
