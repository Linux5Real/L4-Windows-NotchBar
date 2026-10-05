import type { ComponentType } from "react";
import {
  ArrowsLeftRight,
  CheckCircle,
  ClipboardText,
  CloudSun,
  Cpu,
  Gauge,
  GearSix,
  SquaresFour,
  MusicNotesSimple,
  NotePencil,
  Sparkle,
  Timer,
  Tray,
  type Icon,
} from "@phosphor-icons/react";
import { DepotIcon } from "../ui/icons";
import { DiscordLogo } from "../ui/brands";
import { OverviewView } from "../features/overview/OverviewView";
import { NowPlayingView } from "../features/now-playing/NowPlayingView";
import { TimerView } from "../features/timer/TimerView";
import { TodosView } from "../features/todos/TodosView";
import { NotesView } from "../features/notes/NotesView";
import { ClipboardView } from "../features/clipboard/ClipboardView";
import { ShelfView } from "../features/shelf/ShelfView";
import { AskView } from "../features/ask/AskView";
import { ConvertView } from "../features/convert/ConvertView";
import { TradingView } from "../features/trading/TradingView";
import { UsageView } from "../features/usage/UsageView";
import { WeatherView } from "../features/weather/WeatherView";
import { SystemView } from "../features/system/SystemView";
import { DiscordView } from "../features/discord/DiscordView";
import { SettingsView } from "../features/settings/SettingsView";

/**
 * Registry of all tools in the open notch. New tool = new entry here
 * + ID in `TOOL_IDS` (src/settings/store.ts). Visibility and order
 * are up to the user in the settings.
 *
 * `size` is the open notch size for this tool (incl. header and dock);
 * the shape morphs there on tab switch. Max. 740 × 540 (window size).
 * Tools can grow it at runtime: `requestSize` (src/notch/size.ts).
 */
export interface NotchTab {
  id: string;
  label: string;
  icon: Icon;
  size: { w: number; h: number };
  View: ComponentType;
}

export const tabs: NotchTab[] = [
  { id: "overview", label: "Übersicht", icon: SquaresFour, size: { w: 520, h: 252 }, View: OverviewView },
  { id: "media", label: "Wiedergabe", icon: MusicNotesSimple, size: { w: 520, h: 232 }, View: NowPlayingView },
  { id: "timer", label: "Timer", icon: Timer, size: { w: 520, h: 192 }, View: TimerView },
  { id: "todos", label: "To-Dos", icon: CheckCircle, size: { w: 520, h: 276 }, View: TodosView },
  { id: "notes", label: "Notiz", icon: NotePencil, size: { w: 520, h: 260 }, View: NotesView },
  { id: "clipboard", label: "Zwischenablage", icon: ClipboardText, size: { w: 600, h: 236 }, View: ClipboardView },
  { id: "shelf", label: "Ablage", icon: Tray, size: { w: 560, h: 236 }, View: ShelfView },
  { id: "ask", label: "Ask", icon: Sparkle, size: { w: 560, h: 440 }, View: AskView },
  { id: "convert", label: "Converter", icon: ArrowsLeftRight, size: { w: 520, h: 290 }, View: ConvertView },
  { id: "trading", label: "Depot", icon: DepotIcon, size: { w: 560, h: 380 }, View: TradingView },
  { id: "usage", label: "AI-Nutzung", icon: Gauge, size: { w: 600, h: 320 }, View: UsageView },
  { id: "weather", label: "Wetter", icon: CloudSun, size: { w: 520, h: 250 }, View: WeatherView },
  { id: "system", label: "Hardware", icon: Cpu, size: { w: 600, h: 248 }, View: SystemView },
  { id: "discord", label: "Discord", icon: DiscordLogo, size: { w: 520, h: 210 }, View: DiscordView },
];

/** Settings: reached via the gear, not in the tool bar. */
export const settingsTab: NotchTab = { id: "settings", label: "Einstellungen", icon: GearSix, size: { w: 660, h: 460 }, View: SettingsView };

export function findTab(id: string): NotchTab | undefined {
  return id === settingsTab.id ? settingsTab : tabs.find((t) => t.id === id);
}
