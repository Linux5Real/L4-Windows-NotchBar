import { useEffect, useRef } from "react";
import { audioLevelsAvailable, subscribeLevels, type Levels } from "../../platform/audio";

/*
 * Vier Balken in der Akzentfarbe, Bässe links → Höhen rechts.
 *
 * Eine einzige Animationsschleife für alle Zustände, damit nie hart umgeschaltet wird:
 * - Spielt + echte Pegel (WASAPI-Loopback, ~40 Werte/s): Balken folgen dem Sound.
 * - Stille beim Song-Wechsel oder Spulen: sanftes "Atmen" statt auf null zu fallen.
 * - Im Browser oder ohne Pegel: dieselbe weiche Bewegung, synthetisch.
 * - Pausiert: Balken gleiten auf eine ruhige, gleiche Höhe.
 * Werte gehen direkt auf `transform` (kein React-Render pro Frame) und werden pro Frame
 * zeitbasiert geglättet: schnell hoch, langsamer runter — wie ein analoger Pegel.
 */
const MIN = 0.2;
const IDLE = 0.24;
/** Zeitkonstanten (s) der Glättung. */
const ATTACK = 0.045;
const RELEASE = 0.14;
const SETTLE = 0.18;
/** GSMTC meldet beim Spulen/Wechseln kurz "pausiert" → so lange ignorieren. */
const PAUSE_DEBOUNCE_MS = 320;
/** Aufnahme nach Pause noch kurz offen lassen: Weiterspielen reagiert sofort. */
const RELEASE_CAPTURE_MS = 2000;

/** Weiche Pseudo-Bewegung pro Balken (überlagerte Sinus-Wellen, unterschiedliche Tempi). */
function synthetic(i: number, t: number): number {
  const a = Math.sin(t * (5.1 + i * 1.3) + i * 1.7);
  const b = Math.sin(t * (2.3 + i * 0.7) + i * 0.9);
  return 0.5 + 0.32 * a + 0.18 * b;
}

/** `tint` = Tailwind-Hintergrundklasse der Balken (Discord: grün statt Akzent). */
export function Equalizer({ playing, height = 12, tint = "bg-accent" }: { playing: boolean; height?: number; tint?: string }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const playingRef = useRef(playing);
  const levels = useRef<{ values: Levels; at: number } | null>(null);
  const wake = useRef<() => void>(() => {});

  // Pause leicht verzögert übernehmen (Flackern beim Spulen), Start sofort.
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

  // Echte Pegel abonnieren; nach einer Pause erst verzögert abmelden.
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

  // Animationsschleife: läuft, solange sich etwas bewegt; schläft, wenn pausiert und eingeschwungen.
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
      // Stille trotz Wiedergabe (Song-Wechsel, Spulen) → nach 150 ms sanft atmen lassen.
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
