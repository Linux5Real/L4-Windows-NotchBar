import { createStore } from "../lib/store";
import type { AlarmDuration, AlarmSound } from "../lib/sound";

export type AskProvider = "openrouter" | "openai" | "anthropic" | "custom" | "opencode";
export type AskEffort = "low" | "medium" | "high" | "xhigh";
/** OpenCode only: Chat reads at most, Studio can write files and run commands. */
export type AskMode = "chat" | "studio";

/** Size of the closed notch / line (display setting). */
export type NotchScale = "s" | "m" | "l" | "xl";

export interface AskProviderConfig {
  model: string;
  effort: AskEffort;
  /** Only for "custom": OpenAI-compatible base, e.g. https://…/v1 */
  baseUrl: string;
  /** Only for "opencode"; defaults to "chat" in older settings. */
  mode?: AskMode;
}

export interface Settings {
  /** Open on hover or only on click. */
  openMode: "hover" | "click";
  hoverDelay: "fast" | "normal" | "patient";
  /** Order = order in the tool bar. `shortcut` = global hotkey opening the notch in that tool. */
  tools: { id: string; enabled: boolean; shortcut?: string }[];
  trading: { env: "live" | "demo" };
  /** AI usage: which providers are shown (order = display order). */
  usage: { claude: boolean; codex: boolean; gemini: boolean; cursor: boolean };
  ask: { provider: AskProvider; configs: Record<AskProvider, AskProviderConfig>; permission?: "allow" | "ask" | "deny"; /** Persist chat history across restarts. */ saveHistory?: boolean; /** Show the model's reasoning block in replies. */ thinking?: boolean };
  /** `auto` = detected via IP (again on every start); a picked location stays. */
  weather: { name: string; lat: number; lon: number; auto?: boolean } | null;
  /**
   * Prayer times: calculation method + Asr shadow rule (madhab). Location follows
   * `weather`. Alerts fire when a prayer begins: notch banner, Windows toast, adhan.
   */
  prayer: {
    method: "mwl" | "isna" | "egyptian" | "umm_al_qura" | "karachi" | "dubai" | "tehran" | "turkey";
    madhab: "shafi" | "hanafi";
    alerts: { notch: boolean; native: boolean; adhan: boolean };
  };
  /**
   * Display: always on top or hidden in fullscreen; monitor name (null = primary);
   * `offset` = horizontal offset from the center in CSS px (set by dragging).
   */
  display: {
    visibility: "always" | "hide-fullscreen";
    monitor: string | null;
    offset: number;
    /** Focus mode look: half transparent (as before) or shrunk to a thin line at the edge. */
    focusStyle: "dim" | "line";
    /** Size of the closed notch and the line; the open panel keeps its tool size. */
    scale: NotchScale;
    /**
     * Closed look outside focus mode: the notch, or a thin line (no music etc.; only a
     * finished timer opens it into the notch until dismissed). Hover and click work as usual.
     */
    idleStyle: "notch" | "line";
  };
  /** Gaming mode: FPS + load in the closed notch: off, only in fullscreen, or always. */
  gaming: { mode: "off" | "fullscreen" | "on" };
  /** Dots like on iPhone: mic/camera (green) or screen recording (red) in use. */
  privacyDots: boolean;
  /** Discord call in the notch (local RPC, on = Discord tool enabled). The client secret is stored with the secrets. */
  discord: { clientId: string };
  alarm: { sound: AlarmSound; volume: number; duration: AlarmDuration };
  language: "de" | "en";
  /** Temperature and clock format; picked from the Windows region on first start. */
  units: { temp: "c" | "f"; clock: "24" | "12" };
  /**
   * Presentation mode: hides clipboard previews, balances and the vault while sharing
   * the screen. `manual` = switched on by hand, `auto` = on while a recording is detected.
   */
  presentation: { manual: boolean; auto: boolean };
  /** Check for a new version once a day, anonymously (installs only on click). */
  updates: { auto: boolean };
}

/** All tool IDs in default order. Must match `src/notch/tabs.ts`. */
export const TOOL_IDS = [
  "overview",
  "media",
  "timer",
  "todos",
  "notes",
  "clipboard",
  "shelf",
  "ask",
  "convert",
  "translate",
  "ocr",
  "trading",
  "usage",
  "weather",
  "prayer",
  "system",
  "discord",
  "vault",
] as const;

const DEFAULT_OFF = new Set<string>(["system", "discord", "trading", "vault"]);

const defaults: Settings = {
  openMode: "hover",
  hoverDelay: "normal",
  tools: TOOL_IDS.map((id) => ({ id, enabled: !DEFAULT_OFF.has(id) })),
  trading: { env: "live" },
  usage: { claude: true, codex: true, gemini: true, cursor: false },
  ask: {
    provider: "opencode",
    permission: "allow",
    saveHistory: false,
    thinking: true,
    configs: {
      openrouter: { model: "", effort: "medium", baseUrl: "" },
      openai: { model: "", effort: "medium", baseUrl: "" },
      anthropic: { model: "claude-opus-5-5", effort: "medium", baseUrl: "" },
      custom: { model: "", effort: "medium", baseUrl: "" },
      opencode: { model: "opencode/deepseek-v4.1-flash-free", effort: "medium", baseUrl: "", mode: "chat" },
    },
  },
  weather: null,
  prayer: { method: "mwl", madhab: "shafi", alerts: { notch: true, native: true, adhan: true } },
  display: { visibility: "always", monitor: null, offset: 0, focusStyle: "dim", idleStyle: "notch", scale: "m" },
  gaming: { mode: "off" },
  privacyDots: false,
  discord: { clientId: "" },
  alarm: { sound: "chime", volume: 0.7, duration: 5 },
  language: "en",
  units: regionUnits(),
  presentation: { manual: false, auto: true },
  updates: { auto: true },
};

