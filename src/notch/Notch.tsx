import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type RefObject,
} from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { GearSix, PushPin, Selection } from "@phosphor-icons/react";
import { content, springs } from "../design/motion";
import {
  useNowPlaying,
  livePosition,
  type NowPlaying,
} from "../platform/media";
import {
  isNative,
  keyboardFocus,
  onNativeBlur,
  onNativeHover,
  onShortcut,
  onTrayOpen,
  setHitRect,
  setMemoryLow,
} from "../platform/native";
import { PrivacyDots } from "../features/privacy/PrivacyDots";
import { FOCUS_CLICKS, focusMode, setFocusMode } from "./focus";
import { useDragToMove } from "./drag";
import { LiveSlot, useLiveActivity } from "./live";
import {
  DOCK_HEIGHT,
  HEADER_HEIGHT,
  geometry,
  openGeometry,
  type NotchGeometry,
} from "./geometry";
import { HeaderButton, headerSlot } from "./header";
import { sizeOverride } from "./size";
import { NotchShape } from "./NotchShape";
import { drop } from "../platform/drop";
import { settings } from "../settings/store";
import { useUnseen } from "../lib/changelog";
import { nav, navigate } from "./nav";
import { update } from "../lib/update";
import { findTab, settingsTab, tabs, type NotchTab } from "./tabs";
import {
  holdOpen,
  pinned,
  togglePin,
  useNotchState,
  type NotchStatus,
} from "./useNotchState";
import { t } from "../i18n";
import { timer } from "../features/timer/store";

const RESUME_MS = 60_000;
const MEMORY_LOW_AFTER_MS = 20_000;

