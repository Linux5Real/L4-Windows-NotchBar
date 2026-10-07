import { locale, t } from "../i18n";
import { settings } from "../settings/store";

/** Formatting in one place: numbers and times in the chosen language. */

const money = new Map<string, Intl.NumberFormat>();

export function formatMoney(value: number, currency: string, opts: { signed?: boolean; compact?: boolean } = {}): string {
  const key = `${locale()}|${currency}|${opts.signed}|${opts.compact}`;
  let f = money.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(), {
      style: "currency",
      currency: currency || "EUR",
      signDisplay: opts.signed ? "exceptZero" : "auto",
      maximumFractionDigits: opts.compact ? 0 : 2,
      minimumFractionDigits: opts.compact ? 0 : 2,
    });
    money.set(key, f);
  }
  return f.format(value);
}

export function formatPercent(value: number, signed = true): string {
  return new Intl.NumberFormat(locale(), {
    style: "percent",
    signDisplay: signed ? "exceptZero" : "auto",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value / 100);
}

export function formatBytes(bytes: number, digits = 1): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toLocaleString(locale(), { maximumFractionDigits: i === 0 ? 0 : digits })} ${units[i]}`;
}

/** "in 2 Std. 13 Min." / "in 3 T. 4 Std." */
export function formatIn(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return t("gleich");
  if (min < 60) return t("in {m} Min.", { m: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("in {h} Std. {m} Min.", { h, m: min % 60 });
  return t("in {d} T. {h} Std.", { d: Math.floor(h / 24), h: h % 24 });
}

/** "vor 5 Min." */
export function formatAgo(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return t("gerade eben");
  if (min < 60) return t("vor {m} Min.", { m: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("vor {h} Std.", { h });
  return t("vor {d} T.", { d: Math.floor(h / 24) });
}

/** Weather data comes in °C; shown in the unit from the settings. "22°" */
export function formatTemp(celsius: number): string {
  const f = settings.get().units.temp === "f";
  return `${Math.round(f ? (celsius * 9) / 5 + 32 : celsius)}°`;
}

/** Wind follows the temperature unit: km/h or mph. */
export function formatWind(kmh: number): string {
  return settings.get().units.temp === "f" ? `${Math.round(kmh / 1.609344)} mph` : `${Math.round(kmh)} km/h`;
}

/** Clock time in 24 h or 12 h; `period` is "AM"/"PM" (empty in 24 h) for a smaller second line. */
export function formatTimeParts(date: Date | number): { time: string; period: string } {
  const h12 = settings.get().units.clock === "12";
  const parts = new Intl.DateTimeFormat(locale(), { hour: h12 ? "numeric" : "2-digit", minute: "2-digit", hour12: h12 }).formatToParts(date);
  const period = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  const time = parts
    .filter((p) => p.type !== "dayPeriod")
    .map((p) => p.value)
    .join("")
    .trim();
  return { time, period: period.toUpperCase() };
}

/** "14:32" or "2:32 PM" */
export function formatTime(date: Date | number): string {
  const { time, period } = formatTimeParts(date);
  return period ? `${time} ${period}` : time;
}
