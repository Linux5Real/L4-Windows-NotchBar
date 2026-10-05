import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationFrame, useMotionValue, useTransform } from "motion/react";
import { MusicNoteSimple, Pause, Play, SkipBack, SkipForward } from "@phosphor-icons/react";
import { content, springs } from "../../design/motion";
import { livePosition, media, useNowPlaying, type NowPlaying } from "../../platform/media";
import { holdOpen } from "../../notch/useNotchState";
import { Equalizer } from "./Equalizer";
import { t } from "../../i18n";

/*
 * Aufbau wie die erweiterte Dynamic Island:
 *   [Cover] Titel / Künstler                 [EQ]
 *   0:52 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -3:10
 *              ⏮      ⏯      ⏭
 */
export function NowPlayingView() {
  const np = useNowPlaying();
  if (!np) return <Empty />;

  return (
    <div className="flex h-full flex-col px-5 pt-1 pb-2">
      <div className="flex items-center gap-3">
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
        <Equalizer playing={np.isPlaying} height={16} />
      </div>
      <Progress np={np} />
      <Controls playing={np.isPlaying} />
    </div>
  );
}

/** Geteilt mit der Übersicht: Klick auf die Aktivität lässt das Cover hierher fliegen. */
export const ARTWORK_LAYOUT_ID = "now-playing-artwork";

function Artwork({ np }: { np: NowPlaying }) {
  return (
    // Äußere Hülle fliegt (Layout), innere skaliert bei Pause — getrennt, sonst streiten beide um transform.
    <motion.div layoutId={ARTWORK_LAYOUT_ID} transition={springs.morph} className="size-14 shrink-0">
      {/* Pausiert: Cover schrumpft leicht zurück und dunkelt ab, wie bei Apple Music. */}
      <motion.div
        className="relative size-14 shrink-0"
        initial={false}
        animate={{ transform: np.isPlaying ? "scale(1)" : "scale(0.9)" }}
        transition={springs.snappy}
      >
        <AnimatePresence initial={false}>
          {np.artwork ? (
            <motion.img
              key={np.artwork}
              src={np.artwork}
              alt=""
              draggable={false}
              className="absolute inset-0 size-full rounded-[12px] object-cover"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.4 } }}
              exit={{ opacity: 0, transition: { duration: 0.4 } }}
            />
          ) : (
            // Kein Cover (manche Browser-Player): ruhiger Platzhalter statt Lücke.
            <motion.div
              key="placeholder"
              className="absolute inset-0 flex items-center justify-center rounded-[12px] bg-fill-2 text-label-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.4 } }}
              exit={{ opacity: 0, transition: { duration: 0.4 } }}
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
      </motion.div>
    </motion.div>
  );
}

/**
 * Fortschritt + Spulen. Ziehen oder Klicken springt an die Stelle; beim Greifen wird
 * der Balken dicker und heller, die Zeiten zeigen die Zielposition (wie Apple Music).
 * Der Sprung passiert erst beim Loslassen — ein Seek pro Geste.
 */
function Progress({ np }: { np: NowPlaying }) {
  const track = useRef<HTMLDivElement>(null);
  // Zielposition (0..1) während des Ziehens; Ref für den Frame-Loop, State für die Zeiten.
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
  // Verschieben statt Strecken: kein verzerrtes rundes Ende, keine Raster-Artefakte beim Spulen.
  const transform = useTransform(progress, (p) => `translateX(${((p - 1) * 100).toFixed(3)}%)`);

  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Unbekannte Dauer (Livestream): Zeile bleibt als Platzhalter, damit nichts springt.
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
      {/* Trefferzone höher als der Balken, damit man ihn leicht greift. */}
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
    <div className="mt-2 flex items-center justify-center gap-6">
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
