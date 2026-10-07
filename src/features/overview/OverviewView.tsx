import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Eye, EyeSlash, Moon, MusicNoteSimple, SpeakerHigh, SpeakerLow, SpeakerNone, SpeakerSimpleSlash, Timer } from "@phosphor-icons/react";
import { DiscordLogo } from "../../ui/brands";
import { content, springs } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { togglePresentation, usePresenting } from "../privacy/store";
import { useNowPlaying } from "../../platform/media";
import { systemControls, type FocusState, type VolumeState } from "../../platform/services";
import { useDiscordCall } from "../discord/store";
import { Equalizer } from "../now-playing/Equalizer";
import { ARTWORK_LAYOUT_ID } from "../now-playing/NowPlayingView";
import { formatClock, timer, useRemaining } from "../timer/store";
import { describe, useForecast } from "../weather/store";
import { settings } from "../../settings/store";
import { formatTemp, formatTimeParts } from "../../lib/format";
import { locale, t } from "../../i18n";

/*
 *   14:32                                    ☀ 18°
 *   Sunday, 5 October                Vienna · Clear
 *   ┌──────────────────────────────────────────────┐
 *   │ ▣ Song – Artist                        ▮▮▮▮  │   ← what's playing (click opens the tool)
 *   └──────────────────────────────────────────────┘
 *   [☾ Focus  ]  [🔊 ━━━━━━━━━━━━━━━━━━━━━━━  42 %]
 *
 * Like Control Center: an overview plus the two toggles you need all the time.
 */
