import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "./native";
import bundledChangelog from "../changelog.json";
import { showcase, showcaseCall, showcaseCash, showcaseDayChange, showcaseFileSizes, showcasePositions, showcaseRealized } from "../dev/showcase-data";

/*
 * Bridges to the Rust services (src-tauri/src/*.rs). In the browser they return
 * sample data so every tool can be designed without the app.
 */

// ---------- Secrets (Credential Manager) ----------

export type SecretName = "t212.key" | "t212.secret" | "ai.anthropic" | "ai.openai" | "ai.openrouter" | "ai.custom" | "discord.secret";

const mockSecrets = new Map<SecretName, string>();

export const secrets = {
  has: (name: SecretName): Promise<boolean> =>
    isNative ? invoke<boolean>("secret_has", { name }) : Promise.resolve(mockSecrets.has(name)),
  set: (name: SecretName, value: string): Promise<void> => {
    if (isNative) return invoke("secret_set", { name, value });
    if (value.trim()) mockSecrets.set(name, value.trim());
    else mockSecrets.delete(name);
    return Promise.resolve();
  },
};

// ---------- Trading 212 ----------

export interface Position {
  ticker: string;
  name: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  priceCurrency: string;
  value: number;
  cost: number;
  pnl: number;
}

export interface Snapshot {
  date: string;
  /** Account value including cash. */
  value: number;
  invested: number;
  /** Total profit; change vs. yesterday = daily change (excluding deposits/purchases). */
  pnl: number;
}

export interface TradingData {
  currency: string;
  totalValue: number;
  cash: number;
  invested: number;
  currentValue: number;
  unrealized: number;
  realized: number;
  positions: Position[];
  history: Snapshot[];
  /** Today's data points (every ~2 min while the portfolio was open). */
  intraday: { t: number; value: number; pnl: number }[];
}

/** Error codes from Rust: no-key, unauthorized, forbidden, rate, network:… */
export function fetchTrading(env: "live" | "demo"): Promise<TradingData> {
  const today = localDate(new Date());
  return isNative ? invoke<TradingData>("trading_fetch", { env, today }) : mockTrading();
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function mockTrading(): Promise<TradingData> {
  await new Promise((r) => setTimeout(r, showcase ? 160 : 450));
  if (!mockSecrets.has("t212.key")) throw "no-key";
  if (showcase) return showcaseTrading();
  const positions: Position[] = [
    { ticker: "NVDA", name: "NVIDIA", quantity: 12, averagePrice: 98.4, currentPrice: 141.2, priceCurrency: "USD", value: 1458.3, cost: 1012.6, pnl: 445.7 },
    { ticker: "VUSA", name: "Vanguard S&P 500", quantity: 30, averagePrice: 88.1, currentPrice: 104.6, priceCurrency: "EUR", value: 3138.0, cost: 2643.0, pnl: 495.0 },
    { ticker: "AAPL", name: "Apple", quantity: 6, averagePrice: 212.5, currentPrice: 204.9, priceCurrency: "USD", value: 1060.8, cost: 1100.1, pnl: -39.3 },
    { ticker: "ASML", name: "ASML Holding", quantity: 1.5, averagePrice: 690.0, currentPrice: 655.2, priceCurrency: "EUR", value: 982.8, cost: 1035.0, pnl: -52.2 },
    { ticker: "MSFT", name: "Microsoft", quantity: 2, averagePrice: 380.0, currentPrice: 431.5, priceCurrency: "USD", value: 742.4, cost: 655.8, pnl: 86.6 },
  ];
  const currentValue = positions.reduce((s, p) => s + p.value, 0);
  const invested = positions.reduce((s, p) => s + p.cost, 0);
  const cash = 412.35;
  const realized = 128.4;
  const pnlNow = currentValue - invested + realized;
  const history: Snapshot[] = [];
  let pnl = pnlNow - 260;
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    pnl = i === 0 ? pnlNow : pnl + Math.sin(i * 1.7) * 55 + 18;
    history.push({ date: localDate(d), value: invested + cash + pnl - realized, invested, pnl });
  }
  // Intraday from 9:00 every 2 min, ending at the current value.
  const start = new Date();
  start.setHours(9, 0, 0, 0);
  const steps = Math.max(2, Math.floor((Date.now() - start.getTime()) / 120_000));
  const yesterday = history.at(-2)!.pnl;
  const intraday = Array.from({ length: steps }, (_, i) => {
    const f = i / (steps - 1);
    const p = yesterday + (pnlNow - yesterday) * f + Math.sin(i * 0.09) * 18 * (1 - f) + Math.sin(i * 0.31) * 3;
    return { t: start.getTime() + i * 120_000, value: invested + cash + p - realized, pnl: i === steps - 1 ? pnlNow : p };
  });
  return { currency: "EUR", totalValue: currentValue + cash, cash, invested, currentValue, unrealized: currentValue - invested, realized, positions, history, intraday };
}

