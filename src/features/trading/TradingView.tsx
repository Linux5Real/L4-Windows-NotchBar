import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowClockwise, Key, WarningCircle } from "@phosphor-icons/react";
import { DepotIcon } from "../../ui/icons";
import { content, fade, spin, springs } from "../../design/motion";
import { formatAgo, formatMoney, formatPercent } from "../../lib/format";
import { createStore } from "../../lib/store";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { fetchTrading, type TradingData } from "../../platform/services";
import { settings } from "../../settings/store";
import { Button, Empty, Segmented, Skeleton } from "../../ui/controls";
import { locale, t } from "../../i18n";

/** Polls while the tool is open. The API allows one request per 5 s. */
const POLL_MS = 30_000;

type Range = "1d" | "7d" | "30d" | "all";
const ranges: { value: Range; label: string }[] = [
  { value: "1d", label: "1T" },
  { value: "7d", label: "7T" },
  { value: "30d", label: "30T" },
  { value: "all", label: "Alles" },
];
const range = createStore<Range>("1d", { persist: "trading-range" });

/*
 *   Portfolio                                [1D 7D 30D All] [⟳] [📌]
 *   12.345,67 €                         ╱╲    ╱‾‾
 *   +4,20 € (+0,17 %) today        ___╱  ╲__╱      P&L +12,30 € · 7D
 *   [Cash] [Invested] [Open +0,07 € +1,9 %] [Realized +85 €]
 *   AAPL  Apple                                  845,20 €  [+2,10 %]
 *
 * All changes are based on profit (realized + unrealized) instead of account value,
 * so deposits and withdrawals distort neither "today" nor the history.
 * Percent today = change / yesterday's account value; percent open = open P&L / cost basis.
 */
