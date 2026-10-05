import { useCallback, useEffect, useRef, useState } from "react";
import { createStore } from "../lib/store";
import { setPinned } from "../platform/native";
import { hoverDelayMs, settings } from "../settings/store";

export type NotchStatus = "closed" | "peek" | "open";

/** Verzögerungen in ms. Die Hover-Verzögerung kommt aus den Einstellungen. */
export const timing = {
  /** Gnadenfrist beim Verlassen, damit kurzes Abrutschen nicht schließt. */
  leaveClose: 180,
};

/*
 * "Festhalten": Solange gezogen wird (Spulen, später Drag & Drop), bleibt die Notch
 * offen und klickbar, auch wenn die Maus sie kurz verlässt. Zähler, damit mehrere
 * Stellen gleichzeitig festhalten können.
 */
const holds = createStore(0);

export function holdOpen(on: boolean) {
  holds.set((n) => Math.max(0, n + (on ? 1 : -1)));
  setPinned(holds.get() > 0);
}

/*
 * Pinnadel (oben rechts): Die Notch bleibt offen, auch wenn die Maus sie verlässt oder
 * eine andere App den Fokus bekommt — z. B. um Dateien aus dem Explorer zu ziehen oder
 * einen Schlüssel aus dem Browser zu kopieren. Anders als `holdOpen` bleibt das Fenster
 * außerhalb der Notch klick-durchlässig. Esc / Tastenkürzel schließen und lösen sie.
 */
export const pinned = createStore(false);

export function togglePin() {
  pinned.set((p) => !p);
}

/**
 * Zustandsautomat der Notch:
 *
 *   closed ──hover──▶ peek ──hover gehalten / Klick──▶ open
 *     ▲                 │                               │
 *     └────verlassen────┘◀──verlassen (Gnadenfrist) / Esc / Klick außerhalb
 *
 *   Tastenkürzel: closed ⇄ open direkt, ohne Peek und ohne Verzögerung.
 *   Beim Tippen, Festhalten oder mit Pinnadel schließt Verlassen nicht.
 *
 *   close()   bewusst schließen (Esc, Tastenkürzel) — löst auch die Pinnadel.
 *   dismiss() beiläufig schließen (Klick außerhalb, Fokusverlust) — nicht, wenn gepinnt.
 */
export function useNotchState() {
  const [status, setStatusState] = useState<NotchStatus>("closed");
  const statusRef = useRef<NotchStatus>("closed");
  const hovering = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const setStatus = useCallback((s: NotchStatus) => {
    statusRef.current = s;
    setStatusState(s);
  }, []);

  const later = useCallback(
    (ms: number, s: NotchStatus) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus(s), ms);
    },
    [setStatus],
  );

  const open = useCallback(() => {
    window.clearTimeout(timer.current);
    setStatus("open");
  }, [setStatus]);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    pinned.set(false);
    setStatus("closed");
  }, [setStatus]);

  const dismiss = useCallback(() => {
    if (pinned.get()) return;
    window.clearTimeout(timer.current);
    setStatus("closed");
  }, [setStatus]);

  /** Für das Tastenkürzel: ohne Peek direkt auf/zu. Gibt den neuen Zustand zurück. */
  const toggle = useCallback((): NotchStatus => {
    if (statusRef.current === "open") {
      close();
      return "closed";
    }
    open();
    return "open";
  }, [open, close]);

  const onPointerEnter = useCallback(() => {
    hovering.current = true;
    window.clearTimeout(timer.current);
    if (statusRef.current === "closed") {
      setStatus("peek");
      // Modus "Klick": nur anstupsen, öffnen erst per Klick.
      const s = settings.get();
      if (s.openMode === "hover") later(hoverDelayMs[s.hoverDelay], "open");
    }
  }, [setStatus, later]);

  const onPointerLeave = useCallback(() => {
    hovering.current = false;
    window.clearTimeout(timer.current);
    if (statusRef.current === "peek") setStatus("closed");
    else if (statusRef.current === "open" && mayAutoClose()) later(timing.leaveClose, "closed");
  }, [setStatus, later]);

  // Festhalten vorbei und Maus ist draußen → jetzt das verpasste Verlassen nachholen.
  useEffect(
    () =>
      holds.subscribe(() => {
        if (!hovering.current && statusRef.current === "open" && mayAutoClose()) {
          later(timing.leaveClose, "closed");
        }
      }),
    [later],
  );

  // Pinnadel gelöst und Maus ist draußen → jetzt schließen.
  useEffect(
    () =>
      pinned.subscribe(() => {
        if (!pinned.get() && !hovering.current && statusRef.current === "open" && mayAutoClose()) later(timing.leaveClose, "closed");
      }),
    [later],
  );

  // Esc schließt ohne Umweg.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer.current);
    };
  }, [close]);

  return { status, open, close, dismiss, toggle, onPointerEnter, onPointerLeave };
}

function mayAutoClose(): boolean {
  return !pinned.get() && holds.get() === 0 && !isEditing();
}

function isEditing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
