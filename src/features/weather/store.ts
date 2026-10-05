import { useEffect, useState } from "react";
import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Moon,
  Sun,
  type Icon,
} from "@phosphor-icons/react";
import { settings, updateSettings } from "../../settings/store";
import { lang, t } from "../../i18n";

/*
 * Weather data via Open-Meteo (free, no key). Used by the weather tool and the
 * overview. Location: detected via IP on first start ("auto"); a location you pick
 * yourself stays.
 */
export interface Forecast {
  current: { temp: number; feels: number; code: number; wind: number; day: boolean };
  daily: { date: string; code: number; max: number; min: number; rain: number }[];
}

/** WMO weather codes → icon + text. */
export function describe(code: number, day = true): { icon: Icon; text: string } {
  if (code === 0) return { icon: day ? Sun : Moon, text: t("Klar") };
  if (code <= 2) return { icon: day ? CloudSun : CloudMoon, text: t(code === 1 ? "Überwiegend klar" : "Teils bewölkt") };
  if (code === 3) return { icon: Cloud, text: t("Bedeckt") };
  if (code <= 48) return { icon: CloudFog, text: t("Nebel") };
  if (code <= 57) return { icon: CloudRain, text: t("Nieselregen") };
  if (code <= 67 || (code >= 80 && code <= 82)) return { icon: CloudRain, text: t("Regen") };
  if (code <= 77 || code === 85 || code === 86) return { icon: CloudSnow, text: t("Schnee") };
  return { icon: CloudLightning, text: t("Gewitter") };
}

const cache = new Map<string, { at: number; data: Forecast }>();

export async function loadForecast(lat: number, lon: number): Promise<Forecast> {
  const key = `${lat},${lon}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7";
  const r = await (await fetch(url)).json();
  const data: Forecast = {
    current: {
      temp: r.current.temperature_2m,
      feels: r.current.apparent_temperature,
      code: r.current.weather_code,
      wind: r.current.wind_speed_10m,
      day: r.current.is_day === 1,
    },
    daily: r.daily.time.map((date: string, i: number) => ({
      date,
      code: r.daily.weather_code[i],
      max: r.daily.temperature_2m_max[i],
      min: r.daily.temperature_2m_min[i],
      rain: r.daily.precipitation_probability_max[i] ?? 0,
    })),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

export interface Place {
  name: string;
  detail: string;
  lat: number;
  lon: number;
}

/** Location search (Open-Meteo geocoding). */
export async function searchPlaces(q: string): Promise<Place[]> {
  const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=4&language=${lang()}`)).json();
  return (r.results ?? []).map((p: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }) => ({
    name: p.name,
    detail: [p.admin1, p.country].filter(Boolean).join(", "),
    lat: p.latitude,
    lon: p.longitude,
  }));
}

/** Location picked by hand → stays fixed, no more IP detection. */
export function choosePlace(p: Place) {
  updateSettings({ weather: { name: p.name, lat: p.lat, lon: p.lon, auto: false } });
}

/** Approximate location from the IP (city level). Two keyless services, the second as fallback. */
async function placeFromIp(): Promise<{ name: string; lat: number; lon: number } | null> {
  const sources = ["https://get.geojs.io/v1/ip/geo.json", "https://ipwho.is/"];
  for (const url of sources) {
    try {
      const r = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
      const lat = Number(r.latitude);
      const lon = Number(r.longitude);
      if (typeof r.city === "string" && r.city && Number.isFinite(lat) && Number.isFinite(lon)) return { name: r.city, lat, lon };
    } catch {
      // Next service.
    }
  }
  return null;
}

let detecting: Promise<boolean> | null = null;

/**
 * Sets the location via IP if none is picked yet or "automatic" is on, once per
 * start. `force` = the user picked "automatic".
 */
export function detectPlace(force = false): Promise<boolean> {
  const w = settings.get().weather;
  if (!force && w && !w.auto) return Promise.resolve(true);
  if (detecting && !force) return detecting;
  detecting = placeFromIp().then((p) => {
    const cur = settings.get().weather;
    if (!p) return !!cur;
    // Don't overwrite if the user has picked one in the meantime.
    if (!force && cur && !cur.auto) return true;
    updateSettings({ weather: { ...p, auto: true } });
    return true;
  });
  return detecting;
}

/** Forecast for the set location; null while loading or without a location, "error" on failure. */
export function useForecast(): Forecast | null | "error" {
  const place = settings.use().weather;
  const [data, setData] = useState<Forecast | null | "error">(null);
  useEffect(() => {
    if (!place) void detectPlace();
  }, [place]);
  useEffect(() => {
    if (!place) return;
    let alive = true;
    loadForecast(place.lat, place.lon)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData("error"));
    return () => {
      alive = false;
    };
  }, [place?.lat, place?.lon]);
  return place ? data : null;
}

// On start: first run or "automatic" → location from IP (a hand-picked one stays).
void detectPlace();
