import { useRef, useState } from "react";
import { display } from "../platform/services";
import { settings, updateSettings } from "../settings/store";
import { holdOpen, type NotchStatus } from "./useNotchState";

/** Erst ab so viel Weg ist es ein Ziehen statt ein Klick. */
const THRESHOLD = 6;
/** Nahe der Mitte rastet die Notch ein. */
const SNAP = 24;

/** Darstellung an Rust geben, optional mit einem Versatz, der noch nicht gespeichert ist. */
export function applyDisplay(offset = settings.get().display.offset) {
  const s = settings.get();
  display.apply({ hideFullscreen: s.display.visibility === "hide-fullscreen", monitor: s.display.monitor, offset, gaming: s.gaming.mode !== "off" });
}

/*
 * Notch seitlich verschieben: geschlossen überall greifen, offen an der Kopfzeile.
 * Nativ wird das Fenster selbst bewegt (display.rs, begrenzt auf den Monitor), im
 * Browser nur die Notch im Fenster. Gespeichert wird beim Loslassen.
 */
export function useDragToMove(status: NotchStatus) {
  const saved = settings.use().display.offset;
  const [live, setLive] = useState<number | null>(null);
  const moved = useRef(false);
  const offset = live ?? saved;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest("button, input, textarea, a, [role=slider], [data-no-drag]")) return;
    // Offen nur über die Kopfzeile, sonst würden Listen und Regler mitziehen.
    if (status === "open" && !target.closest("[data-drag-handle]")) return;

    const { pointerId: id, screenX: x } = e;
    const from = offset;
    let current = from;
    let frame = 0;
    moved.current = false;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const dx = ev.screenX - x;
      if (!moved.current && Math.abs(dx) < THRESHOLD) return;
      if (!moved.current) {
        moved.current = true;
        holdOpen(true);
      }
      current = Math.abs(from + dx) < SNAP ? 0 : Math.round(from + dx);
      setLive(current);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => applyDisplay(current));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved.current) return;
      holdOpen(false);
      updateSettings((cur) => ({ display: { ...cur.display, offset: current } }));
      setLive(null);
      // Der Klick direkt nach dem Loslassen soll nichts öffnen.
      setTimeout(() => (moved.current = false), 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return { offset, dragging: live !== null, onPointerDown, moved: () => moved.current };
}