export function Notch() {
  const {
    status,
    open,
    close,
    dismiss,
    toggle,
    onPointerEnter,
    onPointerLeave,
  } = useNotchState();
  const focus = focusMode.use();

  // [1] READ MUSIC SETTINGS FROM THE STORE
  const {
    tools: toolSettings,
    display: displaySettings,
    music,
  } = settings.use();
  const musicSettings = music || { showLyrics: true, lyricsLines: "2" };

  const line = focus && displaySettings.focusStyle === "line";
  const timerDone = timer.use().finished;
  const idleLine = !focus && displaySettings.idleStyle === "line";
  const alert = idleLine && timerDone;
  const visible = toolSettings
    .filter((t) => t.enabled)
    .map((t) => findTab(t.id))
    .filter((t): t is NotchTab => !!t);
  const { tabId } = nav.use();

  const tab =
    tabId === settingsTab.id
      ? settingsTab
      : (visible.find((t) => t.id === tabId) ?? visible[0] ?? tabs[0]);
  const np = useNowPlaying();
  const live = useLiveActivity();

  // --- [FITUR BARU] Pembersih Teks Cerdas untuk YouTube / Browser ---
  const { cleanTitle, cleanArtist } = useMemo(() => {
    if (!np?.title) return { cleanTitle: "", cleanArtist: "" };

    let t = np.title;
    let a = np.artist || "";

    // 1. Buang embel-embel khas YouTube: (Official Video), [Lyrics], (Audio), dll.
    t = t
      .replace(
        /[\[\(](official|lyric|audio|video|music|visualizer|hd|hq).*?[\]\)]/gi,
        "",
      )
      .trim();

    // 2. Jika judul mengandung " - " (Format YouTube: "Artis - Judul")
    if (t.includes(" - ")) {
      const parts = t.split(" - ");
      // Deteksi jika artist yang dikirim OS malah nama browser
      const isBrowser = /chrome|edge|brave|firefox|opera/i.test(a);

      // Jika artis kosong, bernama browser, atau bertuliskan "YouTube", ambil artis dari judul!
      if (!a || isBrowser || a === "YouTube") {
        a = parts[0].trim();
        t = parts.slice(1).join(" - ").trim();
      }
    }

    return { cleanTitle: t, cleanArtist: a };
  }, [np?.title, np?.artist]);
  // ------------------------------------------------------------------

  // Gunakan cleanTitle dan cleanArtist yang sudah dibersihkan ke LRCLIB
  const { lyrics, synced } = useSyncedLyrics(
    cleanTitle,
    cleanArtist,
    np?.duration || (np as any)?.length,
  );

  // [2] USE THE 'showLyrics' TOGGLE AS A CONDITION
  const showCompactLyrics = Boolean(
    musicSettings.showLyrics &&
    status !== "open" &&
    np?.isPlaying &&
    synced &&
    lyrics.length > 0 &&
    !line &&
    !alert &&
    !idleLine,
  );

  const [visibleLyrics, setVisibleLyrics] = useState({ current: "", next: "" });

  const prevStatus = useRef(status);
  const closedAt = useRef(0);
  const trayTab = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (status === "open" && prevStatus.current !== "open") {
      const resumed = Date.now() - closedAt.current < RESUME_MS;
      if (trayTab.current) navigate(trayTab.current);
      else if (!resumed && live.id && visible.some((t) => t.id === live.id))
        navigate(live.id);
      trayTab.current = null;
    }
    if (status !== "open" && prevStatus.current === "open")
      closedAt.current = Date.now();
    prevStatus.current = status;
  });

  useQuickDrop(status, open, dismiss);

  const override = sizeOverride.use();
  const size = override?.tabId === tab.id ? override : tab.size;
  const shownLive = line ? null : idleLine ? (alert ? "timer" : null) : live.id;
  const lineIdle = idleLine && !alert;

  const shape =
    line || (lineIdle && status === "closed")
      ? geometry.line
      : lineIdle && status === "peek"
        ? geometry.linePeek
        : shapeFor(
            status,
            shownLive,
            size,
            showCompactLyrics ? visibleLyrics : { current: "", next: "" },
          );

  const tightHit = shape === geometry.line || shape === geometry.linePeek;
  const sticky = useStickyHitZone(status, size.h);
  const transition = useTransitionFor(status, shape);

  const hitRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!hitRef.current?.contains(e.target as Node)) dismiss();
    };
    window.addEventListener("pointerdown", onDown);
    const offBlur = onNativeBlur(dismiss);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      offBlur();
    };
  }, [dismiss]);

  useNativeBridge(hitRef, onPointerEnter, onPointerLeave);
  const drag = useDragToMove(status);

  useEffect(() => {
    if (focus) close();
  }, [focus, close]);

  const onClick = (e: React.MouseEvent) => {
    if (drag.moved()) return;
    if (e.detail >= FOCUS_CLICKS && !isInteractive(e.target))
      return setFocusMode(!focus);
    if (!focus && status !== "open") open();
  };

  useEffect(
    () => onShortcut(() => toggle() === "open" && keyboardFocus(true)),
    [toggle],
  );
  useEffect(
    () =>
      onTrayOpen((tab) => {
        trayTab.current = status === "open" ? null : tab;
        if (tab) navigate(tab);
        open();
        keyboardFocus(true);
      }),
    [open, status],
  );
  useEffect(() => {
    if (status === "closed") keyboardFocus(false);
  }, [status]);

  useEffect(() => {
    if (status !== "closed") return setMemoryLow(false);
    const id = window.setTimeout(() => setMemoryLow(true), MEMORY_LOW_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  useEffect(() => {
    if (status !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const tab = visible[Number(e.key) - 1];
      if (tab) navigate(tab.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, visible]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center transition-opacity duration-200"
      style={{
        ["--accent" as string]: np?.accent,
        opacity: focus && !line ? 0.5 : 1,
        transform: isNative ? undefined : `translateX(${drag.offset}px)`,
      }}
    >
      <div
        ref={hitRef}
        data-notch-hit
        className={`pointer-events-auto ${tightHit ? "px-1 pb-1" : "px-4 pb-3"}`}
        style={{
          minHeight: sticky.minHeight,
          cursor: drag.dragging ? "grabbing" : undefined,
        }}
        onPointerMove={sticky.onPointerMove}
        onPointerDown={focus ? undefined : drag.onPointerDown}
        onPointerEnter={isNative || focus ? undefined : onPointerEnter}
        onPointerLeave={isNative || focus ? undefined : onPointerLeave}
        onClick={onClick}
      >
        <NotchShape
          geometry={shape}
          transition={transition}
          elevated={status === "open"}
        >
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative w-full" style={{ height: 36 }}>
              <LiveSlot id={status === "open" ? null : shownLive} />
            </div>
          </div>

          <AnimatePresence>
            {showCompactLyrics && np && (
              <CompactLiveLyrics
                key="lyrics"
                np={np}
                lyrics={lyrics}
                onLyricsChange={setVisibleLyrics}
                linesCount={musicSettings.lyricsLines} // [3] PASS LINE SETTINGS TO COMPONENT
              />
            )}
          </AnimatePresence>

          {!line && !idleLine && <PrivacyDots />}

          <AnimatePresence>
            {status === "open" && (
              <motion.div
                key="open"
                className="absolute top-0 left-1/2 flex flex-col"
                style={{
                  width: size.w,
                  height: size.h,
                  marginLeft: -size.w / 2,
                }}
                initial={{
                  opacity: 0,
                  transform: "translateY(-6px)",
                  filter: "blur(6px)",
                }}
                animate={{
                  opacity: 1,
                  transform: "translateY(0px)",
                  filter: "blur(0px)",
                  transition: content.enter,
                }}
                exit={{
                  opacity: 0,
                  transform: "translateY(-4px)",
                  filter: "blur(4px)",
                  transition: content.exit,
                }}
              >
                <Header title={t(tab.label)} onDragStart={drag.onPointerDown} />
                <div className="relative min-h-0 flex-1 overflow-clip">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={tab.id}
                      className="absolute inset-0"
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
                      <tab.View />
                    </motion.div>
                  </AnimatePresence>
                </div>
                <Dock tabs={visible} activeId={tab.id} />
              </motion.div>
            )}
          </AnimatePresence>
        </NotchShape>
      </div>
    </div>
  );
}

// ==========================================
// Component & Hook for Live Lyrics
// ==========================================

interface LyricLine {
  time: number;
  text: string;
}

const lyricCache = new Map<string, Promise<LyricLine[]>>();

function useSyncedLyrics(
  title?: string,
  artist?: string,
  rawDuration?: number,
) {
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (!title || !artist) {
      setLyrics([]);
      setSynced(false);
      return;
    }

    let isCurrentSong = true;

    let secDuration = rawDuration || 0;
    if (secDuration > 1000) {
      secDuration = secDuration / 1000;
    }
    secDuration = Math.round(secDuration);

    const cacheKey = `${title}-${artist}-${secDuration}`;

    const fetchLrc = async () => {
      try {
        const params: Record<string, string> = {
          track_name: title,
          artist_name: artist,
        };

        if (secDuration > 0) {
          params.duration = secDuration.toString();
        }

        const queryParams = new URLSearchParams(params);

        let res = await fetch(`https://lrclib.net/api/get?${queryParams}`);
        let data = await res.json();

        if (!res.ok || !data.syncedLyrics) {
          const searchRes = await fetch(
            `https://lrclib.net/api/search?${queryParams}`,
          );
          const searchData = await searchRes.json();
          if (Array.isArray(searchData) && searchData.length > 0) {
            data = secDuration
              ? searchData.reduce((prev, curr) =>
                  Math.abs(curr.duration - secDuration) <
                  Math.abs(prev.duration - secDuration)
                    ? curr
                    : prev,
                )
              : searchData[0];
          }
        }

        if (data && data.syncedLyrics) {
          const lines = data.syncedLyrics.split("\n");
          const parsed: LyricLine[] = [];
          const timeRegex = /\[(\d{2}):(\d{2}(\.\d{2,3})?)\](.*)/;

          for (const line of lines) {
            const match = timeRegex.exec(line);
            if (match && match[4].trim()) {
              parsed.push({
                time: parseInt(match[1]) * 60 + parseFloat(match[2]),
                text: match[4].trim(),
              });
            }
          }

          if (
            secDuration > 0 &&
            data.duration &&
            Math.abs(data.duration - secDuration) > 1
          ) {
            const ratio = secDuration / data.duration;
            return parsed.map((line) => ({
              ...line,
              time: line.time * ratio,
            }));
          }

          return parsed;
        }
        return [];
      } catch {
        return [];
      }
    };

    if (!lyricCache.has(cacheKey)) {
      lyricCache.set(cacheKey, fetchLrc());
    }

    lyricCache.get(cacheKey)!.then((parsed) => {
      if (isCurrentSong) {
        setLyrics(parsed);
        setSynced(parsed.length > 0);
      }
    });

    return () => {
      isCurrentSong = false;
    };
  }, [title, artist, rawDuration]);

  return { lyrics, synced };
}

function CompactLiveLyrics({
  np,
  lyrics,
  onLyricsChange,
  linesCount,
}: {
  np: NowPlaying;
  lyrics: LyricLine[];
  onLyricsChange: (lines: { current: string; next: string }) => void;
  linesCount: string;
}) {
  const [pos, setPos] = useState(() => (np ? livePosition(np) : 0));

  const npRef = useRef(np);
  npRef.current = np;

  // [1] Naikkan frekuensi check jadi 150ms agar pergerakan waktu jauh lebih presisi/smooth
  useEffect(() => {
    const id = setInterval(() => {
      if (npRef.current) {
        try {
          setPos(livePosition(npRef.current));
        } catch (error) {
          // ignore
        }
      }
    }, 150);
    return () => clearInterval(id);
  }, []);

  const activeIndex = useMemo(() => {
    if (!lyrics || lyrics.length === 0) return -1;
    for (let i = lyrics.length - 1; i >= 0; i--) {
      const offset = 0.2;
      if (pos >= lyrics[i].time - offset) {
        return i;
      }
    }
    return -1;
  }, [lyrics, pos]);

  const currentLine = activeIndex >= 0 ? lyrics[activeIndex].text : "";
  const nextLine =
    activeIndex + 1 < lyrics.length && linesCount === "2"
      ? lyrics[activeIndex + 1].text
      : "";

  useEffect(() => {
    onLyricsChange({ current: currentLine, next: nextLine });
  }, [currentLine, nextLine, onLyricsChange]);

  useEffect(() => {
    return () => onLyricsChange({ current: "", next: "" });
  }, [onLyricsChange]);

  if (!currentLine && !nextLine) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center px-9"
      style={{
        maskImage:
          "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
      }}
    >
      <AnimatePresence mode="popLayout">
        <motion.div
          key={activeIndex}
          initial={{ opacity: 0, y: 16, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{
            opacity: 0,
            y: -16,
            filter: "blur(4px)",
            position: "absolute",
          }}
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
          className="flex flex-col items-center justify-center whitespace-nowrap"
        >
          {currentLine && (
            <span className="text-footnote font-medium text-label drop-shadow-sm">
              {currentLine}
            </span>
          )}
          {nextLine && (
            <span
              className="text-caption font-medium text-label-3 mt-[2px] opacity-70"
              style={{ filter: "blur(0.8px)" }}
            >
              {nextLine}
            </span>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Header({
  title,
  onDragStart,
}: {
  title: string;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const isPinned = pinned.use();
  return (
    <div
      data-drag-handle
      onPointerDown={onDragStart}
      className="flex shrink-0 items-center justify-between gap-3 pr-3 pl-5"
      style={{ height: HEADER_HEIGHT + 4 }}
    >
      <div className="relative min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.h2
            key={title}
            className="truncate text-title font-semibold"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{
              opacity: 1,
              filter: "blur(0px)",
              transition: content.enter,
            }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            {title}
          </motion.h2>
        </AnimatePresence>
      </div>
      <div className="flex items-center gap-1">
        <div ref={(el) => headerSlot.set(el)} className="grid" />
        <HeaderButton
          label={t("Fokus-Modus (3× klicken zum Beenden)")}
          onClick={() => setFocusMode(true)}
        >
          <Selection size={14} weight="bold" />
        </HeaderButton>
        <HeaderButton
          label={isPinned ? t("Lösen") : t("Offen halten")}
          active={isPinned}
          onClick={togglePin}
        >
          <PushPin size={14} weight={isPinned ? "fill" : "bold"} />
        </HeaderButton>
      </div>
    </div>
  );
}

function Dock({ tabs, activeId }: { tabs: NotchTab[]; activeId: string }) {
  const lastTool = useRef(tabs[0]?.id);
  if (activeId !== settingsTab.id) lastTool.current = activeId;
  const inSettings = activeId === settingsTab.id;
  const updateReady = update.use().phase === "available";
  const unseen = useUnseen().length > 0;
  const badge = updateReady || unseen;

  return (
    <div
      className="flex shrink-0 items-start justify-center gap-0.5 px-4 pt-1"
      style={{ height: DOCK_HEIGHT }}
    >
      {tabs.map((tab) => (
        <DockButton
          key={tab.id}
          label={t(tab.label)}
          icon={tab.icon}
          active={tab.id === activeId}
          onClick={() => navigate(tab.id)}
        />
      ))}
      <span aria-hidden className="mx-1.5 mt-2 h-4 w-px bg-separator" />
      <DockButton
        label={t(settingsTab.label)}
        icon={GearSix}
        active={inSettings}
        badge={badge}
        onClick={() =>
          inSettings
            ? navigate(lastTool.current ?? tabs[0].id)
            : navigate(settingsTab.id, badge ? "updates" : null)
        }
      />
    </div>
  );
}

function DockButton(props: {
  label: string;
  icon: NotchTab["icon"];
  active: boolean;
  onClick: () => void;
  badge?: boolean;
}) {
  const I = props.icon;
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={`pressable relative flex h-8 w-8 items-center justify-center rounded-[10px] ${
        props.active ? "text-label" : "text-label-3 hover:text-label-2"
      }`}
    >
      {props.active && (
        <motion.span
          layoutId="dock-pill"
          className="absolute inset-0 rounded-[10px] bg-fill-2"
          transition={springs.snappy}
        />
      )}
      <I
        size={16}
        weight={props.active ? "fill" : "bold"}
        className="relative"
      />
      <AnimatePresence>
        {props.badge && (
          <motion.span
            className="absolute top-1 right-1 size-[7px] rounded-full bg-link ring-2 ring-notch"
            initial={{ opacity: 0, transform: "scale(0.9)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.9)" }}
            transition={springs.snappy}
          />
        )}
      </AnimatePresence>
    </button>
  );
}

function useStickyHitZone(status: NotchStatus, height: number) {
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
  const prev = useRef(height);
  useLayoutEffect(() => {
    if (status !== "open") setMinHeight(undefined);
    else if (height < prev.current) {
      const from = prev.current + HIT_PAD_BOTTOM;
      setMinHeight((m) => Math.max(m ?? 0, from));
    }
    prev.current = height;
  }, [status, height]);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (minHeight === undefined) return;
    const shapeBottom = e.currentTarget.getBoundingClientRect().top + height;
    if (e.clientY < shapeBottom) setMinHeight(undefined);
  };
  return { minHeight, onPointerMove };
}

const HIT_PAD_BOTTOM = 12;

function shapeFor(
  status: NotchStatus,
  live: string | null,
  size: { w: number; h: number },
  visibleLyrics: { current: string; next: string },
): NotchGeometry {
  if (status === "open") return openGeometry(size.w, size.h);
  const base =
    live === "system"
      ? geometry.gaming
      : live
        ? geometry.live
        : geometry.closed;

  let w = base.w;
  let h = base.h;

  if (visibleLyrics.current || visibleLyrics.next) {
    // Safety 2: Special width calculation for Korean / Asian characters
    const getDisplayLength = (str: string) => {
      let len = 0;
      for (let i = 0; i < str.length; i++) {
        // If the Unicode character is above 255 (Korean/Japanese/Chinese), consider its width as 1.8x
        len += str.charCodeAt(i) > 255 ? 1.8 : 1;
      }
      return len;
    };

    const maxLen = Math.max(
      getDisplayLength(visibleLyrics.current),
      getDisplayLength(visibleLyrics.next),
    );

    w = Math.min(800, Math.max(base.w + 60, maxLen * 7.2 + 96));

    if (visibleLyrics.next) {
      h = Math.max(base.h, 58);
    }
  }

  if (status === "peek") {
    const bump = geometry.peek.w - geometry.closed.w;
    return { ...geometry.peek, w: w + bump, h };
  }
  return { ...base, w, h };
}

function useTransitionFor(
  status: NotchStatus,
  shape: NotchGeometry,
): Transition {
  const prev = useRef(status);
  const key = `${shape.w}x${shape.h}`;
  const prevKey = useRef(key);

  let t: Transition;
  if (status === "open")
    t = prev.current === "open" ? springs.morph : springs.open;
  else if (status === "peek") t = springs.peek;
  else t = prev.current === "open" ? springs.close : springs.morph;

  const stable = useRef(t);
  if (prevKey.current !== key) stable.current = t;

  useEffect(() => {
    prev.current = status;
    prevKey.current = key;
  });

  return stable.current;
}

function useQuickDrop(
  status: NotchStatus,
  open: () => void,
  dismiss: () => void,
) {
  const openedByDrag = useRef(false);
  const fileTool = useRef<"shelf" | "convert">("convert");
  useEffect(
    () =>
      nav.subscribe(() => {
        const id = nav.get().tabId;
        if (id === "shelf" || id === "convert") fileTool.current = id;
      }),
    [],
  );
  const holding = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(
    () =>
      drop.subscribe(() => {
        const { dragging, dropped } = drop.get();
        if (dragging && !holding.current) {
          holding.current = true;
          holdOpen(true);
          if (statusRef.current !== "open") {
            openedByDrag.current = true;
            open();
          }
          const current = nav.get().tabId;
          if (current !== "shelf" && current !== "convert")
            navigate(fileTool.current);
        } else if (!dragging && holding.current) {
          holding.current = false;
          holdOpen(false);
          if (!dropped && openedByDrag.current) dismiss();
          openedByDrag.current = false;
        }
      }),
    [open, dismiss],
  );
}

function useNativeBridge(
  hitRef: RefObject<HTMLDivElement | null>,
  onEnter: () => void,
  onLeave: () => void,
) {
  useEffect(() => {
    const el = hitRef.current;
    if (!isNative || !el) return;

    const report = () => {
      const r = el.getBoundingClientRect();
      setHitRect({ x: r.x, y: r.y, w: r.width, h: r.height });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();

    const offHover = onNativeHover((inside) =>
      inside ? onEnter() : onLeave(),
    );
    let typing = false;
    const onFocusIn = (e: FocusEvent) => {
      if (isTextField(e.target) && !typing) holdOpen((typing = true));
    };
    const onFocusOut = (e: FocusEvent) => {
      if (typing && !isTextField(e.relatedTarget)) holdOpen((typing = false));
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);

    return () => {
      ro.disconnect();
      offHover();
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      if (typing) holdOpen(false);
    };
  }, [hitRef, onEnter, onLeave]);
}

function isInteractive(el: EventTarget | null): boolean {
  return (
    el instanceof Element &&
    !!el.closest("button, input, textarea, a, [role=slider]")
  );
}

function isTextField(el: EventTarget | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
