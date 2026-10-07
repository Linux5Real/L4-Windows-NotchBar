import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationFrame, useMotionValue, useTransform } from "motion/react";
import { ArrowUpRight, MusicNoteSimple, Pause, Play, SkipBack, SkipForward } from "@phosphor-icons/react";
import { artwork as artworkSwap, content, springs } from "../../design/motion";
import { useSmoothArtwork } from "./artwork";
import { livePosition, media, useNowPlaying, type NowPlaying } from "../../platform/media";
import { holdOpen } from "../../notch/useNotchState";
import { requestSize } from "../../notch/size";
import { findTab } from "../../notch/tabs";
import { MIXER_MAX_ROWS, MIXER_ROW, MixerList, MixerToggle, useMixer } from "./Mixer";
import { Equalizer } from "./Equalizer";
import { t } from "../../i18n";

/*
 * Layout like the expanded Dynamic Island:
 *   [Cover] Title / Artist                   [EQ]     ← click: open the playing app
 *   0:52 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -3:10
 *                   ⏮      ⏯      ⏭               [⌄]
 *   (mixer list, the notch grows down)
 */
export function NowPlayingView() {
  const np = useNowPlaying();
  const mix = useMixer();
  const [mixerOpen, setMixerOpen] = useState(false);
  const source = mix.source?.name;

  // The mixer grows the notch by its rows (at most MIXER_MAX_ROWS, then it scrolls).
  const rows = Math.min(MIXER_MAX_ROWS, (mix.system ? 1 : 0) + Math.max(1, mix.apps.length));
  useEffect(() => {
    if (!mixerOpen || !np) return requestSize("media", null);
    const base = findTab("media")!.size;
    requestSize("media", { w: base.w, h: base.h + rows * MIXER_ROW + 14 });
  }, [mixerOpen, rows, !!np]);
  useEffect(() => () => requestSize("media", null), []);

  if (!np) return <Empty />;

  return (
    <div className="flex h-full flex-col px-5 pt-1 pb-2">
      <div className="flex items-center gap-3">
        <button
          onClick={() => void media.openSource()}
          title={source ? t("In {app} öffnen", { app: source }) : t("App öffnen")}
          className="group/source pressable flex min-w-0 flex-1 items-center gap-3 rounded-[12px] text-left"
        >
          <Artwork np={np} />
          <div className="relative min-w-0 flex-1">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={np.title}
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
                exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
              >
                <div className="truncate text-title font-semibold">{np.title}</div>
                <div className="truncate text-body text-label-2">{np.artist}</div>
              </motion.div>
            </AnimatePresence>
          </div>
        </button>
        <Equalizer playing={np.isPlaying} height={16} />
      </div>
      <Progress np={np} />
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div />
        <Controls playing={np.isPlaying} />
        <div className="flex min-w-0 justify-end">
          <MixerToggle open={mixerOpen} onToggle={() => setMixerOpen((o) => !o)} />
        </div>
      </div>
      <AnimatePresence>{mixerOpen && <MixerList key="mixer" data={mix} />}</AnimatePresence>
    </div>
  );
}

/** Shared with the overview: clicking the activity flies the cover here. */
export const ARTWORK_LAYOUT_ID = "now-playing-artwork";

function Artwork({ np }: { np: NowPlaying }) {
  const artwork = useSmoothArtwork(np.artwork);
  return (
    // Outer wrapper flies (layout), inner one scales on pause; separate so they don't fight over transform.
    <motion.div layoutId={ARTWORK_LAYOUT_ID} transition={springs.morph} className="size-14 shrink-0">
      {/* Paused: the cover shrinks back slightly and dims, like Apple Music. */}
      <motion.div
        className="relative size-14 shrink-0"
        initial={false}
        animate={{ transform: np.isPlaying ? "scale(1)" : "scale(0.9)" }}
        transition={springs.snappy}
      >
        <AnimatePresence initial={false}>
          {artwork ? (
            <motion.img
              key={artwork}
              src={artwork}
              alt=""
              draggable={false}
              className="absolute inset-0 size-full rounded-[12px] object-cover"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transition: artworkSwap.enter }}
              exit={{ opacity: 0, transition: artworkSwap.exit }}
            />
          ) : (
            // No cover (some browser players): a calm placeholder instead of a gap.
            <motion.div
              key="placeholder"
              className="absolute inset-0 flex items-center justify-center rounded-[12px] bg-fill-2 text-label-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: artworkSwap.enter }}
              exit={{ opacity: 0, transition: artworkSwap.exit }}
            >
              <MusicNoteSimple size={22} weight="fill" />
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          className="pointer-events-none absolute inset-0 rounded-[12px]"
          initial={false}
          animate={{ backgroundColor: np.isPlaying ? "rgb(0 0 0 / 0)" : "rgb(0 0 0 / 0.35)" }}
          transition={{ duration: 0.25 }}
        />
        {/* Hover: hint that a click opens the app. */}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[12px] bg-black/45 text-label opacity-0 transition-opacity duration-150 group-hover/source:opacity-100">
          <ArrowUpRight size={20} weight="bold" />
        </span>
      </motion.div>
    </motion.div>
  );
}

