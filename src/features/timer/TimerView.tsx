import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlarmIcon, ArrowCounterClockwise, Check, CheckCircle, Pause, PencilSimple, Play, SpeakerSimpleSlash, X } from "@phosphor-icons/react";
import { content, pulse, springs } from "../../design/motion";
import {
  MAX_MINUTES,
  MIN_MINUTES,
  formatClock,
  presets,
  ringing,
  timer,
  timerActions,
  useRemaining,
  type TimerMode,
} from "./store";
import { t } from "../../i18n";

const modeLabel: Record<TimerMode, string> = { focus: "Fokus", break: "Pause" };

/*
 *   [Fokus | Pause]               15  25  45  [37]  [✎]
 *   24:59  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  [↺] [⏯]
 *
 * Eigene Zeit: ✎ öffnet ein Minutenfeld, oder Mausrad über der großen Zeit
 * (±1 min, Shift ±5) — nur solange der Timer nicht läuft.
 */
export function TimerView() {
  const s = timer.use();
  if (s.finished) return <FinishedView />;
  return <SetupView />;
}

/*
 *   ✓ Fokus abgelaufen
 *   0:00  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  [🔕] bzw. [✕]
 *
 * Bleibt stehen, bis man schließt. Solange es klingelt: Alarm stoppen; danach nur noch ✕.
 */
