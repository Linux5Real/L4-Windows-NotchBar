import { locale, t } from "../i18n";

/** Formatierung an einer Stelle — Zahlen und Zeiten in der eingestellten Sprache. */

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
