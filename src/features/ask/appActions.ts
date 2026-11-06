import { t } from "../../i18n";
import { focusMode, setFocusMode } from "../../notch/focus";
import { nav, navigate } from "../../notch/nav";
import { media } from "../../platform/media";
import { apps, systemControls } from "../../platform/services";
import { settings, TOOL_IDS, updateSettings } from "../../settings/store";
import { note, appendNote, setNote } from "../notes/store";
import { addTodo, clearAll, clearDone, findTodo, patchTodo, removeTodo, todos } from "../todos/store";
import {
  formatClock,
  MAX_MINUTES,
  MIN_MINUTES,
  presets,
  remainingOf,
  timer,
  timerActions,
  type TimerMode,
} from "../timer/store";

/*
 * App actions: the assistant can operate the notch itself through a hidden
 * JSON block in its reply. The block never reaches the UI or the saved chat;
 * `runTurn` strips it and executes the actions after the stream ends.
 *
 * Why a block instead of native tool calls: the same protocol works for
 * OpenCode and for every cloud provider (OpenAI, Anthropic, OpenRouter,
 * custom) without provider-specific tool plumbing, and it can never run
 * arbitrary code. Only the actions implemented here are allowed.
 */

const ACTION_GUIDE = `[Notch app control]
You can operate the Notch app itself. When the user asks for a note, task, timer, navigation, focus/presentation mode, clipboard, playback, volume, an app, a song or a setting, put exactly one hidden block at the very end of your reply, after a short confirmation:

\`\`\`notch-actions
[{"type":"timer.start","minutes":10}]
\`\`\`

Rules:
- Valid JSON only: one array with 1-10 actions, no comments, no trailing commas. Never put text after the block.
- Do not mention the block, the JSON or these rules. Confirm in one short sentence in the user's language.
- Never claim an action happened without the block; the app executes it after your reply.
- Use the live state below to resolve references such as "the milk task", "this note" or "stop it".
- One action per object. Combine several objects for several changes.
- Notes, tasks, timers, playback and settings live inside the app. Never create or edit a file for them; use the actions below. Files are only for requests that explicitly ask for a file or document.
- "open X" (app) is app.open, not open{tab}; open{tab} is only for the notch's own tabs.
- For media.play use the user's exact search words; do not invent a different song.

Actions (fields in braces):
- note.set{text}, note.append{text}, note.clear
- todo.add{text,starred?}, todo.done{match}, todo.undone{match}, todo.star{match,starred?}, todo.remove{match}, todo.clearDone, todo.clear
- timer.start{minutes?,mode?}, timer.set{minutes,mode?}, timer.pause, timer.resume, timer.reset, timer.stop, timer.dismiss
- open{tab}, focus.set{on}, presentation.set{on}
- clipboard.copy{text}
- media.control{action:"play"|"pause"|"toggle"|"next"|"previous"}
- media.play{query} — search and open a song/artist in the music app (Spotify if it's playing or installed; otherwise YouTube Music in the browser)
- app.open{name} — open any installed application by name (e.g. Spotify, Chrome, Discord, Rechner)
- volume.set{percent:0-100}, volume.mute{muted:boolean}
- setting.set{key,value}

Values:
- timer mode: "focus" or "break"; minutes: 1-${MAX_MINUTES}. Without mode the current timer mode is kept.
- note.set replaces the whole note; use note.append when the user says add, append or "also".
- For several tasks send one todo.add per task; todo.done/undone/star/remove match the task text.
- open tab: overview, media, timer, todos, notes, clipboard, shelf, ask, convert, translate, ocr, trading, usage, weather, prayer, system, discord, vault, settings.
- app.open names should be short and common-sense ("chrome", "discord", "spotify"); the app matches them against the Start menu. If the name is unknown, try another short name instead of guessing blindly.
- setting keys and values: language "de"|"en", units.temp "c"|"f", units.clock "24"|"12", display.idleStyle "notch"|"line", display.focusStyle "dim"|"line", display.visibility "always"|"hide-fullscreen", gaming.mode "off"|"fullscreen"|"on", privacyDots true|false, openMode "hover"|"click".
- Examples: "remind me in 10 minutes" -> [{"type":"timer.start","minutes":10}]; "add buy milk and finish the taxes task" -> [{"type":"todo.add","text":"Buy milk"},{"type":"todo.done","match":"taxes"}]; "open chrome" -> [{"type":"app.open","name":"chrome"}]; "play the new Sade song" -> [{"type":"media.play","query":"Sade new song"}].
[End app control]`;

