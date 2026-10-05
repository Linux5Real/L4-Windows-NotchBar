import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleNotch, Drop, MagnifyingGlass, MapPin, NavigationArrow, Wind } from "@phosphor-icons/react";
import { content, fade, spin } from "../../design/motion";
import { settings } from "../../settings/store";
import { Skeleton } from "../../ui/controls";
import { locale, t } from "../../i18n";
import { choosePlace, describe, detectPlace, loadForecast, searchPlaces, type Forecast, type Place } from "./store";

/*
 * Wetter über Open-Meteo (Daten und Ortserkennung: ./store.ts).
 *
 *   ☀ 22°   Wien · Bedeckt          gefühlt 21° · Wind 7 km/h
 *   Mo  Di  Mi  Do  Fr  Sa  So
 *   ☁   ☀   🌧  …
 *   18° 21° 15°
 */
const weekday = () => new Intl.DateTimeFormat(locale(), { weekday: "short" });

export function WeatherView() {
  const place = settings.use().weather;
  const [data, setData] = useState<Forecast | null>(null);
  const [error, setError] = useState(false);
  const [searching, setSearching] = useState(false);
  const [detectFailed, setDetectFailed] = useState(false);

  // Erster Start ohne Ort: per IP erkennen; klappt das nicht, Suche zeigen.
  useEffect(() => {
    if (!place) void detectPlace().then((ok) => setDetectFailed(!ok));
  }, [place]);

  useEffect(() => {
    if (!place) return;
    let alive = true;
    setError(false);
    loadForecast(place.lat, place.lon)
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [place]);

  return (
    <div className="relative flex h-full flex-col px-5 pt-1 pb-2">
      <AnimatePresence mode="popLayout" initial={false}>
        {searching || (!place && detectFailed) ? (
          <motion.div key="search" className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: content.enter }} exit={{ opacity: 0, transition: content.exit }}>
            <PlaceSearch onDone={() => setSearching(false)} canCancel={!!place} />
          </motion.div>
        ) : error ? (
          <motion.div key="error" className="flex h-full items-center justify-center text-body text-label-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade}>
            {t("Wetter gerade nicht erreichbar")}
          </motion.div>
        ) : !data || !place ? (
          <motion.div key="loading" className="flex flex-col gap-3" exit={{ opacity: 0, transition: content.exit }}>
            <Skeleton className="h-10 w-48" />
            <Skeleton className="h-20 w-full" />
          </motion.div>
        ) : (
          <motion.div key="data" className="flex h-full flex-col justify-between" initial={{ opacity: 0, filter: "blur(4px)" }} animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}>
            <Current data={data} name={place.name} auto={!!place.auto} onChangePlace={() => setSearching(true)} />
            <div className="grid grid-cols-7 gap-1">
              {data.daily.map((d, i) => {
                const { icon: I, text } = describe(d.code);
                return (
                  <div key={d.date} className={`flex flex-col items-center gap-1 rounded-[10px] py-1.5 ${i === 0 ? "bg-fill-1" : ""}`} title={text}>
                    <span className="text-caption text-label-3">{i === 0 ? t("Heute") : weekday().format(new Date(`${d.date}T12:00:00`)).replace(".", "")}</span>
                    <I size={18} weight="fill" className="text-label-2" />
                    <span className="tabular text-caption font-semibold text-label">{Math.round(d.max)}°</span>
                    <span className="tabular -mt-1 text-caption text-label-3">{Math.round(d.min)}°</span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Current({ data, name, auto, onChangePlace }: { data: Forecast; name: string; auto: boolean; onChangePlace: () => void }) {
  const { icon: I, text } = describe(data.current.code, data.current.day);
  const today = data.daily[0];
  return (
    <div className="flex items-center gap-3">
      <I size={38} weight="fill" className="text-label" />
      <span className="tabular text-[34px] leading-none font-semibold tracking-[-0.03em]">{Math.round(data.current.temp)}°</span>
      <div className="min-w-0">
        <button onClick={onChangePlace} className="flex items-center gap-1 text-footnote font-medium text-label hover:text-label-2" title={t("Ort ändern")}>
          {auto ? <NavigationArrow size={11} weight="fill" /> : <MapPin size={11} weight="fill" />} {name}
        </button>
        <div className="text-caption text-label-3">{text}</div>
      </div>
      <div className="ml-auto flex flex-col items-end gap-0.5 text-caption text-label-3">
        <span>{t("gefühlt {n}°", { n: Math.round(data.current.feels) })}</span>
        <span className="flex items-center gap-1"><Wind size={11} weight="bold" /> {Math.round(data.current.wind)} km/h</span>
        {today && today.rain > 0 && <span className="flex items-center gap-1"><Drop size={11} weight="fill" /> {today.rain} %</span>}
      </div>
    </div>
  );
}

/** Ortssuche; auch in den Einstellungen genutzt (`compact`). Pfeil = wieder automatisch per IP. */
export function PlaceSearch({ onDone, canCancel, compact = false }: { onDone: () => void; canCancel: boolean; compact?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [locating, setLocating] = useState(false);

  // Suche mit kurzer Verzögerung, damit nicht jeder Tastendruck eine Anfrage auslöst.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      searchPlaces(q)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  return (
    <div className={`flex flex-col gap-2 ${compact ? "" : "h-full"}`}>
      <div className={`flex h-9 items-center gap-2 rounded-[12px] px-3 ${compact ? "bg-fill-2" : "bg-fill-1"}`}>
        <MagnifyingGlass size={14} weight="bold" className="text-label-3" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Ort suchen, z. B. Berlin")}
          className="min-w-0 flex-1 bg-transparent text-body text-label outline-none placeholder:text-label-4"
        />
        <button
          title={t("Automatisch per IP")}
          aria-label={t("Automatisch per IP")}
          onClick={() => {
            setLocating(true);
            void detectPlace(true).then((ok) => {
              setLocating(false);
              if (ok) onDone();
            });
          }}
          className="pressable flex size-6 items-center justify-center text-label-3 hover:text-label"
        >
          {locating ? (
            <motion.span className="flex" animate={{ rotate: 360 }} transition={spin}>
              <CircleNotch size={13} weight="bold" />
            </motion.span>
          ) : (
            <NavigationArrow size={13} weight="fill" />
          )}
        </button>
        {canCancel && (
          <button onClick={onDone} className="text-caption text-label-3 hover:text-label-2">
            {t("Abbrechen")}
          </button>
        )}
      </div>
      <div className="flex flex-col">
        {results.map((p) => (
          <button
            key={`${p.lat},${p.lon}`}
            onClick={() => {
              choosePlace(p);
              onDone();
            }}
            className="flex h-8 items-center gap-2 rounded-[8px] px-3 text-left hover:bg-fill-1"
          >
            <MapPin size={12} weight="fill" className="text-label-3" />
            <span className="text-footnote text-label">{p.name}</span>
            <span className="truncate text-caption text-label-3">{p.detail}</span>
          </button>
        ))}
        {!compact && query.trim().length < 2 && <span className="px-3 pt-2 text-caption text-label-3">{t("Für welchen Ort soll das Wetter angezeigt werden?")}</span>}
      </div>
    </div>
  );
}