/** Showcase: 30 days of steady growth, today exactly +showcaseDayChange. */
function showcaseTrading(): TradingData {
  const positions: Position[] = showcasePositions;
  const currentValue = Math.round(positions.reduce((s, p) => s + p.value, 0) * 100) / 100;
  const invested = Math.round(positions.reduce((s, p) => s + p.cost, 0) * 100) / 100;
  const cash = showcaseCash;
  const realized = showcaseRealized;
  const pnlNow = currentValue - invested + realized;
  const yesterday = pnlNow - showcaseDayChange;
  const history: Snapshot[] = [];
  for (let i = 30; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const f = (30 - i) / 30;
    // Rising trend with a dip in the middle; the last two points are fixed.
    const pnl = i === 0 ? pnlNow : i === 1 ? yesterday : yesterday - 1450 * (1 - f) + Math.sin(i * 0.9) * 120 - Math.max(0, 1 - Math.abs(i - 14) / 5) * 380;
    history.push({ date: localDate(d), value: invested + cash + pnl - realized, invested, pnl });
  }
  const start = new Date();
  start.setHours(9, 0, 0, 0);
  const steps = Math.max(2, Math.floor((Date.now() - start.getTime()) / 120_000));
  const intraday = Array.from({ length: steps }, (_, i) => {
    const f = i / (steps - 1);
    const p = i === steps - 1 ? pnlNow : yesterday + showcaseDayChange * f + Math.sin(i * 0.8) * 46 * (1 - f) - Math.sin(f * Math.PI) * 60;
    return { t: start.getTime() + i * 120_000, value: invested + cash + p - realized, pnl: p };
  });
  return { currency: "EUR", totalValue: currentValue + cash, cash, invested, currentValue, unrealized: currentValue - invested, realized, positions, history, intraday };
}

// ---------- AI usage ----------

export type UsageId = "claude" | "codex" | "gemini" | "cursor";

export interface UsageWindow {
  /** session | weekly | weekly-opus | weekly-sonnet | daily | monthly | model:<Name> */
  kind: string;
  usedPercent: number;
  resetsAt: number | null;
  /** Window length in seconds (for the "on track" marker). */
  windowSecs: number | null;
}

export interface UsageProvider {
  id: UsageId;
  plan: string | null;
  windows: UsageWindow[];
  /** not-found | not-signed-in | expired | rate-limited | offline | failed (with data: stale). */
  error: string | null;
  updatedAt: number;
}

export function fetchUsage(providers: string[]): Promise<UsageProvider[]> {
  if (isNative) return invoke<UsageProvider[]>("usage_fetch", { providers });
  const now = Date.now();
  const h = 3600_000;
  const d = 86_400_000;
  const all: UsageProvider[] = [
    {
      id: "claude",
      plan: "Max",
      windows: [
        { kind: "session", usedPercent: 44, resetsAt: now + 2.4 * h, windowSecs: 5 * 3600 },
        { kind: "weekly", usedPercent: 61, resetsAt: now + 3.1 * d, windowSecs: 7 * 86_400 },
        { kind: "weekly-opus", usedPercent: 18, resetsAt: now + 3.1 * d, windowSecs: 7 * 86_400 },
      ],
      error: null,
      updatedAt: now,
    },
    {
      id: "codex",
      plan: "Plus",
      windows: [
        { kind: "session", usedPercent: 71, resetsAt: now + 0.8 * h, windowSecs: 5 * 3600 },
        { kind: "weekly", usedPercent: 23, resetsAt: now + 5.2 * d, windowSecs: 7 * 86_400 },
      ],
      error: null,
      updatedAt: now - 4 * 60_000,
    },
    { id: "gemini", plan: null, windows: [], error: "not-found", updatedAt: now },
    { id: "cursor", plan: null, windows: [], error: "not-found", updatedAt: now },
  ];
  return new Promise((r) => setTimeout(() => r(all.filter((p) => providers.includes(p.id))), 350));
}

