/*
 * Prayer arrival alerts: closed-notch banner, adhan audio and a native
 * Windows toast. The scheduler arms one timeout for the next prayer, so
 * nothing polls while waiting. Times come from the same offline calculation
 * as the view and follow the weather location.
 */
import { createStore } from "../../lib/store";
import { isNative } from "../../platform/native";
import { navigate } from "../../notch/nav";
import { requestOpen } from "../../notch/useNotchState";
import { settings } from "../../settings/store";
import { t } from "../../i18n";
import { compute, formatAt, type Computed, type PrayerKey, type PrayerRow } from "./store";

export interface PrayerAlert {
  key: PrayerKey;
  /** Arabic name, shown large in the banner. */
  ar: string;
  /** German key for t(); the Latin name is resolved at render time. */
  name: string;
  /** Formatted in the location's timezone. */
  time: string;
  place: string;
  /** Date.now() when it appeared; drives the countdown line. */
  at: number;
}

/** How long the banner stays in the notch. The adhan keeps playing until stopped. */
export const ALERT_MS = 60_000;

/** The adhan source. About 670 KB, served as audio/mpeg. */
const ADHAN_URL = "https://www.islamcan.com/audio/adhan/azan1.mp3";
/** Safety stop for a broken/endless stream. */
const ADHAN_MAX_MS = 8 * 60_000;

/** Banner in the closed notch (and in the idle line, see Notch.tsx). */
export const prayerAlert = createStore<PrayerAlert | null>(null);
/** True while the adhan is audibly playing; the Prayer view offers a stop button. */
export const adhanPlaying = createStore(false);

let alertTimeout: number | undefined;
let adhan: HTMLAudioElement | null = null;
let adhanTimeout: number | undefined;
let started = false;
let scheduledKey = "";
let endTimeout: number | undefined;

/** Next prayer that is not sunrise. Today or tomorrow, after `after` (ms). */
function nextPrayer(c: Computed, after = Date.now()): PrayerRow | null {
  const pick = (rows: PrayerRow[]) => rows.find((r) => r.key !== "sunrise" && r.at.getTime() > after);
  return pick(c.today.rows) ?? pick(c.tomorrow.rows) ?? null;
}

/** Shows the banner and arms its auto-dismiss. Does not make a sound. */
function showAlert(row: PrayerRow, tz: string, place: string) {
  prayerAlert.set({
    key: row.key,
    ar: row.ar,
    name: row.name,
    time: formatAt(row.at, tz),
    place,
    at: Date.now(),
  });
  window.clearTimeout(alertTimeout);
  alertTimeout = window.setTimeout(() => prayerAlert.set(null), ALERT_MS);
}

/** Hides the banner. The adhan is independent and keeps playing. */
export function dismissPrayerAlert() {
  window.clearTimeout(alertTimeout);
  alertTimeout = undefined;
  prayerAlert.set(null);
}

/** "key@ISO" of the last prayer that fired, so a restart never repeats it. */
function lastAlertKey(): string | null {
  try {
    return localStorage.getItem("notch:prayer-last-alert");
  } catch {
    return null;
  }
}

function markAlert(row: PrayerRow) {
  try {
    localStorage.setItem("notch:prayer-last-alert", `${row.key}@${row.at.toISOString()}`);
  } catch {
    // Storage full/disabled: the in-memory guard below still prevents doubles.
  }
}

/* ------------------------------- adhan -------------------------------- */

export function stopAdhan() {
  window.clearTimeout(adhanTimeout);
  adhanTimeout = undefined;
  if (adhan) {
    adhan.pause();
    try {
      adhan.currentTime = 0;
    } catch {
      // Not loaded yet.
    }
  }
  adhanPlaying.set(false);
}

export function playAdhan() {
  stopAdhan();
  if (!adhan) {
    adhan = new Audio(ADHAN_URL);
    adhan.preload = "auto";
    // No endless "playing" state when the stream ends or fails.
    adhan.addEventListener("ended", () => adhanPlaying.set(false));
    adhan.addEventListener("error", () => adhanPlaying.set(false));
  }
  const volume = settings.get().alarm.volume;
  adhan.volume = Math.min(1, Math.max(0, volume));
  adhanPlaying.set(true);
  void adhan.play().then(
    () => {
      window.clearTimeout(adhanTimeout);
      adhanTimeout = window.setTimeout(stopAdhan, ADHAN_MAX_MS);
    },
    () => adhanPlaying.set(false),
  );
}

/* --------------------------- native toast ----------------------------- */

