import { motion } from "motion/react";
import { LockSimple } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { t } from "../../i18n";
import { fps, useFpsPolling } from "./gaming";
import { levelColor } from "./SystemView";
import { system } from "./store";

/*
 *   ╭──────────────────────────────────────────────────────────────╮
 *   │ 144 FPS  CPU 23%          (camera)          GPU 87%  RAM 42% │
 *   ╰──────────────────────────────────────────────────────────────╯
 * Gaming mode in the closed notch: FPS + CPU on the left, GPU + RAM on the right.
 * Text instead of icons; at 12 px "GPU" reads faster than a chip icon.
 * Monochrome; values only turn orange/red when things get tight.
 */
export function LiveGaming() {
  useFpsPolling();
  const f = fps.use();
  const { stats } = system.use();
  const mem = stats ? (stats.memUsed / stats.memTotal) * 100 : null;

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-between px-[12px]"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <div className="flex items-center gap-3">
        <span className="flex items-baseline gap-1" title={f.error === "no-admin" ? t("FPS freischalten: Einstellungen → Darstellung") : undefined}>
          <span className="tabular flex w-[26px] justify-end text-footnote font-semibold text-label">
            {/* Lock = no permission yet (Settings → Display), dash = no frame measured yet. */}
            {f.error === "no-admin" ? <LockSimple size={11} weight="bold" className="self-center text-label-3" /> : f.value === null ? "–" : Math.round(f.value)}
          </span>
          <span className="text-caption font-medium text-label-3">FPS</span>
        </span>
        <Stat label="CPU" value={stats?.cpu ?? null} />
      </div>
      <div className="flex items-center gap-3">
        <Stat label="GPU" value={stats?.gpu ?? null} />
        <Stat label="RAM" value={mem} />
      </div>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-caption font-medium text-label-3">{label}</span>
      <span className="tabular w-[30px] text-right text-footnote font-semibold transition-colors duration-300" style={{ color: levelColor(value ?? 0) }}>
        {value === null ? "–" : `${Math.round(value)}%`}
      </span>
    </span>
  );
}