export function OverviewView() {
  const presenting = usePresenting();
  return (
    <div className="flex h-full flex-col gap-2.5 px-4 pt-1 pb-3">
      <HeaderActions>
        <HeaderButton label={presenting ? t("Präsentationsmodus beenden") : t("Präsentationsmodus")} active={presenting} onClick={togglePresentation}>
          {presenting ? <EyeSlash size={14} weight="fill" /> : <Eye size={14} weight="bold" />}
        </HeaderButton>
      </HeaderActions>
      <Header />
      <Activity />
      <div className="flex gap-2">
        <FocusTile />
        <VolumeTile />
      </div>
    </div>
  );
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Header() {
  const now = useNow();
  const forecast = useForecast();
  const place = settings.use().weather;
  const weather = forecast && forecast !== "error" ? describe(forecast.current.code, forecast.current.day) : null;
  const { time, period } = formatTimeParts(now);
  const date = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(now);

  return (
    <div className="flex items-end justify-between">
      <div>
        <div className="tabular text-[34px] leading-none font-semibold tracking-[-0.03em] text-label">
          {time}
          {period && <span className="ml-1 text-title font-semibold tracking-normal text-label-3">{period}</span>}
        </div>
        <div className="mt-1 text-footnote text-label-3">{date}</div>
      </div>
      <button onClick={() => navigate("weather")} className="pressable flex flex-col items-end text-right" title={t("Wetter öffnen")}>
        <AnimatePresence mode="popLayout" initial={false}>
          {weather && forecast && forecast !== "error" ? (
            <motion.div
              key="w"
              className="flex items-center gap-1.5"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            >
              <weather.icon size={22} weight="fill" className="text-label" />
              <span className="tabular text-[22px] leading-none font-semibold tracking-[-0.02em] text-label">{formatTemp(forecast.current.temp)}</span>
            </motion.div>
          ) : (
            <motion.div key="s" className="h-[22px] w-16 rounded-[6px] bg-fill-1" exit={{ opacity: 0, transition: content.exit }} />
          )}
        </AnimatePresence>
        <div className="mt-1 max-w-[220px] truncate text-footnote text-label-3">
          {place ? `${place.name}${weather ? ` · ${weather.text}` : ""}` : t("Ort wird erkannt …")}
        </div>
      </button>
    </div>
  );
}

/** What's running, in the same priority as the closed notch: timer, call, music. */
function Activity() {
  const np = useNowPlaying();
  const call = useDiscordCall();
  const tm = timer.use();
  const remaining = useRemaining();
  const timerLive = tm.endsAt !== null || tm.finished;

  let item: { key: string; tab: string; icon: ReactNode; title: string; detail: string; trailing?: ReactNode } | null = null;
  if (timerLive) {
    item = {
      key: "timer",
      tab: "timer",
      icon: <Timer size={18} weight="bold" className={tm.mode === "focus" ? "text-orange" : "text-green"} />,
      title: tm.finished ? t(tm.mode === "focus" ? "Fokus abgelaufen" : "Pause abgelaufen") : t(tm.mode === "focus" ? "Fokus" : "Pause"),
      detail: tm.finished ? t("Zum Schließen öffnen") : t("noch {time}", { time: formatClock(remaining) }),
    };
  } else if (call) {
    item = {
      key: "discord",
      tab: "discord",
      icon: <DiscordLogo size={18} weight="fill" className="text-label" />,
      title: call.channelName,
      detail: [call.guildName, t(call.members.length === 1 ? "{n} Person" : "{n} Personen", { n: call.members.length })].filter(Boolean).join(" · "),
      trailing: <Equalizer playing={call.members.some((m) => m.speaking)} tint="bg-green" />,
    };
  } else if (np) {
    item = {
      key: "media",
      tab: "media",
      icon: np.artwork ? (
        // Same layoutId as the cover in Now Playing, so a click flies it there.
        <motion.img layoutId={ARTWORK_LAYOUT_ID} transition={springs.morph} src={np.artwork} alt="" draggable={false} className="size-7 rounded-[6px] object-cover" />
      ) : (
        <MusicNoteSimple size={18} weight="fill" className="text-label-2" />
      ),
      title: np.title,
      detail: np.artist,
      trailing: <Equalizer playing={np.isPlaying} />,
    };
  }

  return (
    <div className="relative h-11 overflow-hidden rounded-[12px] bg-fill-1">
      <AnimatePresence mode="popLayout" initial={false}>
        {item ? (
          <motion.button
            key={item.key}
            onClick={() => navigate(item.tab)}
            className="pressable pressable-wide pressable-fill absolute inset-0 flex items-center gap-2.5 px-2.5 text-left"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            <span className="flex size-7 shrink-0 items-center justify-center">{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-footnote font-medium text-label">{item.title}</span>
              <span className="block truncate text-caption text-label-3">{item.detail}</span>
            </span>
            {item.trailing && <span className="shrink-0 pr-1">{item.trailing}</span>}
          </motion.button>
        ) : (
          <motion.div
            key="idle"
            className="absolute inset-0 flex items-center justify-center text-footnote text-label-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: content.enter }}
            exit={{ opacity: 0, transition: content.exit }}
          >
            {t("Gerade läuft nichts")}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Windows focus on/off. Light = on (like Control Center). */
function FocusTile() {
  const [focus, setFocus] = useState<FocusState | null>(null);
  useEffect(() => {
    const load = () => void systemControls.focus().then(setFocus).catch(() => setFocus(null));
    load();
    // Also toggled elsewhere (taskbar, Clock app) → follow it.
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);
  const active = !!focus?.active;
  const label = focus?.kind === "dnd" ? t("Nicht stören") : t("Fokus");

  return (
    <button
      aria-pressed={active}
      disabled={!focus}
      onClick={() => {
        setFocus((f) => f && { ...f, active: !active });
        void systemControls.setFocus(!active).then(setFocus).catch(() => systemControls.focus().then(setFocus));
      }}
      className={`pressable flex h-10 w-[150px] shrink-0 items-center gap-2.5 rounded-[12px] px-2.5 transition-colors duration-200 disabled:opacity-40 ${
        active ? "bg-label text-black" : "bg-fill-1 text-label"
      }`}
    >
      <motion.span
        className={`flex size-6 items-center justify-center rounded-full ${active ? "bg-black/10" : "bg-fill-2"}`}
        animate={{ rotate: active ? 0 : -30 }}
        transition={springs.snappy}
      >
        <Moon size={14} weight="fill" />
      </motion.span>
      <span className="min-w-0 text-left">
        <span className="block truncate text-footnote font-semibold">{label}</span>
        <span className={`block text-caption ${active ? "text-black/55" : "text-label-3"}`}>{active ? t("An") : t("Aus")}</span>
      </span>
    </button>
  );
}

/** Thick volume slider like Control Center: drag anywhere, icon = mute. */
function VolumeTile() {
  const [vol, setVol] = useState<VolumeState | null>(null);
  const dragging = useRef(false);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => !dragging.current && void systemControls.volume().then(setVol).catch(() => {});
    load();
    // Keyboard volume keys or taskbar → follow them.
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, []);

  const level = vol ? (vol.muted ? 0 : vol.level) : 0;
  const set = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const l = Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 100) / 100;
    setVol({ level: l, muted: false });
    void systemControls.setVolume({ level: l });
  };
  const Icon = vol?.muted || level === 0 ? SpeakerSimpleSlash : level < 0.34 ? SpeakerNone : level < 0.67 ? SpeakerLow : SpeakerHigh;

  return (
    <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-fill-1 pr-3 pl-1.5">
      <button
        aria-label={vol?.muted ? t("Stummschaltung aufheben") : t("Stumm")}
        disabled={!vol}
        onClick={() => vol && void systemControls.setVolume({ muted: !vol.muted }).then(setVol)}
        className={`pressable flex size-7 shrink-0 items-center justify-center rounded-full ${vol?.muted ? "text-red" : "text-label-2 hover:text-label"}`}
      >
        <Icon size={15} weight="fill" />
      </button>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={t("Lautstärke")}
        aria-valuenow={Math.round(level * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-6 min-w-0 flex-1 cursor-pointer touch-none overflow-hidden rounded-full bg-fill-2 outline-none"
        onPointerDown={(e) => {
          if (!vol) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          set(e.clientX);
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && set(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onWheel={(e) => {
          if (!vol) return;
          const l = Math.min(1, Math.max(0, level + (e.deltaY < 0 ? 0.02 : -0.02)));
          setVol({ level: l, muted: false });
          void systemControls.setVolume({ level: l });
        }}
        onKeyDown={(e) => {
          if (!vol || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
          const l = Math.min(1, Math.max(0, level + (e.key === "ArrowRight" ? 0.05 : -0.05)));
          setVol({ level: l, muted: false });
          void systemControls.setVolume({ level: l });
        }}
      >
        <motion.div
          className="absolute inset-0 origin-left rounded-full bg-label"
          initial={false}
          animate={{ transform: `scaleX(${level})` }}
          transition={dragging.current ? { duration: 0 } : springs.snappy}
        />
      </div>
      <span className="tabular w-8 shrink-0 text-right text-caption font-semibold text-label-2">{vol ? Math.round(level * 100) : "–"}</span>
    </div>
  );
}
