import type { Transition } from "motion/react";

/*
 * Motion presets. Every animation in the app uses one of these,
 * no inline values in components.
 *
 * Apple-style springs (visualDuration + bounce) instead of stiffness/damping:
 * easier to read and matches SwiftUI's .spring(duration:bounce:).
 */

// ?slow=4 in the URL slows all springs down for tuning.
const slow = Number(new URLSearchParams(location.search).get("slow")) || 1;

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function spring(visualDuration: number, bounce: number): Transition {
  if (reduceMotion) return { type: "spring", visualDuration: 0.2 * slow, bounce: 0 };
  return { type: "spring", visualDuration: visualDuration * slow, bounce };
}

export const springs = {
  /** Notch opens: lively, a noticeable but short overshoot. */
  open: spring(0.42, 0.24),
  /** Notch closes: faster than opening, no bounce. */
  close: spring(0.32, 0.04),
  /** Hover nudge: small and playful, says "I see you". */
  peek: spring(0.26, 0.32),
  /** Shape change while open (tab switch, live activity). */
  morph: spring(0.36, 0.14),
  /** Small elements inside (tab pill, toggles). */
  snappy: spring(0.24, 0.12),
} as const;

const easeOut = [0.23, 1, 0.32, 1] as const;

/** Quick fade for overlays ("Copied", status changes). */
export const fade = { duration: 0.16 * slow, ease: easeOut } satisfies Transition;

/** Crossfade for large areas (covers, charts), a bit calmer. */
export const crossfade = { duration: 0.4 * slow, ease: "easeInOut" } satisfies Transition;

/**
 * Cover swap: the new image fades in on top, the old one leaves a beat later, so
 * there is never a gap or a hard cut (same calm pace as the accent color).
 */
export const artwork = {
  enter: { duration: 0.45 * slow, ease: "easeInOut" } satisfies Transition,
  exit: { duration: 0.35 * slow, delay: 0.2 * slow, ease: "easeInOut" } satisfies Transition,
} as const;

/** Menus/popovers: fast in, even faster out. */
export const popover = {
  enter: { duration: 0.16 * slow, ease: easeOut },
  exit: { duration: 0.1 * slow, ease: easeOut },
} satisfies Record<string, Transition>;

/** Continuous spin for "loading" (refresh icon). */
export const spin = { repeat: Infinity, duration: 0.9, ease: "linear" } satisfies Transition;

/** Calm pulse for "ringing" (opacity back and forth). */
export const pulse = { repeat: Infinity, repeatType: "reverse", duration: 0.7, ease: "easeInOut" } satisfies Transition;

/** Content appears after the shape starts moving; disappears immediately. */
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

/** "Wrong" (PIN): a short, damped side-to-side shake like the macOS login field. */
export const shake = {
  keyframes: ["translateX(0px)", "translateX(-9px)", "translateX(7px)", "translateX(-5px)", "translateX(3px)", "translateX(0px)"],
  transition: { duration: 0.38 * slow, ease: "easeOut" } satisfies Transition,
} as const;

/** Countdowns that step once per second (2FA ring): linear, exactly one tick long. */
export const tick = { duration: 1, ease: "linear" } satisfies Transition;