// ---------- System ----------

export interface SystemStats {
  cpu: number;
  cpuName: string;
  memUsed: number;
  memTotal: number;
  /** null = no GPU counters. */
  gpu: number | null;
  gpuName: string | null;
  gpuMemUsed: number;
  gpuMemTotal: number;
  /** ms; null = no reply. */
  ping: number | null;
}

let mock = { cpu: 18, gpu: 32, ping: 14 };
/** `full = false`: CPU and RAM only (GPU and ping come back as null / 0). */
export function fetchSystem(full: boolean): Promise<SystemStats> {
  if (isNative) return invoke<SystemStats>("system_stats", { full });
  const walk = (v: number, step: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * step));
  mock = { cpu: walk(mock.cpu, 14, 3, 96), gpu: walk(mock.gpu, 18, 0, 99), ping: walk(mock.ping, 6, 8, 60) };
  const gb = 1024 ** 3;
  return Promise.resolve({
    cpu: mock.cpu,
    cpuName: "Ryzen 7 7800X3D 8-Core",
    memUsed: 13.4 * gb + Math.random() * 0.3 * gb,
    memTotal: 32 * gb,
    gpu: full ? mock.gpu : null,
    gpuName: "GeForce RTX 4070 Ti",
    gpuMemUsed: full ? 2.9 * gb + (mock.gpu / 100) * 3 * gb : 0,
    gpuMemTotal: 12 * gb,
    ping: full ? Math.round(mock.ping) : null,
  });
}

// ---------- Converter ----------

export type FileKind = "image" | "audio" | "video" | "document" | "table" | "other";

export interface DroppedFile {
  path: string;
  name: string;
  kind: FileKind;
  ext: string;
  size: number;
}

export interface ConvertResult {
  input: string;
  output: string | null;
  error: string | null;
}

export function probeFiles(paths: string[]): Promise<{ files: DroppedFile[]; ffmpeg: boolean }> {
  if (isNative) return invoke("convert_probe", { paths });
  // Browser: paths are made-up names from the drop event.
  const files = paths.map((p) => {
    const name = p.split(/[\\/]/).pop() ?? p;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const kind: FileKind = /^(png|jpe?g|webp|bmp|gif|ico|tiff?|dds|tga)$/.test(ext)
      ? "image"
      : /^(mp3|wav|flac|m4a|aac|ogg|opus)$/.test(ext)
        ? "audio"
        : /^(mp4|mov|mkv|avi|webm)$/.test(ext)
          ? "video"
          : /^(txt|md|markdown|html?|pdf|docx)$/.test(ext)
            ? "document"
            : /^(xlsx|xlsm|xls|ods|csv|tsv)$/.test(ext)
              ? "table"
              : "other";
    return { path: p, name, kind, ext, size: (showcase && showcaseFileSizes[name]) || 1_400_000 + name.length * 91_000 };
  });
  return Promise.resolve({ files, ffmpeg: false });
}

export function convertFiles(paths: string[], target: string, quality: number, maxSize: number | null): Promise<ConvertResult[]> {
  if (isNative) return invoke("convert_files", { paths, target, quality, maxSize });
  return new Promise((r) =>
    setTimeout(
      () =>
        r(
          paths.map((input) => {
            const ext = input.split(".").pop()?.toLowerCase();
            if (ext === target) return { input, output: null, error: "Ist schon in diesem Format" };
            return { input, output: input.replace(/\.[^.]+$/, `.${target}`), error: null };
          }),
        ),
      900,
    ),
  );
}

export function revealFile(path: string) {
  if (isNative) void invoke("reveal_file", { path });
}

export function openFile(path: string): Promise<void> {
  return isNative ? invoke("open_path", { path }) : Promise.resolve();
}

/** Puts files on the clipboard (Ctrl+V in Explorer pastes them). */
export function copyFiles(paths: string[]): Promise<void> {
  return isNative ? invoke("copy_files", { paths }) : Promise.resolve();
}

export function filePreview(path: string): Promise<string | null> {
  return isNative ? invoke<string | null>("file_preview", { path }) : Promise.resolve(null);
}

// ---------- Updates ----------

/** A found update: version + install (downloads, installs, restarts). */
export interface UpdateHandle {
  version: string;
  install: (onProgress: (fraction: number) => void) => Promise<void>;
}

