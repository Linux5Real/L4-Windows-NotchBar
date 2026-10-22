import { useEffect, useRef, useState, useMemo } from "react";
import {
  AnimatePresence,
  motion,
  useAnimationFrame,
  useMotionValue,
  useTransform,
} from "motion/react";
import {
  ArrowUpRight,
  MusicNoteSimple,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "@phosphor-icons/react";
import { artwork as artworkSwap, content, springs } from "../../design/motion";
import { useSmoothArtwork } from "./artwork";
import {
  livePosition,
  media,
  useNowPlaying,
  type NowPlaying,
} from "../../platform/media";
import { holdOpen } from "../../notch/useNotchState";
import { requestSize } from "../../notch/size";
import { findTab } from "../../notch/tabs";
import {
  MIXER_MAX_ROWS,
  MIXER_ROW,
  MixerList,
  MixerToggle,
  useMixer,
} from "./Mixer";
import { Equalizer } from "./Equalizer";
import { t } from "../../i18n";

// --- 1. Parser & Hook for Lyrics ---

interface LyricLine {
  time: number;
  text: string;
}

function useSyncedLyrics(title?: string, artist?: string) {
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (!title || !artist) {
      setLyrics([]);
      setSynced(false);
      return;
    }

    const fetchLyrics = async () => {
      try {
        const params = new URLSearchParams({
          track_name: title,
          artist_name: artist,
        });
        const res = await fetch(`https://lrclib.net/api/get?${params}`);
        if (!res.ok) throw new Error("Not found");

        const data = await res.json();
        if (data.syncedLyrics) {
          const lines = data.syncedLyrics.split("\n");
          const parsed: LyricLine[] = [];
          const timeRegex = /\[(\d{2}):(\d{2}(\.\d{2,3})?)\](.*)/;

          for (const line of lines) {
            const match = timeRegex.exec(line);
            if (match) {
              const minutes = parseInt(match[1], 10);
              const seconds = parseFloat(match[2]);
              const text = match[4].trim();
              if (text) parsed.push({ time: minutes * 60 + seconds, text });
            }
          }
          setLyrics(parsed);
          setSynced(parsed.length > 0);
        } else {
          setLyrics([]);
          setSynced(false);
        }
      } catch (error) {
        setLyrics([]);
        setSynced(false);
      }
    };

    void fetchLyrics();
  }, [title, artist]);

  return { lyrics, synced };
}

// --- 2. Main Components NowPlayingView ---

export function NowPlayingView() {
  const np = useNowPlaying();
  const mix = useMixer();
  const [mixerOpen, setMixerOpen] = useState(false);
  const source = mix.source?.name;

  // Get lyrics data in the background
  const { lyrics, synced } = useSyncedLyrics(np?.title, np?.artist);
  const hasLyrics = synced && lyrics.length > 0;
  const LYRICS_HEIGHT = hasLyrics ? 64 : 0; // Additional height for the lyrics container

  // The mixer grows the notch by its rows (at most MIXER_MAX_ROWS, then it scrolls).
  const rows = Math.min(
    MIXER_MAX_ROWS,
    (mix.system ? 1 : 0) + Math.max(1, mix.apps.length),
  );

  useEffect(() => {
    if (!mixerOpen && !hasLyrics && !np) return requestSize("media", null);
    const base = findTab("media")!.size;
    // Add LYRICS_HEIGHT to the Dynamic Island size calculation
    requestSize("media", {
      w: base.w,
      h: base.h + (mixerOpen ? rows * MIXER_ROW : 0) + 14 + LYRICS_HEIGHT,
    });
  }, [mixerOpen, rows, !!np, hasLyrics]);

  useEffect(() => () => requestSize("media", null), []);

  if (!np) return <Empty />;

  return (
    <div className="flex h-full flex-col px-5 pt-1 pb-2">
      <div className="flex items-center gap-3">
        <button
          onClick={() => void media.openSource()}
          title={
            source ? t("In {app} öffnen", { app: source }) : t("App öffnen")
          }
          className="group/source pressable flex min-w-0 flex-1 items-center gap-3 rounded-[12px] text-left"
        >
          <Artwork np={np} />
          <div className="relative min-w-0 flex-1">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={np.title}
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{
                  opacity: 1,
                  filter: "blur(0px)",
                  transition: content.enter,
                }}
                exit={{
                  opacity: 0,
                  filter: "blur(4px)",
                  transition: content.exit,
                }}
              >
                <div className="truncate text-title font-semibold">
                  {np.title}
                </div>
                <div className="truncate text-body text-label-2">
                  {np.artist}
                </div>
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
          <MixerToggle
            open={mixerOpen}
            onToggle={() => setMixerOpen((o) => !o)}
          />
        </div>
      </div>

      {/* Container for Live Lyrics */}
      <AnimatePresence>
        {hasLyrics && <LiveLyricsBox key="lyrics" np={np} lyrics={lyrics} />}
      </AnimatePresence>

      <AnimatePresence>
        {mixerOpen && <MixerList key="mixer" data={mix} />}
      </AnimatePresence>
    </div>
  );
}

