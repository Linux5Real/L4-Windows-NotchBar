import { motion } from "motion/react";
import { Cpu, WifiHigh, type Icon } from "@phosphor-icons/react";
import { GpuIcon, RamIcon } from "../../ui/icons";
import { content } from "../../design/motion";
import { locale, t } from "../../i18n";
import { HISTORY, system } from "./store";

/*
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ ▣ CPU      Ryzen 7 7800X3D         ╱╲__╱╲___     23 %   │
 *   │ ▤ RAM      13,4 / 32 GB            ‾‾‾‾‾‾‾‾‾     42 %   │
 *   │ ▦ GPU      RTX 4070 Ti · 3,1 GB    _╱╲_____╱     31 %   │
 *   │ ◠ Ping     1.1.1.1                 ___╱╲____    14 ms   │
 *   └──────────────────────────────────────────────────────────┘
 * Like OmniNotch: a calm card with rows. Instead of bars, one minute of history as a
 * line, so you see whether something is spiking or staying high. `store.ts` collects
 * the values from app start, so the history is already full when opened.
 */
export function SystemView() {
  const { stats: s, history: h, tick } = system.use();
  if (!s) return null;
  const gb = (b: number) => (b / 1024 ** 3).toLocaleString(locale(), { maximumFractionDigits: 1 });
  const mem = (s.memUsed / s.memTotal) * 100;

  return (
    <div className="h-full px-4 pt-1 pb-2">
      <div className="divide-y divide-separator rounded-[14px] bg-fill-1">
        <Row i={0} tick={tick} icon={Cpu} label="CPU" detail={s.cpuName} values={h.cpu} max={100} value={`${Math.round(s.cpu)} %`} level={s.cpu} />
        <Row i={1} tick={tick} icon={RamIcon} label="RAM" detail={`${gb(s.memUsed)} / ${gb(s.memTotal)} GB`} values={h.mem} max={100} value={`${Math.round(mem)} %`} level={mem} />
        <Row
          i={2}
          tick={tick}
          icon={GpuIcon}
          label="GPU"
          detail={[s.gpuName, s.gpuMemTotal ? `${gb(s.gpuMemUsed)} / ${gb(s.gpuMemTotal)} GB` : null].filter(Boolean).join(" · ") || t("Nicht verfügbar")}
          values={h.gpu}
          max={100}
          value={s.gpu === null ? "–" : `${Math.round(s.gpu)} %`}
          level={s.gpu ?? 0}
        />
        <Row
          i={3}
          tick={tick}
          icon={WifiHigh}
          label="Ping"
          detail="1.1.1.1"
          values={h.ping}
          max={Math.max(60, ...h.ping.filter(Number.isFinite))}
          value={s.ping === null ? t("Offline") : `${s.ping} ms`}
          level={s.ping === null ? 100 : s.ping >= 150 ? 95 : s.ping >= 60 ? 70 : 0}
        />
      </div>
    </div>
  );
}

/** Traffic-light colors only when it gets critical, otherwise everything stays monochrome. */
export function levelColor(level: number): string {
  return level >= 90 ? "var(--color-red)" : level >= 70 ? "var(--color-orange)" : "var(--color-label)";
}

function Row(props: { i: number; tick: number; icon: Icon; label: string; detail: string; values: number[]; max: number; value: string; level: number }) {
  const I = props.icon;
  const color = levelColor(props.level);
  return (
    <motion.div
      className="flex h-[38px] items-center gap-3 px-3"
      initial={{ opacity: 0, transform: "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ ...content.enter, delay: 0.04 * props.i }}
    >
      <I size={15} weight="bold" className="shrink-0 text-label-3" />
      <span className="w-10 shrink-0 text-footnote font-medium text-label">{props.label}</span>
      <span className="tabular w-[190px] shrink-0 truncate text-caption text-label-3" title={props.detail}>
        {props.detail}
      </span>
      <Trend values={props.values} max={props.max} color={color} tick={props.tick} />
      <span className="tabular w-[58px] shrink-0 text-right text-footnote font-semibold transition-colors duration-300" style={{ color }}>
        {props.value}
      </span>
    </motion.div>
  );
}

/**
 * One minute of history; gaps (no value) stay open. Right = now.
 * The line is drawn one step to the right and glides left by that step every second,
 * so it scrolls smoothly instead of jumping.
 */
function Trend({ values, max, color, tick }: { values: number[]; max: number; color: string; tick: number }) {
  const w = 160;
  const h = 22;
  const step = w / (HISTORY - 2);
  const offset = HISTORY - values.length;
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    const x = (offset + i) * step;
    const y = h - 2 - (Math.min(v, max) / max) * (h - 4);
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-[22px] min-w-0 flex-1 overflow-hidden">
      <line x1="0" x2={w} y1={h - 1} y2={h - 1} stroke="var(--color-separator)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <path
        // New value → new animation (key); before that the line sits one step to the right.
        key={tick}
        className="trend-scroll"
        d={d}
        fill="none"
        stroke={color}
        strokeOpacity="0.8"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{ ["--step" as string]: `${step}px` }}
      />
    </svg>
  );
}