/** What changed in a version (`src/changelog.json`, newest first). */
export interface ChangelogEntry {
  version: string;
  date: string;
  /** `highlight`: shown in bold and bright (e.g. an announcement). Older versions ignore it. */
  items: { de: string; en: string; highlight?: boolean }[];
}

/** In the browser, `?update` in the URL fakes an update for testing. */
const mockUpdate: UpdateHandle = {
  version: "1.3.0",
  install: async (onProgress) => {
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 120));
      onProgress(i / 20);
    }
  },
};

export const updater = {
  current: async (): Promise<string> => {
    // Browser: newest bundled version; `?version=1.1.0` fakes an older one (changelog test).
    if (!isNative) return new URLSearchParams(location.search).get("version") ?? bundledChangelog[0].version;
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
  /** Fetches the signed latest.json from the newest GitHub release. null = up to date. */
  check: async (): Promise<UpdateHandle | null> => {
    if (!isNative) return new URLSearchParams(location.search).has("update") ? mockUpdate : null;
    const { check } = await import("@tauri-apps/plugin-updater");
    const found = await check();
    if (!found) return null;
    return {
      version: found.version,
      install: async (onProgress) => {
        let total = 0;
        let done = 0;
        await found.downloadAndInstall((e) => {
          if (e.event === "Started") total = e.data.contentLength ?? 0;
          else if (e.event === "Progress" && total) onProgress(Math.min(1, (done += e.data.chunkLength) / total));
        });
        // Windows quits the app itself while installing; otherwise restart here.
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  },
};

/**
 * Changelog of a newer version, before installing it: the same `src/changelog.json`
 * from that release's tag (anonymous, like the update check). null = not reachable.
 */
export async function fetchChangelog(version: string): Promise<ChangelogEntry[] | null> {
  if (!isNative) {
    const mock = { de: "Beispiel: Neuerung aus der kommenden Version", en: "Example: something new in the upcoming version" };
    return [{ version, date: new Date().toISOString().slice(0, 10), items: [mock, mock] }, ...bundledChangelog];
  }
  try {
    const r = await fetch(`https://raw.githubusercontent.com/Linux5Real/L4-Windows-NotchBar/v${version}/src/changelog.json`, {
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? ((await r.json()) as ChangelogEntry[]) : null;
  } catch {
    return null;
  }
}

// ---------- Autostart ----------

export const autostart = {
  get: (): Promise<boolean> => (isNative ? invoke<boolean>("autostart_get") : Promise.resolve(true)),
  set: (enabled: boolean): Promise<void> => (isNative ? invoke("autostart_set", { enabled }) : Promise.resolve()),
};

// ---------- Display ----------

export interface MonitorInfo {
  name: string;
  primary: boolean;
  width: number;
  height: number;
}

export const display = {
  monitors: (): Promise<MonitorInfo[]> =>
    isNative
      ? invoke<MonitorInfo[]>("display_monitors")
      : Promise.resolve([
          { name: "\\.\DISPLAY1", primary: true, width: 2560, height: 1440 },
          { name: "\\.\DISPLAY2", primary: false, width: 1920, height: 1080 },
        ]),
  apply: (config: { hideFullscreen: boolean; monitor: string | null; offset: number; gaming: boolean }) => {
    if (isNative) void invoke("display_apply", { config });
  },
  /** true while an app covers the notch's monitor in fullscreen. */
  onFullscreen: (handler: (on: boolean) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<boolean>("notch://fullscreen", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
};

// ---------- Gaming mode ----------

/** FPS of the foreground process (ETW). error: no-admin | failed. */
/** One-time unlock so FPS work without running as admin (one UAC prompt). */
export function unlockFps(): Promise<"ok" | "relogin" | "cancelled" | "failed"> {
  if (isNative) return invoke("fps_unlock");
  return new Promise((r) => setTimeout(() => r("relogin"), 600));
}

export function fetchFps(): Promise<{ fps: number | null; error: string | null }> {
  if (isNative) return invoke("gaming_fps");
  return Promise.resolve({ fps: 138 + Math.round((Math.random() - 0.5) * 14), error: null });
}

// ---------- Privacy dots ----------

export interface PrivacyState {
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

/** Toggled from the dev panel in the browser. */
export const mockPrivacy: PrivacyState = { mic: false, camera: false, screen: false };

export function fetchPrivacy(): Promise<PrivacyState> {
  return isNative ? invoke<PrivacyState>("privacy_state") : Promise.resolve({ ...mockPrivacy });
}

// ---------- Discord ----------

export interface DiscordMember {
  id: string;
  name: string;
  avatar: string;
  speaking: boolean;
  muted: boolean;
}

export interface DiscordCall {
  channelId: string;
  channelName: string;
  guildName: string | null;
  guildIcon: string | null;
  mute: boolean;
  deaf: boolean;
  /** You are speaking right now. */
  speaking: boolean;
  members: DiscordMember[];
}

export interface DiscordSnapshot {
  /** off | no-config | no-client | connecting | authorizing | ready | error */
  status: string;
  error: string | null;
  call: DiscordCall | null;
}

export type DiscordAction = "mute" | "deafen" | "leave";

export const discord = {
  configure: (enabled: boolean, clientId: string) => {
    if (isNative) void invoke("discord_configure", { enabled, clientId });
  },
  state: (): Promise<DiscordSnapshot> => (isNative ? invoke<DiscordSnapshot>("discord_state") : Promise.resolve(mockDiscord.get())),
  action: (action: DiscordAction) => {
    if (isNative) return void invoke("discord_action", { action });
    mockDiscord.act(action);
  },
  onState: (handler: (s: DiscordSnapshot) => void): (() => void) => {
    if (!isNative) return mockDiscord.subscribe(handler);
    const off = listen<DiscordSnapshot>("discord://state", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
};

/** Browser: a sample call, started/ended from the dev panel. */
export const mockDiscord = (() => {
  const avatar = (n: number) => `https://cdn.discordapp.com/embed/avatars/${n}.png`;
  let state: DiscordSnapshot = { status: "ready", error: null, call: null };
  const listeners = new Set<(s: DiscordSnapshot) => void>();
  const emit = () => listeners.forEach((l) => l(state));
  let talk: ReturnType<typeof setInterval> | undefined;
  const set = (call: DiscordCall | null) => {
    state = { ...state, call };
    emit();
  };
  return {
    get: () => state,
    subscribe(l: (s: DiscordSnapshot) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    toggleCall() {
      clearInterval(talk);
      if (state.call) return set(null);
      set({
        channelId: "1",
        channelName: showcase ? showcaseCall.channelName : "Zocken",
        guildName: showcase ? showcaseCall.guildName : "Die Runde",
        guildIcon: null,
        mute: false,
        deaf: false,
        speaking: false,
        members: showcase
          ? showcaseCall.members.map((m) => ({ id: m.id, name: m.name, avatar: avatar(m.avatar), speaking: false, muted: m.id === "3" }))
          : [
              { id: "1", name: "Du", avatar: avatar(0), speaking: false, muted: false },
              { id: "2", name: "Mara", avatar: avatar(1), speaking: false, muted: false },
              { id: "3", name: "Jonas", avatar: avatar(2), speaking: false, muted: true },
              { id: "4", name: "Lea", avatar: avatar(3), speaking: false, muted: false },
            ],
      });
      // Take turns speaking so the rings are visible.
      let i = 0;
      talk = setInterval(() => {
        if (!state.call) return;
        i++;
        const who = (showcase ? ["2", "4", "2", "1"] : ["1", "2", "4", ""])[i % 4];
        set({ ...state.call, speaking: who === "1" && !state.call.mute, members: state.call.members.map((m) => ({ ...m, speaking: m.id === who && !m.muted && !(m.id === "1" && state.call!.mute) })) });
      }, 1400);
    },
    act(action: DiscordAction) {
      const c = state.call;
      if (!c) return;
      if (action === "leave") return this.toggleCall();
      if (action === "mute") set({ ...c, mute: !c.mute, members: c.members.map((m) => (m.id === "1" ? { ...m, muted: !c.mute || c.deaf } : m)) });
      if (action === "deafen") set({ ...c, deaf: !c.deaf, mute: !c.deaf ? true : c.mute });
    },
  };
})();

// ---------- Overview: volume + Windows focus ----------

export interface VolumeState {
  /** 0..1 */
  level: number;
  muted: boolean;
}

export interface FocusState {
  active: boolean;
  /** "focus" = focus session (Windows 11), "dnd" = only Do Not Disturb */
  kind: "focus" | "dnd";
}

const mockVolume: VolumeState = { level: 0.42, muted: false };
const mockFocus: FocusState = { active: false, kind: "focus" };

/** One program in the volume mixer (all its audio sessions together). */
export interface AppVolume {
  /** Lowercase exe name, e.g. "spotify.exe". */
  id: string;
  name: string;
  /** PNG data URL of the program icon. */
  icon: string | null;
  /** 0..1 */
  level: number;
  muted: boolean;
  /** Source of what is playing right now. */
  media: boolean;
}

/** App icons for the browser mock (simple marks, only for design work and stills). */
const svgIcon = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`)}`;
const discordPath =
  "M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286ZM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189Zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z";

const mockIcons = {
  spotify: svgIcon(
    `<circle cx="16" cy="16" r="15" fill="#1ed760"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M8.5 12.2c5-1.5 10.6-1.1 15 1.2" stroke-width="2.4"/><path d="M9.4 16.6c4.2-1.2 8.8-.8 12.5 1.1" stroke-width="2"/><path d="M10.2 20.6c3.4-.9 6.9-.6 9.8.9" stroke-width="1.7"/></g>`,
  ),
  chrome: svgIcon(
    `<circle cx="16" cy="16" r="15" fill="#db4437"/><path d="M16 16 3.3 23.5A15 15 0 0 0 16 31z" fill="#0f9d58"/><path d="M16 16 16 31A15 15 0 0 0 28.7 8.5z" fill="#f4b400"/><path d="M16 16 3.3 23.5A15 15 0 0 1 3.3 8.5z" fill="#0f9d58"/><circle cx="16" cy="16" r="6.6" fill="#fff"/><circle cx="16" cy="16" r="5.2" fill="#4285f4"/>`,
  ),
  discord: svgIcon(`<rect width="32" height="32" rx="8" fill="#5865f2"/><g transform="translate(6 6) scale(.8333)"><path fill="#fff" d="${discordPath}"/></g>`),
  steam: svgIcon(
    `<circle cx="16" cy="16" r="15" fill="#1b2838"/><circle cx="20" cy="12.5" r="4.6" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="20" cy="12.5" r="2" fill="#fff"/><circle cx="11.5" cy="20.5" r="3.2" fill="#fff"/><path d="M11.5 20.5 20 12.5" stroke="#fff" stroke-width="2"/>`,
  ),
};

/** Exported for the dev panel ("Quelle wechseln"). */
export const mockApps: AppVolume[] = [
  { id: "spotify.exe", name: "Spotify", icon: mockIcons.spotify, level: 0.72, muted: false, media: true },
  { id: "chrome.exe", name: "Google Chrome", icon: mockIcons.chrome, level: 1, muted: false, media: false },
  { id: "discord.exe", name: "Discord", icon: mockIcons.discord, level: 0.45, muted: false, media: false },
  { id: "steam.exe", name: "Steam", icon: mockIcons.steam, level: 0.3, muted: true, media: false },
];

/** Volume per app, like the Windows volume mixer (src-tauri/src/mixer.rs). */
export const mixer = {
  list: (): Promise<AppVolume[]> => (isNative ? invoke<AppVolume[]>("mixer_list") : Promise.resolve(mockApps.map((a) => ({ ...a })))),
  set: (id: string, patch: { level?: number; muted?: boolean }): Promise<void> => {
    if (isNative) return invoke("mixer_set", { id, ...patch });
    const app = mockApps.find((a) => a.id === id);
    if (app) Object.assign(app, patch, patch.level !== undefined && patch.level > 0 && patch.muted === undefined ? { muted: false } : {});
    return Promise.resolve();
  },
};

export const systemControls = {
  volume: (): Promise<VolumeState> => (isNative ? invoke<VolumeState>("volume_get") : Promise.resolve({ ...mockVolume })),
  setVolume: (patch: { level?: number; muted?: boolean }): Promise<VolumeState> => {
    if (isNative) return invoke<VolumeState>("volume_set", patch);
    Object.assign(mockVolume, patch, patch.level !== undefined && patch.level > 0 && patch.muted === undefined ? { muted: false } : {});
    return Promise.resolve({ ...mockVolume });
  },
  focus: (): Promise<FocusState> => (isNative ? invoke<FocusState>("focus_get") : Promise.resolve({ ...mockFocus })),
  setFocus: (active: boolean): Promise<FocusState> => {
    if (isNative) return invoke<FocusState>("focus_set", { active });
    mockFocus.active = active;
    return Promise.resolve({ ...mockFocus });
  },
};
