import { createStore } from "../../lib/store";
import { fetchSystem, type SystemStats } from "../../platform/services";
import { settings } from "../../settings/store";

/** 60 Werte = eine Minute Verlauf bei 1 Abfrage/s. */
export const HISTORY = 60;

export type SystemKey = "cpu" | "mem" | "gpu" | "ping";

export interface SystemState {
  stats: SystemStats | null;
  history: Record<SystemKey, number[]>;
  /** Zählt die Abfragen (startet die Gleit-Animation des Verlaufs neu). */
  tick: number;
}

/**
 * Läuft ab App-Start im Hintergrund (nicht erst, wenn das Tool offen ist) — so ist der
 * Verlauf beim Öffnen schon eine Minute lang, und der Gaming-Modus nutzt dieselben Werte.
 * Pausiert nur, wenn weder Hardware-Tool noch Gaming-Modus aktiv sind.
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
