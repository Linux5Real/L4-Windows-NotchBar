import { useEffect, useRef, type ReactNode } from "react";
import { animate, motion, useMotionValue, useTransform, type Transition } from "motion/react";
import type { NotchGeometry } from "./geometry";

interface Props {
  geometry: NotchGeometry;
  transition: Transition;
  /** Schatten nur, wenn die Notch über Inhalt "schwebt" (offen). */
  elevated: boolean;
  children?: ReactNode;
}

/**
 * Die schwarze Form: Körper mit runden unteren Ecken + zwei konkave "Ohren"
 * oben, die die Notch in den Bildschirmrand übergehen lassen.
 *
 * Alle Maße sind Motion-Values und werden direkt per Spring animiert —
 * kein React-Re-Render pro Frame. Animationen sind unterbrechbar und
 * behalten ihre Geschwindigkeit (wichtig beim schnellen Rein/Raus-Hovern).
 */
export function NotchShape({ geometry, transition, elevated, children }: Props) {
  const w = useMotionValue(geometry.w);
  const h = useMotionValue(geometry.h);
  const r = useMotionValue(geometry.r);
  const ear = useMotionValue(geometry.ear);
  const shadow = useMotionValue(elevated ? 1 : 0);
  const earOffset = useTransform(ear, (e) => -e + 0.5); // 0.5px Überlappung gegen Haarlinien

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const controls = [
      animate(w, geometry.w, transition),
      animate(h, geometry.h, transition),
      animate(r, geometry.r, transition),
      animate(ear, geometry.ear, transition),
    ];
    return () => controls.forEach((c) => c.stop());
  }, [geometry.w, geometry.h, geometry.r, geometry.ear, transition, w, h, r, ear]);

  useEffect(() => {
    const c = animate(shadow, elevated ? 1 : 0, { duration: 0.3, ease: [0.23, 1, 0.32, 1] });
    return () => c.stop();
  }, [elevated, shadow]);

  return (
    <motion.div className="relative" style={{ width: w, height: h }}>
      <motion.span
        aria-hidden
        className="absolute top-0"
        style={{
          left: earOffset,
          width: ear,
          height: ear,
          background:
            "radial-gradient(circle farthest-side at 0% 100%, transparent calc(100% - 0.75px), var(--color-notch) 100%)",
        }}
      />
      <motion.span
        aria-hidden
        className="absolute top-0"
        style={{
          right: earOffset,
          width: ear,
          height: ear,
          background:
            "radial-gradient(circle farthest-side at 100% 100%, transparent calc(100% - 0.75px), var(--color-notch) 100%)",
        }}
      />
      <motion.div
        aria-hidden
        className="absolute inset-0"
        style={{
          opacity: shadow,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: r,
          boxShadow: "0 18px 40px -10px rgb(0 0 0 / 0.7), 0 4px 12px rgb(0 0 0 / 0.35)",
        }}
      />
      <motion.div
        // clip statt hidden: kein Scroll-Container → Fokus/scrollIntoView können den Inhalt nicht verschieben.
        className="absolute inset-0 overflow-clip bg-notch"
        style={{ borderBottomLeftRadius: r, borderBottomRightRadius: r }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
