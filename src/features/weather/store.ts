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
 * Wetterdaten über Open-Meteo (kostenlos, ohne Schlüssel). Genutzt vom Wetter-Tool
 * und von der Übersicht. Ort: beim ersten Start per IP erkannt ("auto"); wer selbst
 * einen Ort wählt, behält ihn.
 */
export interface Forecast {
  current: { temp: number; feels: number; code: number; wind: number; day: boolean };
  daily: { date: string; code: number; max: number; min: number; rain: number }[];
}

/** WMO-Wettercodes → Symbol + Text. */
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

/** Ortssuche (Geocoding von Open-Meteo). */
export async function searchPlaces(q: string): Promise<Place[]> {
  const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=4&language=${lang()}`)).json();
  return (r.results ?? []).map((p: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }) => ({
    name: p.name,
    detail: [p.admin1, p.country].filter(Boolean).join(", "),
    lat: p.latitude,
    lon: p.longitude,
  }));
}

/** Ort selbst gewählt → bleibt fest, keine IP-Erkennung mehr. */
export function choosePlace(p: Place) {
  updateSettings({ weather: { name: p.name, lat: p.lat, lon: p.lon, auto: false } });
}

/** Ungefährer Ort aus der IP (Stadt-genau). Zwei Dienste ohne Schlüssel, der zweite als Ersatz. */
async function placeFromIp(): Promise<{ name: string; lat: number; lon: number } | null> {
  const sources = ["https://get.geojs.io/v1/ip/geo.json", "https://ipwho.is/"];
  for (const url of sources) {
    try {
      const r = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
      const lat = Number(r.latitude);
      const lon = Number(r.longitude);
      if (typeof r.city === "string" && r.city && Number.isFinite(lat) && Number.isFinite(lon)) return { name: r.city, lat, lon };
    } catch {
      // Nächster Dienst.
    }
  }
  return null;
}

let detecting: Promise<boolean> | null = null;

/**
 * Ort per IP setzen, wenn noch keiner gewählt oder "automatisch" eingestellt ist —
 * einmal pro Start. `force` = Nutzer hat "automatisch" gewählt.
 */
export function detectPlace(force = false): Promise<boolean> {
  const w = settings.get().weather;
  if (!force && w && !w.auto) return Promise.resolve(true);
  if (detecting && !force) return detecting;
  detecting = placeFromIp().then((p) => {
    const cur = settings.get().weather;
    if (!p) return !!cur;
    // Nicht überschreiben, wenn der Nutzer inzwischen selbst gewählt hat.
    if (!force && cur && !cur.auto) return true;
    updateSettings({ weather: { ...p, auto: true } });
    return true;
  });
  return detecting;
}

/** Vorhersage für den eingestellten Ort; null solange lädt oder kein Ort, "error" bei Fehler. */
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

// Beim Start: erster Start oder "automatisch" → Ort aus der IP (selbst gewählt bleibt unberührt).
void detectPlace();
