import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, SpeakerHigh, SpeakerLow, SpeakerNone, SpeakerSimpleSlash } from "@phosphor-icons/react";
import { content, springs } from "../../design/motion";
import { holdOpen } from "../../notch/useNotchState";
import { mixer, systemControls, type AppVolume, type VolumeState } from "../../platform/services";
import { t } from "../../i18n";

/*
 * Volume per app (issue #4), like the Windows volume mixer:
 *                      ⏮  ⏯  ⏭                [⌄]
 *   ─────────────────────────────────────────────
 *   [●]  Spotify         ━━━━━━━━━━━━━━━━━━  72   ← playing app on top
 *   [🔊] System          ━━━━━━━━━━━━━━━━━━  42
 *   [●]  Google Chrome   ━━━━━━━━━━━━━━━━━━ 100
 * The arrow on the right of the controls opens the list.
 */

const POLL_MS = 1500;
/** Row height + gap of the list; the notch grows by this per app. */
export const MIXER_ROW = 34;
export const MIXER_MAX_ROWS = 5;

export interface MixerData {
  apps: AppVolume[];
  system: VolumeState | null;
  /** The playing app's row, if Windows lists it. */
  source: AppVolume | null;
  setApp: (id: string, patch: { level?: number; muted?: boolean }) => void;
  setSystem: (patch: { level?: number; muted?: boolean }) => void;
  /** Pause polling while a slider is held, so it doesn't jump back. */
  hold: (on: boolean) => void;
}

export function useMixer(): MixerData {
  const [apps, setApps] = useState<AppVolume[]>([]);
  const [system, setSystem] = useState<VolumeState | null>(null);
  const held = useRef(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (held.current > 0) return;
      void mixer.list().then((list) => alive && held.current === 0 && setApps(list)).catch(() => {});
      void systemControls.volume().then((v) => alive && held.current === 0 && setSystem(v)).catch(() => {});
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const unmute = (patch: { level?: number; muted?: boolean }) =>
    patch.level !== undefined && patch.level > 0 && patch.muted === undefined ? { ...patch, muted: false } : patch;

  return {
    apps,
    system,
    source: apps.find((a) => a.media) ?? null,
    setApp(id, patch) {
      setApps((list) => list.map((a) => (a.id === id ? { ...a, ...unmute(patch) } : a)));
      void mixer.set(id, patch);
    },
    setSystem(patch) {
      setSystem((v) => (v ? { ...v, ...unmute(patch) } : v));
      void systemControls.setVolume(patch);
    },
    hold(on) {
      held.current = Math.max(0, held.current + (on ? 1 : -1));
    },
  };
}

function speakerIcon(level: number, muted: boolean) {
  if (muted || level === 0) return SpeakerSimpleSlash;
  return level < 0.34 ? SpeakerNone : level < 0.67 ? SpeakerLow : SpeakerHigh;
}

/**
 * Volume bar in the style of the progress bar: grabbing makes it thicker and brighter.
 * Wheel ±2 % (Shift ±10 %), arrow keys ±5 %.
 */
export function LevelBar(props: { value: number; muted: boolean; label: string; onChange: (v: number) => void; onHold: (on: boolean) => void; className?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [grab, setGrab] = useState(false);
  const [hover, setHover] = useState(false);
  const level = props.muted ? 0 : props.value;
  const active = grab || hover;

  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 100) / 100;
  };
  const step = (delta: number) => props.onChange(Math.round(Math.min(1, Math.max(0, level + delta)) * 100) / 100);
  const release = () => {
    if (!grab) return;
    setGrab(false);
    props.onHold(false);
    holdOpen(false);
  };

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label={props.label}
      aria-valuenow={Math.round(level * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`relative flex h-4 cursor-pointer touch-none items-center outline-none ${props.className ?? ""}`}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setGrab(true);
        props.onHold(true);
        holdOpen(true);
        props.onChange(at(e.clientX));
      }}
      onPointerMove={(e) => grab && props.onChange(at(e.clientX))}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onWheel={(e) => step((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.1 : 0.02))}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") step(0.05);
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") step(-0.05);
      }}
    >
      <div className={`relative w-full overflow-hidden rounded-full bg-fill-2 transition-[height] duration-150 ease-out ${active ? "h-[9px]" : "h-[5px]"}`}>
        <div
          // Dragging: follow the cursor almost directly. Otherwise (other app, keyboard
          // volume keys) glide to the new level.
          className={`absolute inset-0 rounded-full transition-[transform,background-color] ${grab ? "duration-75 ease-linear" : "duration-300 ease-out"} ${active ? "bg-label" : "bg-label-2"}`}
          style={{ transform: `translateX(${(level - 1) * 100}%)` }}
        />
      </div>
    </div>
  );
}