/**
 * Progress + seeking. Drag or click to jump; while grabbed the bar gets thicker and
 * brighter and the times show the target (like Apple Music).
 * The seek only happens on release, one seek per gesture.
 */
function Progress({ np }: { np: NowPlaying }) {
  const track = useRef<HTMLDivElement>(null);
  // Target position (0..1) while dragging; ref for the frame loop, state for the times.
  const scrubRef = useRef<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const npRef = useRef(np);
  npRef.current = np;

  const ratio = () => {
    const n = npRef.current;
    return scrubRef.current ?? (n.duration > 0 ? livePosition(n) / n.duration : 0);
  };
  const progress = useMotionValue(ratio());
  useAnimationFrame(() => progress.set(ratio()));
  // Translate instead of stretch: no distorted round end, no raster artifacts while seeking.
  const transform = useTransform(progress, (p) => `translateX(${((p - 1) * 100).toFixed(3)}%)`);

  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Unknown duration (live stream): keep the row as a placeholder so nothing jumps.
  if (np.duration <= 0) return <div className="mt-3.5 h-[14px]" />;

  const pos = scrub !== null ? scrub * np.duration : livePosition(np);
  const active = scrub !== null || (hover && np.canSeek);

  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const move = (clientX: number) => {
    scrubRef.current = at(clientX);
    setScrub(scrubRef.current);
  };
  const end = (commit: boolean) => {
    if (scrubRef.current === null) return;
    if (commit) media.seek(scrubRef.current * np.duration);
    scrubRef.current = null;
    setScrub(null);
    holdOpen(false);
  };

  return (
    <div className="mt-3.5 flex items-center gap-2.5">
      <span className={`tabular w-9 text-caption font-medium transition-colors duration-150 ${scrub !== null ? "text-label" : "text-label-3"}`}>
        {format(pos)}
      </span>
      {/* Hit area taller than the bar so it's easy to grab. */}
      <div
        ref={track}
        className={`relative flex h-4 flex-1 items-center ${np.canSeek ? "touch-none" : ""}`}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onPointerDown={(e) => {
          if (!np.canSeek || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          holdOpen(true);
          move(e.clientX);
        }}
        onPointerMove={(e) => scrubRef.current !== null && move(e.clientX)}
        onPointerUp={() => end(true)}
        onPointerCancel={() => end(false)}
        onLostPointerCapture={() => end(true)}
      >
        <div
          className={`relative w-full overflow-hidden rounded-full bg-fill-2 transition-[height] duration-150 ease-out ${active ? "h-[9px]" : "h-[5px]"}`}
        >
          <motion.div
            className={`absolute inset-0 rounded-full transition-colors duration-150 ${active ? "bg-label" : "bg-label-2"}`}
            style={{ transform }}
          />
        </div>
      </div>
      <span className={`tabular w-9 text-right text-caption font-medium transition-colors duration-150 ${scrub !== null ? "text-label" : "text-label-3"}`}>
        -{format(np.duration - pos)}
      </span>
    </div>
  );
}

function Controls({ playing }: { playing: boolean }) {
  return (
    <div className="flex items-center justify-center gap-6">
      <IconButton label={t("Zurück")} onClick={media.previous}>
        <SkipBack size={20} weight="fill" />
      </IconButton>
      <IconButton label={playing ? t("Pause") : t("Abspielen")} onClick={media.toggle}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={playing ? "pause" : "play"}
            className="flex"
            initial={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
            exit={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
          >
            {playing ? <Pause size={26} weight="fill" /> : <Play size={26} weight="fill" />}
          </motion.span>
        </AnimatePresence>
      </IconButton>
      <IconButton label={t("Weiter")} onClick={media.next}>
        <SkipForward size={20} weight="fill" />
      </IconButton>
    </div>
  );
}

function IconButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      onClick={props.onClick}
      className="pressable pressable-fill flex size-10 items-center justify-center rounded-full text-label"
    >
      {props.children}
    </button>
  );
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-body text-label-3">{t("Gerade läuft nichts")}</div>
  );
}

function format(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
