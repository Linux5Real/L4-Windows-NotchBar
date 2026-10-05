import type { Transition } from "motion/react";

/*
 * Bewegungs-Presets. Jede Animation in der App nutzt eines davon —
 * keine Inline-Werte in Komponenten. Begründungen: docs/DESIGN.md → Bewegung.
 *
 * Springs im Apple-Stil (visualDuration + bounce) statt stiffness/damping:
 * leichter zu lesen und entspricht SwiftUIs .spring(duration:bounce:).
 */

// ?slow=4 in der URL verlangsamt alle Springs zum Feintuning.
const slow = Number(new URLSearchParams(location.search).get("slow")) || 1;

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function spring(visualDuration: number, bounce: number): Transition {
  if (reduceMotion) return { type: "spring", visualDuration: 0.2 * slow, bounce: 0 };
  return { type: "spring", visualDuration: visualDuration * slow, bounce };
}

export const springs = {
  /** Notch öffnet sich: lebendig, merklicher aber kurzer Überschwinger. */
  open: spring(0.42, 0.24),
  /** Notch schließt sich: schneller als Öffnen, kein Bounce (asymmetrisch). */
  close: spring(0.32, 0.04),
  /** Hover-Anstupsen: klein und verspielt, bestätigt "ich hab dich gesehen". */
  peek: spring(0.26, 0.32),
  /** Formwechsel bei offener Notch (Tab-Wechsel, Live-Aktivität). */
  morph: spring(0.36, 0.14),
  /** Kleine Elemente innerhalb (Tab-Pille, Toggles). */
  snappy: spring(0.24, 0.12),
} as const;

const easeOut = [0.23, 1, 0.32, 1] as const;

/** Kurzes Ein-/Ausblenden für Overlays ("Kopiert", Status-Wechsel). */
export const fade = { duration: 0.16 * slow, ease: easeOut } satisfies Transition;

/** Überblenden großer Flächen (Cover, Diagramme) — etwas ruhiger. */
export const crossfade = { duration: 0.4 * slow, ease: "easeInOut" } satisfies Transition;

/** Menüs/Popover: schnell rein, noch schneller raus. */
export const popover = {
  enter: { duration: 0.16 * slow, ease: easeOut },
  exit: { duration: 0.1 * slow, ease: easeOut },
} satisfies Record<string, Transition>;

/** Dauerdrehung für "lädt" (Aktualisieren-Symbol). */
export const spin = { repeat: Infinity, duration: 0.9, ease: "linear" } satisfies Transition;

/** Ruhiges Pulsieren für "klingelt gerade" (Opacity hin und her). */
export const pulse = { repeat: Infinity, repeatType: "reverse", duration: 0.7, ease: "easeInOut" } satisfies Transition;

/** Inhalt erscheint, nachdem die Form losgelaufen ist; verschwindet sofort. */
export const content = {
  enter: {
    duration: 0.24 * slow,
    delay: 0.05 * slow,
    ease: [0.23, 1, 0.32, 1],
  } satisfies Transition,
  exit: {
    duration: 0.12 * slow,
    ease: [0.23, 1, 0.32, 1],
  } satisfies Transition,
} as const;