let nativeActionsBound = false;

async function notificationPlugin() {
  return import("@tauri-apps/plugin-notification");
}

/** Asks for permission (Windows grants it up front); called from the settings toggle. */
export async function enableNativeNotifications() {
  if (!isNative) return;
  try {
    const plugin = await notificationPlugin();
    if (!(await plugin.isPermissionGranted())) await plugin.requestPermission();
  } catch {
    // Plugin unavailable: the notch alert still works.
  }
}

async function nativeNotify(row: PrayerRow, tz: string, place: string) {
  if (!isNative) return;
  try {
    const plugin = await notificationPlugin();
    let granted = await plugin.isPermissionGranted();
    if (!granted) granted = (await plugin.requestPermission()) === "granted";
    if (!granted) return;
    plugin.sendNotification({
      title: t("Gebetszeit · {name}", { name: t(row.name) }),
      body: t("{name} · {time} · {place}", { name: row.ar, time: formatAt(row.at, tz), place }),
    });
  } catch {
    // No toast; the notch banner and the adhan are unaffected.
  }
}

/** A click on the toast opens the notch on the prayer tool. */
async function bindNativeActions() {
  if (!isNative || nativeActionsBound) return;
  nativeActionsBound = true;
  try {
    const plugin = await notificationPlugin();
    await plugin.onAction(() => {
      navigate("prayer");
      requestOpen();
    });
  } catch {
    // Older plugin/OS without action support: nothing to bind.
  }
}

/* ----------------------------- scheduler ------------------------------ */

function alertsEnabled(): boolean {
  const s = settings.get();
  const tool = s.tools.find((x) => x.id === "prayer")?.enabled ?? false;
  const a = s.prayer.alerts ?? { notch: true, native: true, adhan: true };
  return tool && (a.notch || a.native || a.adhan);
}

/** Fires the alert once. `after` lets the next arming skip the prayer just fired. */
function arm(after = Date.now()) {
  const { prayer, weather } = settings.get();
  const c = weather && alertsEnabled() ? compute(prayer.method, prayer.madhab) : null;
  const row = c ? nextPrayer(c, after) : null;

  if (!c || !weather || !row) {
    window.clearTimeout(endTimeout);
    endTimeout = undefined;
    scheduledKey = "";
    return;
  }

  const key = `${row.key}@${row.at.toISOString()}`;
  // Same target and a live timeout → leave it alone (settings changes happen often).
  if (key === scheduledKey && endTimeout !== undefined) return;

  window.clearTimeout(endTimeout);
  endTimeout = undefined;
  scheduledKey = key;

  const delay = row.at.getTime() - Date.now();
  endTimeout = window.setTimeout(() => {
    endTimeout = undefined;
    // Woke after a long sleep or clock jump: a stale prayer is not an alert.
    const late = Date.now() - row.at.getTime();
    if (late >= 0 && late <= 5 * 60_000) fire(row, c, weather.name);
    arm(row.at.getTime() + 1000);
  }, Math.max(0, delay));
}

function fire(row: PrayerRow, c: Computed, place: string) {
  const id = `${row.key}@${row.at.toISOString()}`;
  if (lastAlertKey() === id) return;
  markAlert(row);

  const a = settings.get().prayer.alerts ?? { notch: true, native: true, adhan: true };
  if (a.notch) showAlert(row, c.tz, place);
  if (a.adhan) playAdhan();
  if (a.native) void nativeNotify(row, c.tz, place);
}

/**
 * Starts the once-per-app scheduler and the toast click handler. Safe to call
 * more than once (React StrictMode, dev reloads).
 */
export function startPrayerAlerts() {
  if (started) return;
  started = true;
  void bindNativeActions();
  settings.subscribe(() => arm());
  arm();
}

/**
 * Settings/showcase preview: shows the next prayer's banner immediately.
 * `sound` also starts the adhan; when the native alert is enabled, the
 * Windows toast is sent as well, so "Testen" exercises every channel.
 * (Toast and adhan both respect their own toggles.)
 */
export function previewPrayerAlert(sound = false) {
  const { prayer, weather } = settings.get();
  if (!weather) return;
  const c = compute(prayer.method, prayer.madhab);
  if (!c) return;
  const row = nextPrayer(c);
  if (!row) return;
  const a = settings.get().prayer.alerts ?? { notch: true, native: true, adhan: true };
  if (a.notch) showAlert(row, c.tz, weather.name);
  if (a.native) void nativeNotify(row, c.tz, weather.name);
  if (sound && a.adhan) playAdhan();
}