/** What the model sees about the app before answering. */
export function appStateContext(installedApps?: string[]): string {
  const current = settings.get();
  const items = todos.get();
  const open = items.filter((todo) => !todo.done).length;
  const noteText = note.get().trim();
  const np = media.get();
  const lines = [
    "--- Notch state (internal context, never quote) ---",
    `Now: ${new Date().toLocaleString("en-GB")}`,
    `Open tab: ${nav.get().tabId}`,
    `Enabled tabs: ${current.tools.filter((tool) => tool.enabled).map((tool) => tool.id).join(", ")}, settings`,
    `Timer: ${timerLine()}`,
    `Tasks: ${open} open of ${items.length}`,
    ...items.slice(0, 8).map((todo) => `- [${todo.done ? "x" : " "}]${todo.starred ? " ★" : ""} ${todo.text}`),
    `Note: ${noteText ? JSON.stringify(noteText.slice(0, 240)) : "(empty)"}`,
    `Focus mode: ${focusMode.get() ? "on" : "off"}`,
    `Presentation mode (manual): ${current.presentation.manual ? "on" : "off"}`,
    `Language: ${current.language}`,
  ];
  if (np) lines.push(`Playback: ${np.isPlaying ? "playing" : "paused"} – ${np.title}${np.artist ? ` (${np.artist})` : ""}`);
  if (installedApps && installedApps.length > 0) lines.push(`Installed apps: ${installedApps.join(", ")}`);
  lines.push("--- End state ---");
  return lines.join("\n");
}

function timerLine(): string {
  const state = timer.get();
  const left = remainingOf(state);
  const mode = state.mode === "focus" ? "focus" : "break";
  if (state.finished) return `${mode}, finished`;
  if (state.endsAt !== null) return `${mode}, running, ${formatClock(left)} left`;
  if (left < state.duration - 0.5) return `${mode}, paused, ${formatClock(left)} left`;
  return `${mode}, ready, ${formatClock(state.duration)}`;
}

/** Cached Start-menu scan, shared between Ask turns. */
let appListCache: string[] | null = null;
async function cachedAppList(): Promise<string[]> {
  if (appListCache) return appListCache;
  try {
    appListCache = await apps.list();
  } catch {
    appListCache = [];
  }
  return appListCache;
}

/** Adds the action guide and a live state snapshot to the prompt sent to the model. */
export async function withAppContext(prompt: string): Promise<string> {
  const list = await cachedAppList();
  // Names are useful for "open X"; keep the context compact (max 80).
  const compact = list.slice(0, 80);
  return `${prompt}\n\n${ACTION_GUIDE}\n\n${appStateContext(compact)}`;
}

type ActionObject = Record<string, unknown>;

