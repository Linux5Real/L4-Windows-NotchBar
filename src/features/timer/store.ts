import { useEffect, useState } from "react";
import { createStore } from "../../lib/store";
import { playAlarm, stopAlarm } from "../../lib/sound";
import { settings } from "../../settings/store";

export type TimerMode = "focus" | "break";

interface TimerState {
  mode: TimerMode;
  /** Total duration in seconds. */
  duration: number;
  /** End timestamp (Date.now()) while running. */
  endsAt: number | null;
  /** Remaining seconds while paused. */
  remaining: number;
  /** Finished: stays until the user dismisses it (timer view + live activity show it). */
  finished: boolean;
  /** Last custom duration per mode (seconds), shown as its own chip. */
  custom?: Partial<Record<TimerMode, number>>;
}

/** Limits for custom times (minutes). */
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 180;

export const presets: Record<TimerMode, number[]> = {
  focus: [15 * 60, 25 * 60, 45 * 60],
  break: [5 * 60, 10 * 60, 15 * 60],
};

const initial: TimerState = { mode: "focus", duration: 25 * 60, endsAt: null, remaining: 25 * 60, finished: false };

// Persisted: a running timer survives an app restart.
export const timer = createStore<TimerState>(initial, { persist: "timer" });

/** Is the alarm ringing right now? Not persisted, nothing rings after a restart. */
export const ringing = createStore(false);

export function remainingOf(s: TimerState, now = Date.now()): number {
  if (s.endsAt === null) return s.remaining;
  return Math.max(0, (s.endsAt - now) / 1000);
}

export const timerActions = {
  /** Only stop the sound; "finished" stays visible. */
  silence() {
    stopAlarm();
    window.clearTimeout(ringTimeout);
    ringing.set(false);
  },
  /** Dismiss a finished timer: after focus a short break is prepared (not started). */
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
  /** Sets a custom duration; values outside the presets are remembered as their own chip. */
  setMinutes(minutes: number) {
    const m = Math.round(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes)));
    timer.set((s) => {
      const duration = m * 60;
      const custom = presets[s.mode].includes(duration) ? s.custom : { ...s.custom, [s.mode]: duration };
      return { ...s, duration, remaining: duration, endsAt: null, finished: false, custom };
    });
  },
};

// Watch for the end (one place for the whole app): one timeout at `endsAt`, no
// polling while nothing runs.
let ringTimeout: number | undefined;
let endTimeout: number | undefined;
let scheduledFor: number | null = null;

function checkEnd() {
  const s = timer.get();
  if (s.endsAt !== null && remainingOf(s) <= 0) {
    const { sound, volume, duration: ring } = settings.get().alarm;
    playAlarm(sound, volume, ring);
    timer.set((t) => ({ ...t, remaining: 0, endsAt: null, finished: true }));
    ringing.set(true);
    window.clearTimeout(ringTimeout);
    // Same length as in playAlarm ("until stopped" = at most 2 min).
    ringTimeout = window.setTimeout(() => ringing.set(false), (ring === -1 ? 120 : Math.max(3, ring)) * 1000);
  }
}

function scheduleEnd() {
  const { endsAt } = timer.get();
  if (endsAt === scheduledFor) return;
  window.clearTimeout(endTimeout);
  scheduledFor = endsAt;
  if (endsAt === null) return;
  endTimeout = window.setTimeout(() => {
    scheduledFor = null;
    checkEnd();
    // Woke too early (clock change): try again.
    scheduleEnd();
  }, Math.max(0, endsAt - Date.now()));
}
timer.subscribe(scheduleEnd);
scheduleEnd();

/** Remaining seconds, updated on every second boundary. */
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