/** °F and 12 h where the Windows region uses them (US & co.), otherwise °C and 24 h. */
function regionUnits(): Settings["units"] {
  const loc = navigator.language || "en-US";
  let region = "";
  let cycle: string | undefined;
  try {
    region = new Intl.Locale(loc).maximize().region ?? "";
    cycle = new Intl.DateTimeFormat(loc, { hour: "numeric" }).resolvedOptions().hourCycle;
  } catch {
    // Unknown locale → metric, 24 h.
  }
  return {
    temp: ["US", "LR", "MM", "BS", "BZ", "KY", "PW", "FM", "MH"].includes(region) ? "f" : "c",
    clock: cycle === "h12" || cycle === "h11" ? "12" : "24",
  };
}

export const hoverDelayMs: Record<Settings["hoverDelay"], number> = { fast: 90, normal: 220, patient: 480 };

/** No settings saved yet = fresh install (read before the store writes its defaults). */
export const firstRun = (() => {
  try {
    return localStorage.getItem("notch:settings") === null;
  } catch {
    return false;
  }
})();

export const settings = createStore<Settings>(defaults, { persist: "settings" });

// Fill in settings from older versions: new fields + append new tools.
settings.set((s) => {
  const known = new Set<string>(TOOL_IDS);
  const tools = (s.tools ?? []).filter((t) => known.has(t.id));
  for (const id of TOOL_IDS) {
    if (tools.some((t) => t.id === id)) continue;
    // Overview is the start page, so put it first for existing installs.
    if (id === "overview") tools.unshift({ id, enabled: true });
    else tools.push({ id, enabled: !DEFAULT_OFF.has(id) });
  }
  return {
    ...defaults,
    ...s,
    tools,
    trading: { ...defaults.trading, ...s.trading },
    usage: { ...defaults.usage, ...s.usage },
    prayer: { ...defaults.prayer, ...s.prayer, alerts: { ...defaults.prayer.alerts, ...s.prayer?.alerts } },
    display: { ...defaults.display, ...s.display },
    gaming: { ...defaults.gaming, ...s.gaming },
    discord: { ...defaults.discord, ...s.discord },
    alarm: { ...defaults.alarm, ...s.alarm },
    units: { ...defaults.units, ...s.units },
    presentation: { ...defaults.presentation, ...s.presentation },
    updates: { ...defaults.updates, ...s.updates },
    ask: migrateAsk(s.ask),
  };
});

/** Migrates the old shape ({ provider: "demo", model }) and adds missing providers. */
function migrateAsk(old: Partial<Settings["ask"]> | undefined): Settings["ask"] {
  const known = Object.keys(defaults.ask.configs) as AskProvider[];

  // An untouched "custom" setup used to be the default. OpenCode now works out
  // of the box with free models, so move that unconfigured default over.
  const custom = old?.configs?.custom;
  const unconfiguredCustom = !custom?.model?.trim() && !custom?.baseUrl?.trim();
  const fallback = old?.provider === "custom" && unconfiguredCustom ? "opencode" : defaults.ask.provider;
  const provider = old?.provider && known.includes(old.provider) && !(old.provider === "custom" && unconfiguredCustom)
    ? old.provider
    : fallback;

  const configs = { ...defaults.ask.configs };
  for (const p of known) configs[p] = { ...defaults.ask.configs[p], ...old?.configs?.[p] };

  // Drop the old `opencode-llm-proxy` defaults. Notch now starts OpenCode itself.
  const opencode = configs.opencode;
  if (!opencode.baseUrl || /:4010(\/|$)/.test(opencode.baseUrl)) opencode.baseUrl = "";
  if (!opencode.model || opencode.model === "opencode/big-pickle") {
    opencode.model = defaults.ask.configs.opencode.model;
  }
  // One unified mode now; always studio (full capability).
  opencode.mode = "studio";

  const permission = (old?.permission === "allow" || old?.permission === "ask" || old?.permission === "deny") ? old.permission : "allow";
  const saveHistory = typeof old?.saveHistory === "boolean" ? old.saveHistory : false;
  const thinking = typeof old?.thinking === "boolean" ? old.thinking : true;
  return { provider, configs, permission, saveHistory, thinking };
}

export function updateAsk(provider: AskProvider, patch: Partial<AskProviderConfig>) {
  settings.set((s) => ({ ...s, ask: { ...s.ask, configs: { ...s.ask.configs, [provider]: { ...s.ask.configs[provider], ...patch } } } }));
}

export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
  settings.set((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
}
