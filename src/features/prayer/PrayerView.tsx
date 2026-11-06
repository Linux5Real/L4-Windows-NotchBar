import { useEffect, useMemo, useState } from "react";
import {
  ClockCountdown,
  GearSix,
  MapPin,
  Moon,
  MoonStars,
  Mosque,
  SpeakerSlash,
  Sun,
  SunDim,
  SunHorizon,
  type Icon,
} from "@phosphor-icons/react";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { Skeleton, Button } from "../../ui/controls";
import { settings } from "../../settings/store";
import { navigate } from "../../notch/nav";
import { t } from "../../i18n";
import { compute, formatAt, formatCountdown, nextOf, type PrayerKey } from "./store";
import { adhanPlaying, stopAdhan } from "./alerts";

/**
 *   Amsterdam                               ⟳ 3:12:45
 *   Donnerstag, 5. November
 *   ───────────────────────────────────────────────
 *   ☾  الفجر     FAJR                       06:12
 *   ☀  الشروق    SUNRISE                    07:41
 *   …
 *
 * The next prayer is highlighted in the list (and only there), so a prayer
 * never appears twice. After Isha the list switches to tomorrow.
 */
const META: Record<PrayerKey, { Icon: Icon; flip?: boolean }> = {
  fajr: { Icon: Moon },
  sunrise: { Icon: SunHorizon },
  dhuhr: { Icon: Sun },
  asr: { Icon: SunDim },
  maghrib: { Icon: SunHorizon, flip: true },
  isha: { Icon: MoonStars },
};

function PrayerIcon({ id, active, size = 13 }: { id: PrayerKey; active?: boolean; size?: number }) {
  const { Icon, flip } = META[id];
  return <Icon size={size} weight={active ? "fill" : "regular"} className={flip ? "-scale-y-100" : undefined} />;
}

export function PrayerView() {
  const place = settings.use().weather;
  const prayer = settings.use().prayer;
  const adhan = adhanPlaying.use();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const minute = Math.floor(now.getTime() / 60_000);
  const data = useMemo(
    () => (place ? compute(prayer.method, prayer.madhab) : null),
    // Recompute at most once per minute (sun changes imperceptibly).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [place?.lat, place?.lon, prayer.method, prayer.madhab, minute],
  );

  if (!place) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Mosque size={26} weight="bold" className="text-label-4" />
        <span className="text-body text-label-2">{t("Kein Ort gesetzt")}</span>
        <span className="max-w-64 text-caption text-label-3">{t("Die Gebetszeiten folgen dem Ort in den Wetter-Einstellungen.")}</span>
        <Button icon={MapPin} onClick={() => navigate("settings", "prayer")}>
          {t("Ort wählen")}
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full flex-col gap-3 px-5 pt-1 pb-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const { today, tz, tomorrow } = data;
  const next = nextOf(data, now);
  // After the last prayer the next one is tomorrow's Fajr: show tomorrow's
  // schedule instead, so the upcoming prayer is part of the list (once).
  const shown = next.tomorrow ? tomorrow : today;
  const remaining = next.row.at.getTime() - now.getTime();

  return (
    <div className="flex h-full flex-col px-5 pt-1 pb-2">
      <HeaderActions>
        {adhan && (
          <HeaderButton label={t("Adhan stoppen")} onClick={stopAdhan}>
            <SpeakerSlash size={14} weight="bold" />
          </HeaderButton>
        )}
        <HeaderButton label={t("Gebetszeiten-Einstellungen")} onClick={() => navigate("settings", "prayer")}>
          <GearSix size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <MapPin size={11} weight="fill" className="shrink-0 text-label-3" />
            <span className="truncate text-body font-medium text-label">{place.name}</span>
            {next.tomorrow && (
              <span className="shrink-0 rounded-full bg-fill-2 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] text-label-2">
                {t("morgen")}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-caption capitalize text-label-3">{shown.dateLabel}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-green/15 px-2.5 py-1 text-caption font-semibold text-green">
          <ClockCountdown size={12} weight="bold" />
          <span className="tabular">{formatCountdown(remaining)}</span>
        </div>
      </div>

      <div className="mt-2.5 h-px shrink-0 bg-separator" />

      <div className="mt-1 flex flex-col">
        {shown.rows.map((row) => {
          const passed = row.at <= now;
          const isNext = next.row === row;
          return (
            <div
              key={row.key}
              className={`flex h-[34px] items-center gap-3 rounded-[10px] px-2.5 ${isNext ? "bg-fill-1" : ""}`}
            >
              <span
                className={`grid size-[26px] shrink-0 place-items-center rounded-full ${
                  isNext ? "bg-green/15 text-green" : passed ? "text-label-4" : "bg-fill-1 text-label-2"
                }`}
              >
                <PrayerIcon id={row.key} active={isNext} size={15} />
              </span>
              <span
                dir="rtl"
                lang="ar"
                className={`prayer-arabic w-[76px] shrink-0 text-left text-[18px] leading-tight ${
                  isNext ? "font-semibold text-label" : passed ? "font-normal text-label-3" : "font-normal text-label-2"
                }`}
              >
                {row.ar}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[9px] font-semibold uppercase tracking-[0.14em] ${
                  passed ? "text-label-4" : "text-label-3"
                }`}
              >
                {t(row.name)}
              </span>
              <span
                className={`tabular text-body ${
                  isNext ? "font-semibold text-label" : passed ? "text-label-3" : "text-label-2"
                }`}
              >
                {formatAt(row.at, tz)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