// --- 3. Component for Live Lyrics (Rolling View) ---

function LiveLyricsBox({
  np,
  lyrics,
}: {
  np: NowPlaying;
  lyrics: LyricLine[];
}) {
  const [pos, setPos] = useState(() => livePosition(np));

  // Self-contained ticker to stay in sync with audio (without re-rendering the entire Island)
  useEffect(() => {
    const id = setInterval(() => setPos(livePosition(np)), 300);
    return () => clearInterval(id);
  }, [np]);

  // Find the currently active line (subtracted by 0.3s for a smooth transition in the ears)
  const activeIndex = useMemo(() => {
    for (let i = lyrics.length - 1; i >= 0; i--) {
      if (pos >= lyrics[i].time - 0.3) return i;
    }
    return -1;
  }, [lyrics, pos]);

  const activeLine = activeIndex >= 0 ? lyrics[activeIndex].text : "•••";

  return (
    <motion.div
      initial={{ opacity: 0, height: 0, marginTop: 0 }}
      animate={{ opacity: 1, height: 52, marginTop: 12 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      className="relative flex items-center justify-center overflow-hidden rounded-[12px] bg-fill-2 px-4 shadow-inner"
      style={{
        maskImage:
          "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
      }}
    >
      <AnimatePresence mode="popLayout">
        <motion.div
          key={activeIndex}
          initial={{ opacity: 0, y: 15, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{
            opacity: 0,
            y: -15,
            filter: "blur(4px)",
            position: "absolute",
          }}
          transition={springs.snappy}
          className="w-full text-center text-footnote font-semibold text-label drop-shadow-sm line-clamp-2"
        >
          {activeLine}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

// --- Main Components ---

export const ARTWORK_LAYOUT_ID = "now-playing-artwork";

function Artwork({ np }: { np: NowPlaying }) {
  const artwork = useSmoothArtwork(np.artwork);
  return (
    <motion.div
      layoutId={ARTWORK_LAYOUT_ID}
      transition={springs.morph}
      className="size-14 shrink-0"
    >
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
              animate={{
                opacity: 1,
                filter: "blur(0px)",
                transition: artworkSwap.enter,
              }}
              exit={{ opacity: 0, transition: artworkSwap.exit }}
            />
          ) : (
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
          animate={{
            backgroundColor: np.isPlaying
              ? "rgb(0 0 0 / 0)"
              : "rgb(0 0 0 / 0.35)",
          }}
          transition={{ duration: 0.25 }}
        />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[12px] bg-black/45 text-label opacity-0 transition-opacity duration-150 group-hover/source:opacity-100">
          <ArrowUpRight size={20} weight="bold" />
        </span>
      </motion.div>
    </motion.div>
  );
}

function Progress({ np }: { np: NowPlaying }) {
  const track = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const npRef = useRef(np);
  npRef.current = np;

  const ratio = () => {
    const n = npRef.current;
    return (
      scrubRef.current ?? (n.duration > 0 ? livePosition(n) / n.duration : 0)
    );
  };
  const progress = useMotionValue(ratio());
  useAnimationFrame(() => progress.set(ratio()));
  const transform = useTransform(
    progress,
    (p) => `translateX(${((p - 1) * 100).toFixed(3)}%)`,
  );

  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

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
      <span
        className={`tabular w-9 text-caption font-medium transition-colors duration-150 ${scrub !== null ? "text-label" : "text-label-3"}`}
      >
        {format(pos)}
      </span>
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
      <span
        className={`tabular w-9 text-right text-caption font-medium transition-colors duration-150 ${scrub !== null ? "text-label" : "text-label-3"}`}
      >
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
      <IconButton
        label={playing ? t("Pause") : t("Abspielen")}
        onClick={media.toggle}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={playing ? "pause" : "play"}
            className="flex"
            initial={{
              opacity: 0,
              transform: "scale(0.6)",
              filter: "blur(3px)",
            }}
            animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
            exit={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
          >
            {playing ? (
              <Pause size={26} weight="fill" />
            ) : (
              <Play size={26} weight="fill" />
            )}
          </motion.span>
        </AnimatePresence>
      </IconButton>
      <IconButton label={t("Weiter")} onClick={media.next}>
        <SkipForward size={20} weight="fill" />
      </IconButton>
    </div>
  );
}

function IconButton(props: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
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
    <div className="flex h-full items-center justify-center text-body text-label-3">
      {t("Gerade läuft nichts")}
    </div>
  );
}

function format(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
