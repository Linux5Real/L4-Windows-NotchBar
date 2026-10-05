import { createContext, useContext, type ReactNode } from "react";
import { motion, motionValue, useTransform, type MotionValue } from "motion/react";

/** The shape's spring-animated width, unrounded (NotchShape). */
export const ShapeWidth = createContext<MotionValue<number>>(motionValue(0));

/** How far each edge of the shape currently sits outside the live box (px, LiveSlot). */
export const LiveSpread = createContext<MotionValue<number>>(motionValue(0));

/**
 * One side of a live activity. It follows the shape's edge by transform, not layout:
 * layout rounds to whole pixels, so the end of every spring crept in visible steps;
 * a transform glides on subpixels without re-rasterizing the icons.
 */
export function LiveEdge({ side, className = "flex items-center", children }: { side: "left" | "right"; className?: string; children: ReactNode }) {
  const spread = useContext(LiveSpread);
  const x = useTransform(spread, (s) => (side === "left" ? -s : s));
  return (
    <motion.div className={className} style={{ x, willChange: "transform" }}>
      {children}
    </motion.div>
  );
}
