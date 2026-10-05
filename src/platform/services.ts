import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "./native";

/*
 * Brücken zu den Rust-Diensten (src-tauri/src/*.rs). Im Browser liefern sie
 * Beispieldaten, damit sich jedes Tool ohne App gestalten lässt.
 */

// ---------- Geheimnisse (Anmeldeinformationsverwaltung) ----------

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
  /** Kontowert inkl. Cash. */
  value: number;
  invested: number;
  /** Gewinn gesamt; Differenz zum Vortag = Tagesänderung (ohne Einzahlungen/Käufe). */
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
  /** Messpunkte des heutigen Tages (alle ~2 min, solange das Depot offen war). */
  intraday: { t: number; value: number; pnl: number }[];
}

/** Fehlercodes aus Rust: no-key, unauthorized, forbidden, rate, network:… */
export function fetchTrading(env: "live" | "demo"): Promise<TradingData> {
  const today = localDate(new Date());
  return isNative ? invoke<TradingData>("trading_fetch", { env, today }) : mockTrading();
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function mockTrading(): Promise<TradingData> {
  await new Promise((r) => setTimeout(r, 450));
  if (!mockSecrets.has("t212.key")) throw "no-key";
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
  // Tagesverlauf ab 9:00 alle 2 min, endet beim aktuellen Stand.
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

// ---------- AI-Nutzung ----------

export type UsageId = "claude" | "codex" | "gemini" | "cursor";

export interface UsageWindow {
  /** session | weekly | weekly-opus | weekly-sonnet | daily | monthly | model:<Name> */
  kind: string;
  usedPercent: number;
  resetsAt: number | null;
  /** Länge des Fensters in Sekunden (für die "im Plan"-Markierung). */
  windowSecs: number | null;
}

export interface UsageProvider {
  id: UsageId;
  plan: string | null;
  windows: UsageWindow[];
  /** not-found | not-signed-in | expired | rate-limited | offline | failed (bei Daten: veraltet). */
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
  /** null = keine GPU-Indikatoren. */
  gpu: number | null;
  gpuName: string | null;
  gpuMemUsed: number;
  gpuMemTotal: number;
  /** ms; null = keine Antwort. */
  ping: number | null;
}

let mock = { cpu: 18, gpu: 32, ping: 14 };
export function fetchSystem(): Promise<SystemStats> {
  if (isNative) return invoke<SystemStats>("system_stats");
  const walk = (v: number, step: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * step));
  mock = { cpu: walk(mock.cpu, 14, 3, 96), gpu: walk(mock.gpu, 18, 0, 99), ping: walk(mock.ping, 6, 8, 60) };
  const gb = 1024 ** 3;
  return Promise.resolve({
    cpu: mock.cpu,
    cpuName: "Ryzen 7 7800X3D 8-Core",
    memUsed: 13.4 * gb + Math.random() * 0.3 * gb,
    memTotal: 32 * gb,
    gpu: mock.gpu,
    gpuName: "GeForce RTX 4070 Ti",
    gpuMemUsed: 2.9 * gb + (mock.gpu / 100) * 3 * gb,
    gpuMemTotal: 12 * gb,
    ping: Math.round(mock.ping),
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
  // Browser: Pfade sind erfundene Namen aus dem Drop-Event.
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
    return { path: p, name, kind, ext, size: 1_400_000 + name.length * 91_000 };
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

/** Dateien in die Zwischenablage (Strg+V im Explorer fügt sie ein). */
export function copyFiles(paths: string[]): Promise<void> {
  return isNative ? invoke("copy_files", { paths }) : Promise.resolve();
}

export function filePreview(path: string): Promise<string | null> {
  return isNative ? invoke<string | null>("file_preview", { path }) : Promise.resolve(null);
}

// ---------- Updates ----------

/** Gefundenes Update: Version + Installieren (lädt, installiert, startet neu). */
export interface UpdateHandle {
  version: string;
  install: (onProgress: (fraction: number) => void) => Promise<void>;
}

/** Im Browser: mit `?update` in der URL gibt es zum Testen ein Schein-Update. */
const mockUpdate: UpdateHandle = {
  version: "0.2.0",
  install: async (onProgress) => {
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 120));
      onProgress(i / 20);
    }
  },
};

export const updater = {
  current: async (): Promise<string> => {
    if (!isNative) return "0.1.0";
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
  /** Fragt die signierte latest.json im neuesten GitHub-Release ab. null = aktuell. */
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
        // Windows beendet die App beim Installieren selbst; sonst hier neu starten.
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  },
};

// ---------- Autostart ----------

export const autostart = {
  get: (): Promise<boolean> => (isNative ? invoke<boolean>("autostart_get") : Promise.resolve(true)),
  set: (enabled: boolean): Promise<void> => (isNative ? invoke("autostart_set", { enabled }) : Promise.resolve()),
};

// ---------- Darstellung ----------

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
  /** true, solange eine App den Monitor der Notch im Vollbild abdeckt. */
  onFullscreen: (handler: (on: boolean) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<boolean>("notch://fullscreen", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
};

// ---------- Gaming-Modus ----------

/** FPS des Vordergrundprozesses (ETW). error: no-admin | failed. */
/** Einmalig ohne Admin freischalten (Gruppe "Leistungsprotokollbenutzer", eine UAC-Abfrage). */
export function unlockFps(): Promise<"ok" | "relogin" | "cancelled" | "failed"> {
  if (isNative) return invoke("fps_unlock");
  return new Promise((r) => setTimeout(() => r("relogin"), 600));
}

export function fetchFps(): Promise<{ fps: number | null; error: string | null }> {
  if (isNative) return invoke("gaming_fps");
  return Promise.resolve({ fps: 138 + Math.round((Math.random() - 0.5) * 14), error: null });
}

// ---------- Datenschutz-Punkte ----------

export interface PrivacyState {
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

/** Im Browser über das Dev-Panel umschaltbar. */
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
  /** Man selbst spricht gerade. */
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

/** Browser: ein Beispiel-Anruf, über das Dev-Panel start-/beendbar. */
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
        channelName: "Zocken",
        guildName: "Die Runde",
        guildIcon: null,
        mute: false,
        deaf: false,
        speaking: false,
        members: [
          { id: "1", name: "Du", avatar: avatar(0), speaking: false, muted: false },
          { id: "2", name: "Mara", avatar: avatar(1), speaking: false, muted: false },
          { id: "3", name: "Jonas", avatar: avatar(2), speaking: false, muted: true },
          { id: "4", name: "Lea", avatar: avatar(3), speaking: false, muted: false },
        ],
      });
      // Abwechselnd sprechen, damit man die Ringe sieht.
      let i = 0;
      talk = setInterval(() => {
        if (!state.call) return;
        i++;
        const who = ["1", "2", "4", ""][i % 4];
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

// ---------- Übersicht: Lautstärke + Windows-Fokus ----------

export interface VolumeState {
  /** 0..1 */
  level: number;
  muted: boolean;
}

export interface FocusState {
  active: boolean;
  /** "focus" = Fokussitzung (Windows 11), "dnd" = nur "Nicht stören" */
  kind: "focus" | "dnd";
}

const mockVolume: VolumeState = { level: 0.42, muted: false };
const mockFocus: FocusState = { active: false, kind: "focus" };

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
