/*
 * Prayer times for the weather location, fully offline (adhan-js, no network).
 * Times are computed from the sun position; the location always follows
 * the weather settings (`settings.weather`). Displayed in the location's own
 * timezone, not the computer's.
 */
import {
  CalculationMethod,
  Coordinates,
  Madhab,
  PrayerTimes,
} from "adhan";
import tzlookup from "tz-lookup";
import { locale } from "../../i18n";
import { settings } from "../../settings/store";

export type PrayerMethodKey =
  | "mwl"
  | "isna"
  | "egyptian"
  | "umm_al_qura"
  | "karachi"
  | "dubai"
  | "tehran"
  | "turkey";

export type MadhabKey = "shafi" | "hanafi";

export const METHODS: { key: PrayerMethodKey; label: string }[] = [
  { key: "mwl", label: "MWL – Muslimische Weltliga" },
  { key: "isna", label: "ISNA – Nordamerika" },
  { key: "egyptian", label: "Ägypten" },
  { key: "umm_al_qura", label: "Umm al-Qura – Saudi-Arabien" },
  { key: "karachi", label: "Karachi" },
  { key: "dubai", label: "Dubai" },
  { key: "tehran", label: "Teheran" },
  { key: "turkey", label: "Diyanet – Türkei" },
];

/** Prayer ids in order of the day. `ar` = Arabic name, `name` = Latin (same in de/en). */
export const PRAYERS = [
  { key: "fajr", ar: "الفجر", name: "Fajr" },
  { key: "sunrise", ar: "الشروق", name: "Sonnenaufgang" },
  { key: "dhuhr", ar: "الظهر", name: "Dhuhr" },
  { key: "asr", ar: "العصر", name: "Asr" },
  { key: "maghrib", ar: "المغرب", name: "Maghrib" },
  { key: "isha", ar: "العشاء", name: "Isha" },
] as const;

export type PrayerKey = (typeof PRAYERS)[number]["key"];

export interface PrayerRow {
  key: PrayerKey;
  ar: string;
  name: string;
  at: Date;
}

export interface PrayerDay {
  /** IANA timezone of the location. */
  tz: string;
  rows: PrayerRow[];
  /** "Today at {city}" line, e.g. "Donnerstag, 5. November". */
  dateLabel: string;
}

function methodParams(key: PrayerMethodKey) {
  switch (key) {
    case "isna":
      return CalculationMethod.NorthAmerica();
    case "egyptian":
      return CalculationMethod.Egyptian();
    case "umm_al_qura":
      return CalculationMethod.UmmAlQura();
    case "karachi":
      return CalculationMethod.Karachi();
    case "dubai":
      return CalculationMethod.Dubai();
    case "tehran":
      return CalculationMethod.Tehran();
    case "turkey":
      return CalculationMethod.Turkey();
    default:
      return CalculationMethod.MuslimWorldLeague();
  }
}

/** Builds a PrayerTimes for `dayOffset` days from now, in the location's timezone. */
function computeDay(lat: number, lon: number, tz: string, dayOffset: number, method: PrayerMethodKey, madhab: MadhabKey): PrayerTimes {
  const params = methodParams(method);
  params.madhab = madhab === "hanafi" ? Madhab.Hanafi : Madhab.Shafi;
  const now = new Date();
  // The civil date in the location (not on the computer), as local components for adhan.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const y = Number(map.year);
  const m = Number(map.month);
  const d = Number(map.day) + dayOffset;
  const civil = new Date(y, m - 1, d, 12, 0, 0);
  return new PrayerTimes(new Coordinates(lat, lon), civil, params);
}

function rowsOf(times: PrayerTimes): PrayerRow[] {
  return PRAYERS.map((p) => ({ ...p, at: times[p.key] }));
}

export interface Computed {
  today: PrayerDay;
  tomorrow: PrayerDay;
  tz: string;
}

/** Everything the view needs, or null when no location is set. */
export function compute(method: PrayerMethodKey, madhab: MadhabKey): Computed | null {
  const place = settings.get().weather;
  if (!place) return null;
  const tz = tzlookup(place.lat, place.lon);
  const todayTimes = computeDay(place.lat, place.lon, tz, 0, method, madhab);
  const tomorrowTimes = computeDay(place.lat, place.lon, tz, 1, method, madhab);
  const fmt = new Intl.DateTimeFormat(locale(), { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
  const fmtTomorrow = new Intl.DateTimeFormat(locale(), { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
  return {
    today: { tz, rows: rowsOf(todayTimes), dateLabel: fmt.format(new Date()) },
    tomorrow: {
      tz,
      rows: rowsOf(tomorrowTimes),
      dateLabel: fmtTomorrow.format(new Date(Date.now() + 86_400_000)),
    },
    tz,
  };
}

/** "06:12" (or "6:12 AM") in the location's timezone, 12/24 h per settings. */
export function formatAt(date: Date, tz: string): string {
  const h12 = settings.get().units.clock === "12";
  return new Intl.DateTimeFormat(locale(), { timeZone: tz, hour: h12 ? "numeric" : "2-digit", minute: "2-digit", hour12: h12 }).format(date);
}

/** "h:mm:ss" countdown until a future prayer. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** First prayer today or tomorrow that is still in the future. */
export function nextOf(c: Computed, now = new Date()): { row: PrayerRow; tomorrow: boolean } {
  for (const row of c.today.rows) {
    if (row.at > now) return { row, tomorrow: false };
  }
  return { row: c.tomorrow.rows[0], tomorrow: true };
}