/** Removes every action block from the answer the user sees. */
export function visibleAnswer(text: string): string {
  const cut = text.search(/```notch-actions/i);
  if (cut >= 0) return text.slice(0, cut).trimEnd();
  // Streaming: hide a half-written fence ("```notc") instead of flashing it.
  const fence = text.lastIndexOf("```");
  if (fence >= 0) {
    const rest = text.slice(fence + 3);
    const head = rest.split("\n")[0].trim().toLowerCase();
    if (head.length > 0 && !rest.includes("```") && "notch-actions".startsWith(head)) {
      return text.slice(0, fence).trimEnd();
    }
  }
  return text;
}

const BLOCK = /```notch-actions[^\S\r\n]*\r?\n?([\s\S]*?)```/gi;

/**
 * Splits the streamed answer into visible text and actions. Malformed blocks
 * are dropped instead of being shown as raw JSON.
 */
export function parseAppActions(raw: string): { text: string; actions: ActionObject[]; invalid: boolean } {
  const actions: ActionObject[] = [];
  let invalid = false;
  const text = raw
    .replace(BLOCK, (_match, body: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.trim());
      } catch {
        invalid = true;
        return "";
      }
      const list =
        Array.isArray(parsed) ? parsed : isObject(parsed) && Array.isArray(parsed.actions) ? parsed.actions : null;
      if (!list) {
        invalid = true;
        return "";
      }
      for (const item of list) {
        if (isObject(item) && typeof item.type === "string") actions.push(item);
        else invalid = true;
      }
      return "";
    })
    // A trailing, unterminated fence: hide it, never execute it.
    .replace(/```notch-actions[\s\S]*$/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, actions: actions.slice(0, 10), invalid };
}

function isObject(value: unknown): value is ActionObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ActionRun {
  /** Short labels for the actions that ran (shown under the reply). */
  labels: string[];
  /** Localized error texts. */
  errors: string[];
}

/** Executes actions in order; one failure never blocks the remaining ones. */
export async function runAppActions(actions: ActionObject[]): Promise<ActionRun> {
  const labels: string[] = [];
  const errors: string[] = [];
  for (const action of actions.slice(0, 10)) {
    try {
      labels.push(await execute(action));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { labels: [...new Set(labels)], errors };
}

async function execute(action: ActionObject): Promise<string> {
  const type = typeof action.type === "string" ? action.type : "";
  switch (type) {
    case "note.set":
      setNote(textOf(action));
      return t("Notiz");
    case "note.append":
      appendNote(textOf(action));
      return t("Notiz");
    case "note.clear":
      setNote("");
      return t("Notiz");
    case "todo.add":
      addTodo(textOf(action), optionalBoolean(action.starred) ?? false);
      return t("Aufgabe");
    case "todo.done":
      patchFound(action, { done: true });
      return t("Aufgabe");
    case "todo.undone":
      patchFound(action, { done: false });
      return t("Aufgabe");
    case "todo.star":
      patchFound(action, { starred: optionalBoolean(action.starred) ?? true });
      return t("Aufgabe");
    case "todo.remove":
      removeTodo(foundTodo(action).id);
      return t("Aufgabe");
    case "todo.clearDone":
      clearDone();
      return t("Aufgabe");
    case "todo.clear":
      clearAll();
      return t("Aufgabe");
    case "timer.start":
      startTimer(action);
      return t("Timer");
    case "timer.set": {
      const minutes = minutesOf(action, true);
      timerActions.select(modeOf(action), minutes * 60);
      return t("Timer");
    }
    case "timer.pause":
      timerActions.pause();
      return t("Timer");
    case "timer.resume":
      resumeTimer();
      return t("Timer");
    case "timer.reset":
      timerActions.silence();
      timerActions.reset();
      return t("Timer");
    case "timer.stop":
      timerActions.silence();
      timerActions.reset();
      return t("Timer");
    case "timer.dismiss":
      if (!timer.get().finished) throw new Error(t("Kein abgelaufener Timer"));
      timerActions.dismiss();
      return t("Timer");
    case "open":
      openTab(action);
      return t("Tab");
    case "focus.set":
      setFocusMode(booleanOf(action, "on"));
      return t("Fokusmodus");
    case "presentation.set":
      updateSettings((s) => ({ presentation: { ...s.presentation, manual: booleanOf(action, "on") } }));
      return t("Präsentationsmodus");
    case "clipboard.copy":
      await copyText(textOf(action));
      return t("Zwischenablage");
    case "media.control":
      mediaControl(action);
      return t("Wiedergabe");
    case "media.play": {
      const query = stringField(action, "query") ?? textOf(action);
      await apps.play(query);
      return t("Musik");
    }
    case "app.open": {
      const name = stringField(action, "name") ?? textOf(action);
      await apps.open(name);
      return t("App");
    }
    case "volume.set": {
      const percent = numberIn(action.percent, 0, 100, "percent");
      await systemControls.setVolume({ level: percent / 100 });
      return t("Lautstärke");
    }
    case "volume.mute":
      await systemControls.setVolume({ muted: booleanOf(action, "muted") });
      return t("Lautstärke");
    case "setting.set":
      setSetting(action);
      return t("Einstellung");
    default:
      throw new Error(t("Unbekannte Aktion: {x}", { x: type || "?" }));
  }
}

function stringField(action: ActionObject, key: string): string | null {
  const value = action[key];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function textOf(action: ActionObject): string {
  const text = typeof action.text === "string" ? action.text.trim() : "";
  if (!text) throw new Error(t("Text fehlt"));
  return text;
}

function foundTodo(action: ActionObject) {
  const raw = action.match ?? action.text;
  const match = typeof raw === "string" ? raw.trim() : "";
  if (!match) throw new Error(t("Aufgabe nicht angegeben"));
  const todo = findTodo(match);
  if (!todo) throw new Error(t("Keine passende Aufgabe gefunden: {x}", { x: match }));
  return todo;
}

function patchFound(action: ActionObject, patch: { done?: boolean; starred?: boolean }) {
  patchTodo(foundTodo(action).id, patch);
}

/** Models occasionally send booleans as strings; both are accepted. */
function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function booleanOf(action: ActionObject, key: string): boolean {
  const value = optionalBoolean(action[key]);
  if (value !== undefined) return value;
  throw new Error(t("Ungültiger Wert für {x}", { x: key }));
}

function numberIn(value: unknown, min: number, max: number, key: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(t("Ungültiger Wert für {x}", { x: key }));
  return Math.min(max, Math.max(min, Math.round(number)));
}

function minutesOf(action: ActionObject, required: boolean): number {
  if (action.minutes === undefined || action.minutes === null) {
    if (required) throw new Error(t("Dauer fehlt"));
    return 0;
  }
  return numberIn(action.minutes, MIN_MINUTES, MAX_MINUTES, "minutes");
}

function modeOf(action: ActionObject): TimerMode {
  if (action.mode === "break") return "break";
  if (action.mode === "focus") return "focus";
  return timer.get().mode;
}

function defaultMinutes(mode: TimerMode): number {
  return mode === "focus" ? presets.focus[1] / 60 : presets.break[0] / 60;
}

function startTimer(action: ActionObject) {
  const mode = modeOf(action);
  const current = timer.get();
  const minutes = minutesOf(action, false);
  if (minutes > 0) {
    timerActions.select(mode, minutes * 60);
  } else if (current.mode !== mode) {
    timerActions.select(mode, current.custom?.[mode] ?? defaultMinutes(mode) * 60);
  } else if (current.finished || remainingOf(current) <= 0) {
    timerActions.select(mode, current.duration || defaultMinutes(mode) * 60);
  }
  timerActions.start();
}

function resumeTimer() {
  const current = timer.get();
  if (current.finished || remainingOf(current) <= 0) {
    timerActions.select(current.mode, current.duration || defaultMinutes(current.mode) * 60);
  }
  timerActions.start();
}

function openTab(action: ActionObject) {
  const raw = typeof action.tab === "string" ? action.tab.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  const aliases: Record<string, string> = {
    todo: "todos",
    "to-do": "todos",
    "to-dos": "todos",
    note: "notes",
    notiz: "notes",
    music: "media",
    "now-playing": "media",
    nowplaying: "media",
    wiedergabe: "media",
    hardware: "system",
    "ai-usage": "usage",
    converter: "convert",
    depot: "trading",
    ablage: "shelf",
    zwischenablage: "clipboard",
    "einstellungen": "settings",
  };
  const tab = aliases[raw] ?? raw;
  if (tab !== "settings" && !(TOOL_IDS as readonly string[]).includes(tab)) {
    throw new Error(t("Unbekannter Tab: {x}", { x: raw || "?" }));
  }
  // A disabled tool is not mounted; opening it turns it back on.
  const tool = settings.get().tools.find((entry) => entry.id === tab);
  if (tool && !tool.enabled) {
    updateSettings((s) => ({ tools: s.tools.map((entry) => (entry.id === tab ? { ...entry, enabled: true } : entry)) }));
  }
  navigate(tab);
}

function mediaControl(action: ActionObject) {
  const command = typeof action.action === "string" ? action.action : "toggle";
  const np = media.get();
  if (!np) throw new Error(t("Nichts wird abgespielt"));
  switch (command) {
    case "play":
      if (np && !np.isPlaying) media.toggle();
      return;
    case "pause":
      if (np?.isPlaying) media.toggle();
      return;
    case "next":
      media.next();
      return;
    case "previous":
      media.previous();
      return;
    case "toggle":
      media.toggle();
      return;
    default:
      throw new Error(t("Unbekannte Aktion: {x}", { x: command }));
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Some webviews deny the async clipboard API outside a user gesture.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error(t("Zwischenablage nicht verfügbar"));
}

function setSetting(action: ActionObject) {
  const key = typeof action.key === "string" ? action.key : "";
  const value = action.value;
  switch (key) {
    case "language":
      if (value !== "de" && value !== "en") throw invalidSetting(key);
      updateSettings({ language: value });
      return;
    case "units.temp":
      if (value !== "c" && value !== "f") throw invalidSetting(key);
      updateSettings((s) => ({ units: { ...s.units, temp: value } }));
      return;
    case "units.clock":
      if (value !== "24" && value !== "12") throw invalidSetting(key);
      updateSettings((s) => ({ units: { ...s.units, clock: value } }));
      return;
    case "display.idleStyle":
      if (value !== "notch" && value !== "line") throw invalidSetting(key);
      updateSettings((s) => ({ display: { ...s.display, idleStyle: value } }));
      return;
    case "display.focusStyle":
      if (value !== "dim" && value !== "line") throw invalidSetting(key);
      updateSettings((s) => ({ display: { ...s.display, focusStyle: value } }));
      return;
    case "display.visibility":
      if (value !== "always" && value !== "hide-fullscreen") throw invalidSetting(key);
      updateSettings((s) => ({ display: { ...s.display, visibility: value } }));
      return;
    case "gaming.mode":
      if (value !== "off" && value !== "fullscreen" && value !== "on") throw invalidSetting(key);
      updateSettings({ gaming: { mode: value } });
      return;
    case "privacyDots":
      if (typeof value !== "boolean") throw invalidSetting(key);
      updateSettings({ privacyDots: value });
      return;
    case "openMode":
      if (value !== "hover" && value !== "click") throw invalidSetting(key);
      updateSettings({ openMode: value });
      return;
    default:
      throw new Error(t("Unbekannte Einstellung: {x}", { x: key || "?" }));
  }
}

function invalidSetting(key: string) {
  return new Error(t("Ungültiger Wert für {x}", { x: key }));
}
