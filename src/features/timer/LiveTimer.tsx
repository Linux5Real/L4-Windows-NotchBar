import { motion } from "motion/react";
import { AlarmIcon, CheckCircle, Timer } from "@phosphor-icons/react";
import { content, pulse } from "../../design/motion";
import { formatClock, ringing, timer, useRemaining } from "./store";
import { t } from "../../i18n";

/** Closed notch with a running/finished timer: icon left, countdown right. Finished stays until dismissed. */
export function LiveTimer() {
  const s = timer.use();
  const ring = ringing.use();
  const remaining = useRemaining();
  const tint = s.finished ? "var(--color-green)" : s.mode === "focus" ? "var(--color-orange)" : "var(--color-green)";

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-between px-[11px]"
      style={{ color: tint }}
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      {s.finished && ring ? (
        <motion.span className="flex" animate={{ opacity: [1, 0.35] }} transition={pulse}>
          <AlarmIcon size={17} weight="fill" />
        </motion.span>
      ) : s.finished ? (
        <CheckCircle size={17} weight="fill" />
      ) : (
        <Timer size={17} weight="bold" />
      )}
      <span className="tabular text-footnote font-semibold">{s.finished ? t("Abgelaufen") : formatClock(remaining)}</span>
    </motion.div>
  );
}

export function useTimerLive(): boolean {
  const s = timer.use();
  return s.endsAt !== null || s.finished;
}