export function TradingView() {
  const env = settings.use().trading.env;
  const { data, error, loading, updatedAt, refresh } = useTrading(env);
  const r = range.use();

  const actions = (
    <HeaderActions>
      {env === "demo" && <span className="mr-1 rounded-full bg-fill-2 px-1.5 text-caption text-label-2">{t("Demo")}</span>}
      {data && <Segmented id="trading-range" size="sm" value={r} onChange={range.set} options={ranges.map((o) => ({ ...o, label: t(o.label) }))} />}
      <HeaderButton label={updatedAt ? t("Aktualisiert {ago}", { ago: formatAgo(Date.now() - updatedAt) }) : t("Aktualisieren")} onClick={refresh}>
        <motion.span className="flex" animate={{ rotate: loading ? 360 : 0 }} transition={loading ? spin : { duration: 0 }}>
          <ArrowClockwise size={14} weight="bold" />
        </motion.span>
      </HeaderButton>
    </HeaderActions>
  );

  if (!data && error === "no-key") {
    return (
      <Empty
        icon={Key}
        title={t("Trading 212 verbinden")}
        text={t("API-Schlüssel in Trading 212 erstellen (Einstellungen → API), Rechte: Konto + Portfolio.")}
        action={<Button primary onClick={() => navigate("settings", "trading")}>{t("Schlüssel eintragen")}</Button>}
      />
    );
  }
  if (!data && error) return <ErrorState code={error} onRetry={refresh} />;
  if (!data) return <LoadingState />;

  const today = todayChange(data);
  const series = seriesFor(data, r);
  const openPct = data.invested > 0 ? (data.unrealized / data.invested) * 100 : null;

  return (
    <div className="flex h-full flex-col px-5 pt-1 pb-2">
      {actions}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <AnimatedValue className="tabular text-[30px] leading-9 font-semibold tracking-[-0.025em]" text={formatMoney(data.totalValue, data.currency)} />
          {today ? (
            <Change value={today.change} pct={today.pct} currency={data.currency} suffix={today.label} />
          ) : (
            <div className="text-footnote text-label-3">{t("Tagesänderung ab dem nächsten Abruf")}</div>
          )}
        </div>
        <Chart series={series} currency={data.currency} rangeLabel={t(ranges.find((x) => x.value === r)!.label)} />
      </div>

      <div className="mt-3 grid grid-cols-[1fr_1fr_1.45fr_1fr] gap-1.5">
        <Stat label={t("Cash")} value={formatMoney(data.cash, data.currency)} />
        <Stat label={t("Investiert")} value={formatMoney(data.invested, data.currency)} />
        <Stat
          label={t("Offen")}
          value={formatMoney(data.unrealized, data.currency, { signed: true })}
          sub={openPct !== null ? formatPercent(openPct) : undefined}
          tone={data.unrealized}
        />
        <Stat label={t("Realisiert")} value={formatMoney(data.realized, data.currency, { signed: true })} tone={data.realized} />
      </div>

      <div className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-width:none]">
        {data.positions.length === 0 && <div className="py-4 text-center text-caption text-label-3">{t("Keine offenen Positionen")}</div>}
        {data.positions.map((p, i) => {
          const pct = p.cost > 0 ? (p.pnl / p.cost) * 100 : 0;
          return (
            <motion.div
              key={p.ticker}
              className="flex h-10 items-center gap-3 border-b border-separator px-1 last:border-0"
              initial={{ opacity: 0, transform: "translateY(4px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              transition={{ ...content.enter, delay: 0.03 * i }}
              title={`${p.quantity.toLocaleString(locale())} ${t("Stk.")} · Ø ${p.averagePrice.toLocaleString(locale())} → ${p.currentPrice.toLocaleString(locale())} ${p.priceCurrency}`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-footnote font-semibold text-label">{p.ticker}</div>
                <div className="truncate text-caption text-label-3">{p.name}</div>
              </div>
              <div className="text-right">
                <div className="tabular text-footnote text-label">{formatMoney(p.value, data.currency)}</div>
                <div className={`tabular text-caption ${tone(p.pnl)}`}>{formatMoney(p.pnl, data.currency, { signed: true })}</div>
              </div>
              <span className={`tabular w-[68px] rounded-[6px] py-0.5 text-center text-caption font-semibold ${pill(p.pnl)}`}>{formatPercent(pct)}</span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function useTrading(env: "live" | "demo") {
  const [data, setData] = useState<TradingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchTrading(env);
      if (!alive.current) return;
      setData(d);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!alive.current) return;
      const code = String(e);
      // Silently swallow rate limits while we have data.
      if (code !== "rate") setError(code);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [env]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return { data, error, loading, updatedAt, refresh };
}

/**
 * Today = P&L now − P&L at the end of yesterday (percent of yesterday's account value).
 * Without yesterday: since the first fetch today. Without either: nothing (instead of nonsense).
 */
function todayChange(d: TradingData): { change: number; pct: number | null; label: string } | null {
  const pnlNow = d.unrealized + d.realized;
  const prev = d.history.length >= 2 ? d.history.at(-2)! : null;
  if (prev) return { change: pnlNow - prev.pnl, pct: prev.value > 0 ? ((pnlNow - prev.pnl) / prev.value) * 100 : null, label: t("heute") };
  const first = d.intraday[0];
  if (first && d.intraday.length >= 2) {
    const since = new Date(first.t).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
    return { change: pnlNow - first.pnl, pct: first.value > 0 ? ((pnlNow - first.pnl) / first.value) * 100 : null, label: t("seit {time}", { time: since }) };
  }
  return null;
}

/** P&L history for the range: 1D from intraday points, otherwise one point per day. */
function seriesFor(d: TradingData, r: Range): number[] {
  if (r === "1d") {
    const prev = d.history.length >= 2 ? d.history.at(-2)!.pnl : null;
    const points = d.intraday.map((p) => p.pnl);
    return prev !== null && points.length ? [prev, ...points] : points;
  }
  const days = r === "7d" ? 8 : r === "30d" ? 31 : Infinity;
  return d.history.slice(-days).map((s) => s.pnl);
}

function tone(v: number): string {
  return v > 0.004 ? "text-green" : v < -0.004 ? "text-red" : "text-label-3";
}

function pill(v: number): string {
  return v > 0.004 ? "bg-green/18 text-green" : v < -0.004 ? "bg-red/18 text-red" : "bg-fill-2 text-label-2";
}

function Change({ value, pct, currency, suffix }: { value: number; pct: number | null; currency: string; suffix: string }) {
  return (
    <div className={`tabular text-footnote font-medium ${tone(value)}`}>
      {formatMoney(value, currency, { signed: true })}
      {pct !== null && ` (${formatPercent(pct)})`} <span className="font-normal text-label-3">{suffix}</span>
    </div>
  );
}

function Stat({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: number }) {
  return (
    <div className="min-w-0 rounded-[10px] bg-fill-1 px-2.5 py-1.5">
      <div className="text-caption text-label-3">{label}</div>
      <div className={`tabular flex items-baseline gap-1 text-footnote font-semibold ${t === undefined ? "text-label" : tone(t)}`}>
        <span className="truncate">{value}</span>
        {sub && <span className="shrink-0 text-caption font-medium opacity-80">{sub}</span>}
      </div>
    </div>
  );
}

/** Line + soft area, green or red depending on the range. Redraws on change. */
function Chart({ series, currency, rangeLabel }: { series: number[]; currency: string; rangeLabel: string }) {
  const w = 210;
  const h = 56;
  const path = useMemo(() => {
    if (series.length < 2) return null;
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = max - min || 1;
    const pts = series.map((v, i) => [(i / (series.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 8)] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    return { line, area: `${line} L${w},${h} L0,${h} Z`, delta: series.at(-1)! - series[0] };
  }, [series]);

  if (!path) {
    return (
      <div className="flex h-[74px] w-[210px] shrink-0 flex-col justify-end gap-1.5">
        <div className="h-px w-full border-t border-dashed border-fill-3" />
        <span className="text-right text-caption text-label-3">{t("Verlauf entsteht – ab jetzt wird gespeichert")}</span>
      </div>
    );
  }
  const color = path.delta >= 0 ? "var(--color-green)" : "var(--color-red)";
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
        <defs>
          <linearGradient id="trading-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.g key={path.line} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            <path d={path.area} fill="url(#trading-fill)" />
            <motion.path
              d={path.line}
              fill="none"
              stroke={color}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={springs.morph}
            />
          </motion.g>
        </AnimatePresence>
      </svg>
      <span className="tabular text-caption text-label-3">
        {t("G/V")} <span className={tone(path.delta)}>{formatMoney(path.delta, currency, { signed: true })}</span> · {rangeLabel}
      </span>
    </div>
  );
}

/** Value crossfades on change (blur bridge) instead of jumping. */
function AnimatedValue({ text, className }: { text: string; className: string }) {
  return (
    <div className="relative">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={text}
          className={className}
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
          exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
        >
          {text}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full flex-col gap-2 px-5 pt-2 pb-2">
      <Skeleton className="h-8 w-44" />
      <Skeleton className="h-3 w-32" />
      <Skeleton className="mt-2 h-10 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

const errorText: Record<string, string> = {
  unauthorized: "Schlüssel ungültig – bitte neu eintragen.",
  forbidden: "Dem Schlüssel fehlen Rechte. Benötigt: Konto-Daten und Portfolio.",
};

function ErrorState({ code, onRetry }: { code: string; onRetry: () => void }) {
  const text = errorText[code] ? t(errorText[code]) : code.startsWith("network:") ? t("Keine Verbindung zu Trading 212 ({e}).", { e: code.slice(8) }) : code;
  const isKey = code in errorText;
  return (
    <Empty
      icon={isKey ? Key : WarningCircle}
      title={isKey ? t("Zugang prüfen") : t("Depot nicht erreichbar")}
      text={text}
      action={
        <div className="flex gap-2">
          {isKey && <Button onClick={() => navigate("settings", "trading")}>{t("Einstellungen")}</Button>}
          <Button primary onClick={onRetry} icon={DepotIcon}>{t("Erneut laden")}</Button>
        </div>
      }
    />
  );
}