function FinishedView() {
  const s = timer.use();
  const ring = ringing.use();
  const tint = s.mode === "focus" ? "var(--color-orange)" : "var(--color-green)";
  return (
    <motion.div
      className="flex h-full flex-col justify-between px-5 pt-1 pb-2"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
    >
      <div className="flex h-7 items-center gap-2 text-footnote font-semibold" style={{ color: tint }}>
        {ring ? (
          <motion.span className="flex" animate={{ opacity: [1, 0.35] }} transition={pulse}>
            <AlarmIcon size={15} weight="fill" />
          </motion.span>
        ) : (
          <CheckCircle size={15} weight="fill" />
        )}
        {t(s.mode === "focus" ? "Fokus abgelaufen" : "Pause abgelaufen")}
        <span className="font-medium text-label-3">· {formatClock(s.duration)}</span>
      </div>
      <div className="flex items-center gap-4">
        <motion.span
          className="tabular text-[40px] leading-none font-semibold tracking-[-0.03em]"
          style={{ color: tint }}
          animate={{ opacity: ring ? [1, 0.45] : 1 }}
          transition={ring ? pulse : content.enter}
        >
          0:00
        </motion.span>
        <div className="h-[5px] flex-1 rounded-full" style={{ backgroundColor: tint }} />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={ring ? "silence" : "close"}
            initial={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
            exit={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            transition={content.exit}
          >
            {ring ? (
              <RoundButton label={t("Alarm stoppen")} onClick={timerActions.silence} tint={tint}>
                <SpeakerSimpleSlash size={17} weight="fill" />
              </RoundButton>
            ) : (
              <RoundButton label={t("Schließen")} onClick={timerActions.dismiss}>
                <X size={16} weight="bold" />
              </RoundButton>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function SetupView() {
  const s = timer.use();
  const remaining = useRemaining();
  const running = s.endsAt !== null;
  const progress = 1 - remaining / s.duration;
  const tint = s.mode === "focus" ? "var(--color-orange)" : "var(--color-green)";
  const [editing, setEditing] = useState(false);
  const clockRef = useRef<HTMLSpanElement>(null);

  // Mausrad stellt die Minuten ein. Nur wenn nicht gestartet; passive:false für preventDefault.
  const editable = !running && remaining === s.duration;
  useEffect(() => {
    const el = clockRef.current;
    if (!el || !editable) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = (e.shiftKey ? 5 : 1) * (e.deltaY < 0 ? 1 : -1);
      timerActions.setMinutes(Math.round(timer.get().duration / 60) + step);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [editable]);

  const custom = s.custom?.[s.mode];
  const chips = custom && !presets[s.mode].includes(custom) ? [...presets[s.mode], custom] : presets[s.mode];

  return (
    <div className="flex h-full flex-col justify-between px-5 pt-1 pb-2">
      <div className="flex h-7 items-center justify-between">
        <Segmented
          value={s.mode}
          onChange={(m) => {
            setEditing(false);
            timerActions.select(m, s.custom?.[m] ?? presets[m][m === "focus" ? 1 : 0]);
          }}
        />
        {/* Chips und Minutenfeld liegen rechtsbündig übereinander: beim Wechsel springt nichts zur Seite. */}
        <div className="relative flex h-6 flex-1 justify-end">
        <AnimatePresence initial={false}>
          {editing ? (
            <MinutesInput
              key="input"
              initial={Math.round(s.duration / 60)}
              tint={tint}
              onDone={(minutes) => {
                if (minutes !== null) timerActions.setMinutes(minutes);
                setEditing(false);
              }}
            />
          ) : (
            <motion.div
              key="chips"
              className="absolute top-0 right-0 flex gap-1"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
              exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
            >
              {chips.map((d) => (
                <button
                  key={d}
                  onClick={() => timerActions.select(s.mode, d)}
                  className={`pressable pressable-fill tabular h-6 min-w-7 rounded-full px-2.5 text-caption font-medium ${
                    d === s.duration ? "bg-fill-2 text-label" : "text-label-3"
                  }`}
                >
                  {d / 60}
                </button>
              ))}
              <button
                aria-label={t("Eigene Zeit")}
                title={t("Eigene Zeit (oder Mausrad über der Zeit)")}
                onClick={() => setEditing(true)}
                className="pressable pressable-fill flex size-6 items-center justify-center rounded-full text-label-3 hover:text-label-2"
              >
                <PencilSimple size={12} weight="bold" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <span
          ref={clockRef}
          title={editable ? t("Mausrad: ±1 min, Shift: ±5 min") : undefined}
          className="tabular text-[40px] leading-none font-semibold tracking-[-0.03em]"
          style={{ color: tint }}
        >
          {formatClock(remaining)}
        </span>
        <div className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-fill-2">
          <motion.div
            className="absolute inset-0 origin-left rounded-full"
            style={{ backgroundColor: tint }}
            initial={false}
            animate={{ transform: `scaleX(${progress})` }}
            transition={{ duration: 0.25, ease: "linear" }}
          />
        </div>
        <div className="flex gap-1.5">
          <RoundButton label={t("Zurücksetzen")} onClick={timerActions.reset} disabled={editable}>
            <ArrowCounterClockwise size={16} weight="bold" />
          </RoundButton>
          <RoundButton
            label={running ? t("Pause") : t("Start")}
            onClick={running ? timerActions.pause : timerActions.start}
            tint={tint}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={running ? "pause" : "play"}
                className="flex"
                initial={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
                animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
                exit={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
                transition={content.exit}
              >
                {running ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
              </motion.span>
            </AnimatePresence>
          </RoundButton>
        </div>
      </div>
    </div>
  );
}

/** Minutenfeld: Enter/✓ übernimmt, Esc oder Fokusverlust bricht ab. */
function MinutesInput(props: { initial: number; tint: string; onDone: (minutes: number | null) => void }) {
  const [value, setValue] = useState(String(props.initial));
  const ref = useRef<HTMLInputElement>(null);
  const minutes = Number(value);
  const valid = Number.isFinite(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES;

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  return (
    <motion.form
      className="absolute top-0 right-0 flex items-center gap-1.5"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) props.onDone(minutes);
      }}
    >
      <div className="flex h-6 items-center gap-1 rounded-full bg-fill-2 pr-2.5 pl-2.5">
        <input
          ref={ref}
          value={value}
          inputMode="numeric"
          maxLength={3}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            // Esc nur hier abfangen, nicht die ganze Notch schließen.
            if (e.key === "Escape") {
              e.stopPropagation();
              props.onDone(null);
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.form?.contains(e.relatedTarget as Node)) props.onDone(null);
          }}
          className="tabular w-7 bg-transparent text-right text-caption font-semibold text-label outline-none"
        />
        <span className="text-caption text-label-3">min</span>
      </div>
      <button
        type="submit"
        aria-label={t("Übernehmen")}
        disabled={!valid}
        className="pressable flex size-6 items-center justify-center rounded-full disabled:opacity-30"
        style={{ color: props.tint, backgroundColor: `color-mix(in srgb, ${props.tint} 18%, transparent)` }}
      >
        <Check size={12} weight="bold" />
      </button>
    </motion.form>
  );
}

function Segmented({ value, onChange }: { value: TimerMode; onChange: (m: TimerMode) => void }) {
  return (
    <div className="flex rounded-full bg-fill-1 p-0.5">
      {(Object.keys(modeLabel) as TimerMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`relative h-6 rounded-full px-3 text-caption font-medium transition-colors duration-150 ${
            m === value ? "text-label" : "text-label-3 hover:text-label-2"
          }`}
        >
          {m === value && (
            <motion.span layoutId="timer-mode" className="absolute inset-0 rounded-full bg-fill-3" transition={springs.snappy} />
          )}
          <span className="relative">{t(modeLabel[m])}</span>
        </button>
      ))}
    </div>
  );
}

function RoundButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tint?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className="pressable pressable-fill flex size-10 items-center justify-center rounded-full bg-fill-1 text-label disabled:opacity-30"
      style={props.tint ? { color: props.tint, backgroundColor: `color-mix(in srgb, ${props.tint} 18%, transparent)` } : undefined}
    >
      {props.children}
    </button>
  );
}
