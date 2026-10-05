import { useEffect, useRef, type ReactNode } from "react";
import { animate, motion, useMotionValue, useTransform, type Transition } from "motion/react";
import type { NotchGeometry } from "./geometry";
import { ShapeWidth } from "./liveEdges";

interface Props {
  geometry: NotchGeometry;
  transition: Transition;
  /** Shadow only when the notch "floats" over content (open). */
  elevated: boolean;
  children?: ReactNode;
}

/**
 * The black shape: a body with rounded bottom corners + two concave "ears"
 * at the top that blend the notch into the screen edge.
 *
 * All dimensions are motion values animated directly by springs, no React
 * re-render per frame. Animations are interruptible and keep their velocity
 * (important when hovering in and out quickly).
 */
export function NotchShape({ geometry, transition, elevated, children }: Props) {
  const w = useMotionValue(geometry.w);
  const h = useMotionValue(geometry.h);
  const r = useMotionValue(geometry.r);
  const ear = useMotionValue(geometry.ear);
  const shadow = useMotionValue(elevated ? 1 : 0);
  const earOffset = useTransform(ear, (e) => -e + 0.5); // 0.5px overlap against hairlines
  // Whole device pixels: the shape is centered, so an odd or fractional size puts its edges
  // (and the cover pinned to them) on subpixels that shift every frame, which reads as jitter.
  const wPx = useTransform(w, snap);
  const hPx = useTransform(h, snap);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Settle to within 0.01 px: the live activity follows the width on subpixels, and
    // Motion's default rest threshold ended every spring with a visible ~0.25 px jump.
    const t = { ...transition, restDelta: 0.01, restSpeed: 0.1 };
    const controls = [animate(w, geometry.w, t), animate(h, geometry.h, t), animate(r, geometry.r, t), animate(ear, geometry.ear, t)];
    return () => controls.forEach((c) => c.stop());
  }, [geometry.w, geometry.h, geometry.r, geometry.ear, transition, w, h, r, ear]);

  useEffect(() => {
    const c = animate(shadow, elevated ? 1 : 0, { duration: 0.3, ease: [0.23, 1, 0.32, 1] });
    return () => c.stop();
  }, [elevated, shadow]);

  return (
    <motion.div className="relative" style={{ width: wPx, height: hPx }}>
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
        // clip instead of hidden: no scroll container, so focus/scrollIntoView can't shift the content.
        className="absolute inset-0 overflow-clip bg-notch"
        style={{ borderBottomLeftRadius: r, borderBottomRightRadius: r }}
      >
        <ShapeWidth.Provider value={w}>{children}</ShapeWidth.Provider>
      </motion.div>
    </motion.div>
  );
}

/** Nearest size that is an even number of device pixels, so both centered edges land on whole pixels. */
function snap(v: number): number {
  const dpr = window.devicePixelRatio || 1;
  return (Math.round((v * dpr) / 2) * 2) / dpr;
}
