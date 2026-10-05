import { useEffect, useRef } from "react";
import { audioLevelsAvailable, subscribeLevels, type Levels } from "../../platform/audio";

/*
 * Four bars in the accent color, bass on the left, treble on the right.
 *
 * One animation loop for every state, so nothing ever switches hard:
 * - Playing + real levels (WASAPI loopback, ~40 values/s): bars follow the sound.
 * - Silence on track change or seek: gentle "breathing" instead of dropping to zero.
 * - In the browser or without levels: the same soft motion, synthetic.
 * - Paused: bars glide to a calm, even height.
 * Values go straight to `transform` (no React render per frame) and are smoothed per
 * frame over time: fast attack, slower release, like an analog meter.
 */
const MIN = 0.2;
const IDLE = 0.24;
/** Smoothing time constants (s). */
const ATTACK = 0.045;
const RELEASE = 0.14;
const SETTLE = 0.18;
/** GSMTC briefly reports "paused" on seek/track change; ignore it for this long. */
const PAUSE_DEBOUNCE_MS = 320;
/** Keep the capture open briefly after pausing so resuming reacts instantly. */
const RELEASE_CAPTURE_MS = 2000;

/** Soft fake motion per bar (layered sine waves at different speeds). */
function synthetic(i: number, t: number): number {
  const a = Math.sin(t * (5.1 + i * 1.3) + i * 1.7);
  const b = Math.sin(t * (2.3 + i * 0.7) + i * 0.9);
  return 0.5 + 0.32 * a + 0.18 * b;
}

/** `tint` = Tailwind background class for the bars (Discord: green instead of accent). */
export function Equalizer({ playing, height = 12, tint = "bg-accent" }: { playing: boolean; height?: number; tint?: string }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const playingRef = useRef(playing);
  const levels = useRef<{ values: Levels; at: number } | null>(null);
  const wake = useRef<() => void>(() => {});

  // Apply pause with a slight delay (flicker on seek), start immediately.
  useEffect(() => {
    if (playing) {
      playingRef.current = true;
      wake.current();
      return;
    }
    const id = window.setTimeout(() => {
      playingRef.current = false;
      wake.current();
    }, PAUSE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [playing]);

  // Subscribe to real levels; unsubscribe with a delay after pausing.
  const off = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!audioLevelsAvailable) return;
    if (playing) {
      off.current ??= subscribeLevels((values) => {
        levels.current = { values, at: performance.now() };
      });
      return;
    }
    const id = window.setTimeout(() => {
      off.current?.();
      off.current = null;
    }, RELEASE_CAPTURE_MS);
    return () => window.clearTimeout(id);
  }, [playing]);
  useEffect(
    () => () => {
      off.current?.();
      off.current = null;
    },
    [],
  );

  // Animation loop: runs while something moves, sleeps when paused and settled.
  useEffect(() => {
    const value = [IDLE, IDLE, IDLE, IDLE];
    let frame = 0;
    let last = performance.now();
    let quiet = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      const live = levels.current && now - levels.current.at < 400 ? levels.current.values : null;
      const loud = live ? Math.max(...live) : 0;
      // Silence while playing (track change, seek) → breathe gently after 150 ms.
      quiet = live && loud > 0.06 ? 0 : quiet + dt;
      const breathe = Math.min(1, Math.max(0, (quiet - 0.15) / 0.35));

      let settled = true;
      for (let i = 0; i < 4; i++) {
        let target: number;
        let tau: number;
        if (!playingRef.current) {
          target = IDLE;
          tau = SETTLE;
        } else {
          const real = live ? MIN + (1 - MIN) * live[i] : 0;
          const soft = MIN + (live ? 0.3 : 0.75) * synthetic(i, t);
          target = live ? real * (1 - breathe) + soft * breathe : soft;
          tau = target > value[i] ? ATTACK : RELEASE;
        }
        value[i] += (target - value[i]) * (1 - Math.exp(-dt / tau));
        if (Math.abs(target - value[i]) > 0.002) settled = false;
        const bar = bars.current[i];
        if (bar) bar.style.transform = `scaleY(${value[i].toFixed(3)})`;
      }

      frame = playingRef.current || !settled ? requestAnimationFrame(tick) : 0;
    };

    wake.current = () => {
      if (frame) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    wake.current();
    return () => {
      cancelAnimationFrame(frame);
      wake.current = () => {};
    };
  }, []);

  return (
    <div className="flex items-center gap-[2px]" style={{ height }} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className={`h-full w-[2.5px] rounded-full ${tint}`}
          style={{ transform: `scaleY(${IDLE})`, transition: "background-color 400ms ease" }}
        />
      ))}
    </div>
  );
}
