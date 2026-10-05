import { useEffect, useState } from "react";
import { createStore } from "../../lib/store";
import { playAlarm, stopAlarm } from "../../lib/sound";
import { settings } from "../../settings/store";

export type TimerMode = "focus" | "break";

interface TimerState {
  mode: TimerMode;
  /** Gesamtdauer in Sekunden. */
  duration: number;
  /** Zeitstempel (Date.now()) des Endes, wenn er läuft. */
  endsAt: number | null;
  /** Verbleibende Sekunden, wenn pausiert. */
  remaining: number;
  /** Abgelaufen: bleibt stehen, bis der Nutzer schließt (Timer-Ansicht + Live-Aktivität zeigen es). */
  finished: boolean;
  /** Zuletzt eingestellte eigene Dauer pro Modus (Sekunden), erscheint als eigener Chip. */
  custom?: Partial<Record<TimerMode, number>>;
}

/** Grenzen für eigene Zeiten (Minuten). */
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 180;

export const presets: Record<TimerMode, number[]> = {
  focus: [15 * 60, 25 * 60, 45 * 60],
  break: [5 * 60, 10 * 60, 15 * 60],
};

const initial: TimerState = { mode: "focus", duration: 25 * 60, endsAt: null, remaining: 25 * 60, finished: false };

// Persistiert: ein laufender Timer überlebt einen Neustart der App.
export const timer = createStore<TimerState>(initial, { persist: "timer" });

/** Klingelt der Alarm gerade? Nicht persistiert — nach Neustart klingelt nichts mehr. */
export const ringing = createStore(false);

export function remainingOf(s: TimerState, now = Date.now()): number {
  if (s.endsAt === null) return s.remaining;
  return Math.max(0, (s.endsAt - now) / 1000);
}

export const timerActions = {
  /** Nur den Ton stoppen; "abgelaufen" bleibt sichtbar. */
  silence() {
    stopAlarm();
    window.clearTimeout(ringTimeout);
    ringing.set(false);
  },
  /** Abgelaufenen Timer schließen: nach Fokus ist eine kurze Pause vorbereitet (nicht gestartet). */
  dismiss() {
    timerActions.silence();
    timer.set((s) => {
      if (!s.finished) return s;
      const mode: TimerMode = s.mode === "focus" ? "break" : "focus";
      const duration = s.custom?.[mode] ?? (mode === "break" ? presets.break[0] : presets.focus[1]);
      return { ...s, mode, duration, remaining: duration, endsAt: null, finished: false };
    });
  },
  start() {
    timerActions.silence();
    timer.set((s) => ({ ...s, endsAt: Date.now() + s.remaining * 1000, finished: false }));
  },
  pause() {
    timer.set((s) => ({ ...s, remaining: remainingOf(s), endsAt: null }));
  },
  reset() {
    timer.set((s) => ({ ...s, remaining: s.duration, endsAt: null, finished: false }));
  },
  select(mode: TimerMode, duration: number) {
    timerActions.silence();
    timer.set((s) => ({ ...s, mode, duration, remaining: duration, endsAt: null, finished: false }));
  },
  /** Eigene Dauer setzen; Werte außerhalb der Presets werden als eigener Chip gemerkt. */
  setMinutes(minutes: number) {
    const m = Math.round(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes)));
    timer.set((s) => {
      const duration = m * 60;
      const custom = presets[s.mode].includes(duration) ? s.custom : { ...s.custom, [s.mode]: duration };
      return { ...s, duration, remaining: duration, endsAt: null, finished: false, custom };
    });
  },
};

// Ablauf überwachen (eine Stelle für die ganze App).
let ringTimeout: number | undefined;
setInterval(() => {
  const s = timer.get();
  if (s.endsAt !== null && remainingOf(s) <= 0) {
    const { sound, volume, duration: ring } = settings.get().alarm;
    playAlarm(sound, volume, ring);
    timer.set((t) => ({ ...t, remaining: 0, endsAt: null, finished: true }));
    ringing.set(true);
    window.clearTimeout(ringTimeout);
    // Gleiche Länge wie in playAlarm ("bis Stopp" = höchstens 2 min).
    ringTimeout = window.setTimeout(() => ringing.set(false), (ring === -1 ? 120 : Math.max(3, ring)) * 1000);
  }
}, 250);

/** Verbleibende Sekunden, aktualisiert jede Sekunde-Grenze. */
export function useRemaining(): number {
  const s = timer.use();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (s.endsAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [s.endsAt]);
  return remainingOf(s, now);
}

export function formatClock(seconds: number): string {
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
