import { createStore } from "../lib/store";
import type { AlarmDuration, AlarmSound } from "../lib/sound";

export type AskProvider = "openrouter" | "openai" | "anthropic" | "custom";
export type AskEffort = "low" | "medium" | "high" | "xhigh";

export interface AskProviderConfig {
  model: string;
  effort: AskEffort;
  /** Nur für "custom": OpenAI-kompatible Basis, z. B. https://…/v1 */
  baseUrl: string;
}

export interface Settings {
  /** Öffnen bei Hover oder erst bei Klick. */
  openMode: "hover" | "click";
  hoverDelay: "fast" | "normal" | "patient";
  /** Reihenfolge = Reihenfolge in der Kopfzeile. */
  tools: { id: string; enabled: boolean }[];
  trading: { env: "live" | "demo" };
  /** AI-Nutzung: welche Anbieter angezeigt werden (Reihenfolge = Anzeige). */
  usage: { claude: boolean; codex: boolean; gemini: boolean; cursor: boolean };
  ask: { provider: AskProvider; configs: Record<AskProvider, AskProviderConfig> };
  /** `auto` = per IP erkannt (bei jedem Start neu); selbst gewählt bleibt fest. */
  weather: { name: string; lat: number; lon: number; auto?: boolean } | null;
  /**
   * Darstellung: immer oben oder bei Vollbild ausblenden; Monitor-Name (null = Hauptmonitor);
   * `offset` = seitliche Verschiebung in CSS-px aus der Mitte (per Ziehen gesetzt).
   */
  display: { visibility: "always" | "hide-fullscreen"; monitor: string | null; offset: number };
  /** Gaming-Modus: FPS + Auslastung in der geschlossenen Notch — aus, nur bei Vollbild oder immer. */
  gaming: { mode: "off" | "fullscreen" | "on" };
  /** Punkte wie beim iPhone: Mikrofon/Kamera (grün) bzw. Bildschirmaufnahme (rot) in Benutzung. */
  privacyDots: boolean;
  /** Discord-Anruf in der Notch (lokales RPC, an = Tool "discord" aktiv). Client-Secret liegt in den Geheimnissen. */
  discord: { clientId: string };
  alarm: { sound: AlarmSound; volume: number; duration: AlarmDuration };
  language: "de" | "en";
  /** Einmal täglich anonym nach einer neuen Version suchen (installiert wird nur auf Klick). */
  updates: { auto: boolean };
}

/** Alle Tool-IDs in Standardreihenfolge. Muss zu `src/notch/tabs.ts` passen. */
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
  "trading",
  "usage",
  "weather",
  "system",
  "discord",
] as const;

const DEFAULT_OFF = new Set<string>(["system", "discord"]);

const defaults: Settings = {
  openMode: "hover",
  hoverDelay: "normal",
  tools: TOOL_IDS.map((id) => ({ id, enabled: !DEFAULT_OFF.has(id) })),
  trading: { env: "live" },
  usage: { claude: true, codex: true, gemini: true, cursor: false },
  ask: {
    provider: "custom",
    configs: {
      openrouter: { model: "", effort: "medium", baseUrl: "" },
      openai: { model: "", effort: "medium", baseUrl: "" },
      anthropic: { model: "claude-opus-5-5", effort: "medium", baseUrl: "" },
      custom: { model: "", effort: "medium", baseUrl: "" },
    },
  },
  weather: null,
  display: { visibility: "hide-fullscreen", monitor: null, offset: 0 },
  gaming: { mode: "off" },
  privacyDots: true,
  discord: { clientId: "" },
  alarm: { sound: "chime", volume: 0.7, duration: 5 },
  language: "de",
  updates: { auto: true },
};

export const hoverDelayMs: Record<Settings["hoverDelay"], number> = { fast: 90, normal: 220, patient: 480 };

export const settings = createStore<Settings>(defaults, { persist: "settings" });

// Gespeicherte Einstellungen älterer Versionen ergänzen: neue Felder + neue Tools hinten anhängen.
settings.set((s) => {
  const known = new Set<string>(TOOL_IDS);
  const tools = (s.tools ?? []).filter((t) => known.has(t.id));
  for (const id of TOOL_IDS) {
    if (tools.some((t) => t.id === id)) continue;
    // Die Übersicht ist die Startseite → bei bestehenden Installationen vorne einreihen.
    if (id === "overview") tools.unshift({ id, enabled: true });
    else tools.push({ id, enabled: !DEFAULT_OFF.has(id) });
  }
  return {
    ...defaults,
    ...s,
    tools,
    trading: { ...defaults.trading, ...s.trading },
    usage: { ...defaults.usage, ...s.usage },
    display: { ...defaults.display, ...s.display },
    gaming: { ...defaults.gaming, ...s.gaming },
    discord: { ...defaults.discord, ...s.discord },
    alarm: { ...defaults.alarm, ...s.alarm },
    updates: { ...defaults.updates, ...s.updates },
    ask: migrateAsk(s.ask),
  };
});

/** Ältere Form ({ provider: "demo", model }) und fehlende Anbieter ergänzen. */
function migrateAsk(old: Partial<Settings["ask"]> | undefined): Settings["ask"] {
  const known = Object.keys(defaults.ask.configs) as AskProvider[];
  const provider = old?.provider && known.includes(old.provider) ? old.provider : defaults.ask.provider;
  const configs = { ...defaults.ask.configs };
  for (const p of known) configs[p] = { ...defaults.ask.configs[p], ...old?.configs?.[p] };
  return { provider, configs };
}

export function updateAsk(provider: AskProvider, patch: Partial<AskProviderConfig>) {
  settings.set((s) => ({ ...s, ask: { ...s.ask, configs: { ...s.ask.configs, [provider]: { ...s.ask.configs[provider], ...patch } } } }));
}

export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
  settings.set((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
}