/** Icon that mutes on click; the program icon for apps, the speaker for the system. */
function MuteButton(props: { icon: string | null; level: number; muted: boolean; label: string; onToggle: () => void; size?: number }) {
  const size = props.size ?? 18;
  const Speaker = speakerIcon(props.level, props.muted);
  return (
    <button
      aria-label={props.muted ? t("Stummschaltung aufheben") : t("Stumm")}
      title={props.label}
      onClick={props.onToggle}
      className="pressable relative flex size-7 shrink-0 items-center justify-center rounded-full"
    >
      {props.icon ? (
        <>
          <img
            src={props.icon}
            alt=""
            draggable={false}
            className={`rounded-[5px] transition-[opacity,filter] duration-150 ${props.muted ? "opacity-40 grayscale" : ""}`}
            style={{ width: size, height: size }}
          />
          <AnimatePresence>
            {props.muted && (
              <motion.span
                className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-notch text-red"
                initial={{ opacity: 0, transform: "scale(0.9)" }}
                animate={{ opacity: 1, transform: "scale(1)" }}
                exit={{ opacity: 0, transform: "scale(0.9)" }}
                transition={springs.snappy}
              >
                <SpeakerSimpleSlash size={9} weight="fill" />
              </motion.span>
            )}
          </AnimatePresence>
        </>
      ) : (
        <Speaker size={15} weight="fill" className={props.muted ? "text-red" : "text-label-2"} />
      )}
    </button>
  );
}

/** Arrow on the right: opens the full mixer. */
export function MixerToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      aria-label={t("Lautstärke pro App")}
      title={t("Lautstärke pro App")}
      className={`pressable pressable-fill flex size-7 items-center justify-center rounded-full transition-colors duration-150 ${
        open ? "bg-fill-2 text-label" : "text-label-3 hover:text-label-2"
      }`}
    >
      <motion.span className="flex" animate={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }} transition={springs.snappy}>
        <CaretDown size={13} weight="bold" />
      </motion.span>
    </button>
  );
}

type Item = { key: string; name: string; icon: string | null; playing: boolean; level: number; muted: boolean; set: (patch: { level?: number; muted?: boolean }) => void };

/**
 * Full list: the playing app on top, then the system, then every other app with sound.
 * When the playing app changes while the list is open, the rows slide to their new place.
 */
export function MixerList({ data }: { data: MixerData }) {
  const sys = data.system;
  const items: Item[] = data.apps.map((a) => ({
    key: a.id,
    name: a.name,
    icon: a.icon,
    playing: a.media,
    level: a.level,
    muted: a.muted,
    set: (patch) => data.setApp(a.id, patch),
  }));
  if (sys) items.push({ key: "system", name: t("System"), icon: null, playing: false, level: sys.level, muted: sys.muted, set: data.setSystem });
  const rank = (i: Item) => (i.playing ? 0 : i.key === "system" ? 1 : 2);
  // Stable sort: apps keep Windows' order among themselves.
  items.sort((a, b) => rank(a) - rank(b));

  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: { ...content.enter, delay: 0.06 } }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <div className="mx-0.5 mt-2 mb-1.5 h-px shrink-0 bg-separator" />
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-width:none]">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item, i) => (
            <motion.div key={item.key} layout="position" transition={springs.morph} exit={{ opacity: 0, transition: content.exit }}>
              <Row index={i} item={item} onHold={data.hold} />
            </motion.div>
          ))}
        </AnimatePresence>
        {data.apps.length === 0 && <div className="py-2 text-center text-caption text-label-3">{t("Gerade spielt keine App Ton ab")}</div>}
      </div>
    </motion.div>
  );
}

/** One app: icon (mutes on click), name, bar, percent. Fades in staggered on first show. */
function Row({ index, item, onHold }: { index: number; item: Item; onHold: (on: boolean) => void }) {
  const shown = item.muted ? 0 : item.level;
  return (
    <motion.div
      className="flex items-center gap-2"
      style={{ height: MIXER_ROW }}
      initial={{ opacity: 0, transform: "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ ...content.enter, delay: 0.08 + 0.04 * Math.min(index, 6) }}
    >
      <MuteButton icon={item.icon} level={item.level} muted={item.muted} label={item.name} onToggle={() => item.set({ muted: !item.muted })} />
      <span className={`w-32 shrink-0 truncate text-footnote transition-colors duration-200 ${item.playing ? "font-medium text-label" : "text-label-2"}`}>{item.name}</span>
      <LevelBar className="min-w-0 flex-1" value={item.level} muted={item.muted} label={item.name} onHold={onHold} onChange={(v) => item.set({ level: v })} />
      <span className="tabular w-8 shrink-0 text-right text-caption font-medium text-label-3">{Math.round(shown * 100)}</span>
    </motion.div>
  );
}
