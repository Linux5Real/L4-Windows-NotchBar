import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, Reorder } from "motion/react";
import {
  ArrowsInLineHorizontal,
  CheckCircle,
  DotsSixVertical,
  Keyboard,
  LockSimple,
  Monitor,
  Play,
  Plugs,
  SlidersHorizontal,
  Sparkle,
  SquaresFour,
  Stop,
  Timer,
  type Icon,
} from "@phosphor-icons/react";
import { content, fade, springs } from "../../design/motion";
import { alarmSounds, playAlarm, stopAlarm, type AlarmDuration } from "../../lib/sound";
import { nav } from "../../notch/nav";
import { tabs } from "../../notch/tabs";
import { autostart, display, secrets, unlockFps, type MonitorInfo, type SecretName, type UsageId } from "../../platform/services";
import { settings, updateAsk, updateSettings, type AskProvider } from "../../settings/store";
import { BrandLogo, brandName } from "../../ui/brands";
import { Button, Group, Row, Segmented, Select, Slider, Switch, TextField } from "../../ui/controls";
import { effortLevels, providerInfo } from "../ask/providers";
import { discordState, reconnectDiscord } from "../discord/store";
import { fps } from "../system/gaming";
import { PlaceSearch } from "../weather/WeatherView";
import { detectPlace } from "../weather/store";
import { focusMode, setFocusMode } from "../../notch/focus";
import { checkForUpdate, installUpdate, update } from "../../lib/update";
import { t, tBackend } from "../../i18n";

type PageId = "general" | "display" | "tools" | "timer" | "ai" | "accounts";

const pages: { id: PageId; label: string; icon: Icon }[] = [
  { id: "general", label: "Allgemein", icon: SlidersHorizontal },
  { id: "display", label: "Darstellung", icon: Monitor },
  { id: "tools", label: "Tools", icon: SquaresFour },
  { id: "timer", label: "Timer", icon: Timer },
  { id: "ai", label: "AI", icon: Sparkle },
  { id: "accounts", label: "Verbindungen", icon: Plugs },
];

/** Deep-Links anderer Tools (`navigate("settings", "<abschnitt>")`) → Seite, auf der der Abschnitt liegt. */
const sectionPage: Record<string, PageId> = {
  weather: "general",
  updates: "general",
  display: "display",
  alarm: "timer",
  ask: "ai",
  usage: "ai",
  discord: "accounts",
  trading: "accounts",
};

/** Zuletzt offene Seite überlebt Schließen/Öffnen der Notch (Komponente wird neu gebaut). */
let savedPage: PageId = "general";

/**
 * Einstellungen wie in macOS: links die Kategorien, rechts nur deren Inhalt.
 * Andere Tools springen per `navigate("settings", "<abschnitt>")` direkt zu ihrem Abschnitt.
 */
export function SettingsView() {
  const { section } = nav.use();
  const [page, setPageState] = useState<PageId>(() => (section && sectionPage[section]) || savedPage);
  const scroller = useRef<HTMLDivElement>(null);
  const setPage = (p: PageId) => {
    savedPage = p;
    setPageState(p);
  };

  useEffect(() => {
    if (!section || !sectionPage[section]) return;
    setPage(sectionPage[section]);
    // Erst nach dem Seitenwechsel existiert der Abschnitt.
    const id = window.setTimeout(
      () => scroller.current?.querySelector<HTMLElement>(`#settings-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      120,
    );
    return () => window.clearTimeout(id);
  }, [section]);

  return (
    <div className="flex h-full gap-3 px-4 pt-1 pb-3">
      <nav className="flex w-[136px] shrink-0 flex-col gap-0.5">
        {pages.map((p) => {
          const active = p.id === page;
          return (
            <button
              key={p.id}
              onClick={() => setPage(p.id)}
              aria-current={active ? "page" : undefined}
              className={`pressable relative flex h-8 items-center gap-2 rounded-[8px] px-2.5 text-left text-body transition-colors duration-150 ${
                active ? "text-label" : "text-label-3 hover:text-label-2"
              }`}
            >
              {active && <motion.span layoutId="settings-page" className="absolute inset-0 rounded-[8px] bg-fill-2" transition={springs.snappy} />}
              <p.icon size={15} weight={active ? "fill" : "bold"} className="relative shrink-0" />
              <span className="relative truncate">{t(p.label)}</span>
            </button>
          );
        })}
      </nav>
      {/* Ref am stabilen Container: popLayout reicht Refs nicht ans Kind durch. */}
      <div ref={scroller} className="relative min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={page}
            className="absolute inset-0 flex flex-col gap-4 overflow-y-auto pb-6 [scrollbar-width:none]"
            style={{ maskImage: "linear-gradient(180deg, #000 calc(100% - 28px), transparent)" }}
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            {page === "general" && (
              <>
                <General />
                <Weather />
                <Updates />
              </>
            )}
            {page === "display" && <Display />}
            {page === "tools" && <Tools />}
            {page === "timer" && <Alarm />}
            {page === "ai" && (
              <>
                <Ask />
                <UsageProviders />
                <KeysNote />
              </>
            )}
            {page === "accounts" && (
              <>
                <Discord />
                <Trading />
                <KeysNote />
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Version, Update-Suche und Installation auf Klick. Geladen wird nie ungefragt. */
function Updates() {
  const auto = settings.use().updates.auto;
  const u = update.use();
  const busy = u.phase === "checking" || u.phase === "downloading";
  const status = {
    idle: undefined,
    checking: t("Suche …"),
    current: t("Du hast die neueste Version"),
    available: t("Neue Version gefunden"),
    downloading: t("Wird geladen … {n} %", { n: Math.round(u.progress * 100) }),
    error: t("Prüfung fehlgeschlagen – später erneut versuchen"),
  }[u.phase];

  return (
    <Group title={t("Updates")} id="settings-updates">
      <Row label={t("Version {v}", { v: u.current ?? "–" })} hint={status}>
        <Button disabled={busy} onClick={() => void checkForUpdate()}>
          {t("Jetzt suchen")}
        </Button>
      </Row>
      <AnimatePresence initial={false}>
        {(u.phase === "available" || u.phase === "downloading") && u.version && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <Row label={t("Version {v} verfügbar", { v: u.version })} hint={t("Lädt, installiert und startet neu")}>
              {u.phase === "downloading" ? (
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-fill-2">
                  <div className="h-full origin-left rounded-full bg-label transition-transform duration-150 ease-linear" style={{ transform: `scaleX(${u.progress})` }} />
                </div>
              ) : (
                <Button primary onClick={() => void installUpdate()}>
                  {t("Jetzt aktualisieren")}
                </Button>
              )}
            </Row>
          </motion.div>
        )}
      </AnimatePresence>
      <Row label={t("Automatisch suchen")} hint={t("Einmal täglich, anonym bei GitHub – ohne deine Daten")}>
        <Switch label={t("Automatisch suchen")} checked={auto} onChange={(on) => updateSettings({ updates: { auto: on } })} />
      </Row>
    </Group>
  );
}

function KeysNote() {
  return (
    <div className="flex items-start gap-1.5 px-3 pb-1 text-caption text-label-4">
      <LockSimple size={11} weight="bold" className="mt-0.5 shrink-0" />
      {t("Schlüssel liegen in der Windows-Anmeldeinformationsverwaltung. Alles bleibt auf diesem PC.")}
    </div>
  );
}

function Ask() {
  const s = settings.use();
  return (
    <Group title={t("AI-Chat")} id="settings-ask">
      <Row label={t("Anbieter")}>
        <Segmented<AskProvider>
          id="ask-provider"
          size="sm"
          value={s.ask.provider}
          onChange={(provider) => updateSettings({ ask: { ...s.ask, provider } })}
          options={(Object.keys(providerInfo) as AskProvider[]).map((p) => ({ value: p, label: providerInfo[p].label }))}
        />
      </Row>
      {s.ask.provider === "custom" && (
        <Row label={t("Base-URL")} hint={t("OpenAI-kompatibel, endet meist auf /v1")}>
          <TextField
            value={s.ask.configs.custom.baseUrl}
            onChange={(baseUrl) => updateAsk("custom", { baseUrl: baseUrl.trim() })}
            placeholder="https://…/v1"
            width="w-52"
          />
        </Row>
      )}
      <SecretRow name={`ai.${s.ask.provider}` as SecretName} label={t("API-Schlüssel")} />
      <Row label={t("Modell")} hint={s.ask.provider === "openrouter" ? t("Modell-ID von openrouter.ai/models") : undefined}>
        <TextField
          value={s.ask.configs[s.ask.provider].model}
          onChange={(model) => updateAsk(s.ask.provider, { model: model.trim() })}
          placeholder={t(providerInfo[s.ask.provider].modelHint)}
          width="w-52"
        />
      </Row>
      <Row label="Effort" hint={t("Wie gründlich das Modell nachdenkt")}>
        <Segmented
          id="ask-effort-settings"
          size="sm"
          value={s.ask.configs[s.ask.provider].effort}
          onChange={(effort) => updateAsk(s.ask.provider, { effort })}
          options={effortLevels}
        />
      </Row>
    </Group>
  );
}

function Trading() {
  const s = settings.use();
  return (
    <Group title="Trading 212" id="settings-trading">
      <Row label={t("Konto")}>
        <Segmented
          id="t212-env"
          size="sm"
          value={s.trading.env}
          onChange={(env) => updateSettings({ trading: { env } })}
          options={[
            { value: "live", label: t("Echt") },
            { value: "demo", label: "Demo" },
          ]}
        />
      </Row>
      <SecretRow name="t212.key" label={t("API-Schlüssel")} />
      <SecretRow name="t212.secret" label={t("API-Secret")} hint={t("Nur einmal sichtbar beim Erstellen")} />
      <div className="px-3 py-2 text-caption text-label-3">
        {t("In Trading 212: Einstellungen → API (Beta) → Schlüssel erstellen. Rechte: Konto-Daten und Portfolio – mehr ist nicht nötig, die Notch liest nur.")}
      </div>
    </Group>
  );
}

function General() {
  const s = settings.use();
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => {
    void autostart.get().then(setAuto);
  }, []);

  return (
    <Group>
      <Row label={t("Sprache")}>
        <Segmented
          id="language"
          size="sm"
          value={s.language}
          onChange={(language) => updateSettings({ language })}
          options={[
            { value: "de", label: "Deutsch" },
            { value: "en", label: "English" },
          ]}
        />
      </Row>
      <Row label={t("Öffnen")}>
        <Segmented
          id="open-mode"
          size="sm"
          value={s.openMode}
          onChange={(openMode) => updateSettings({ openMode })}
          options={[
            { value: "hover", label: t("Hover") },
            { value: "click", label: t("Klick") },
          ]}
        />
      </Row>
      <AnimatePresence initial={false}>
        {s.openMode === "hover" && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <Row label={t("Hover-Verzögerung")}>
              <Segmented
                id="hover-delay"
                size="sm"
                value={s.hoverDelay}
                onChange={(hoverDelay) => updateSettings({ hoverDelay })}
                options={[
                  { value: "fast", label: t("Schnell") },
                  { value: "normal", label: t("Normal") },
                  { value: "patient", label: t("Geduldig") },
                ]}
              />
            </Row>
          </motion.div>
        )}
      </AnimatePresence>
      <Row label={t("Mit Windows starten")}>
        {auto !== null && (
          <Switch
            label={t("Mit Windows starten")}
            checked={auto}
            onChange={(v) => {
              setAuto(v);
              void autostart.set(v);
            }}
          />
        )}
      </Row>
      <Row label={t("Tastenkürzel")} hint={t("Öffnet und schließt die Notch von überall")}>
        <span className="flex items-center gap-1 text-caption text-label-2">
          <Keyboard size={13} weight="bold" className="text-label-3" />
          {["Strg", "Alt", "Leertaste"].map((k) => (
            <kbd key={k} className="rounded-[5px] bg-fill-2 px-1.5 py-0.5 font-sans text-caption">{t(k)}</kbd>
          ))}
        </span>
      </Row>
    </Group>
  );
}

/** Wo und wann die Notch erscheint. */
function Display() {
  const s = settings.use();
  const d = s.display;
  const focus = focusMode.use();
  const fpsError = fps.use().error;
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    void display.monitors().then(setMonitors);
  }, []);
  const label = (m: MonitorInfo, i: number) => `${m.primary ? t("Hauptbildschirm") : t("Bildschirm {n}", { n: i + 1 })} · ${m.width}×${m.height}`;

  return (
    <Group id="settings-display">
      <Row label={t("Sichtbarkeit")} hint={d.visibility === "always" ? t("Bleibt über jedem Fenster, auch im Vollbild") : t("Verschwindet bei Spielen, Videos und Präsentationen")}>
        <Segmented
          id="display-visibility"
          size="sm"
          value={d.visibility}
          onChange={(visibility) => updateSettings((cur) => ({ display: { ...cur.display, visibility } }))}
          options={[
            { value: "always", label: t("Immer oben") },
            { value: "hide-fullscreen", label: t("Vollbild: aus") },
          ]}
        />
      </Row>
      {monitors.length > 1 && (
        <Row label={t("Monitor")}>
          <Select
            width="w-52"
            value={d.monitor ?? monitors.find((m) => m.primary)?.name ?? monitors[0].name}
            onChange={(name) => updateSettings((cur) => ({ display: { ...cur.display, monitor: monitors.find((m) => m.name === name)?.primary ? null : name } }))}
            options={monitors.map((m, i) => ({ value: m.name, label: label(m, i) }))}
          />
        </Row>
      )}
      {d.offset !== 0 && (
        <Row label={t("Position")} hint={t("Notch an der Kopfzeile oder geschlossen ziehen, um sie zu verschieben")}>
          <Button onClick={() => updateSettings((cur) => ({ display: { ...cur.display, offset: 0 } }))}>
            <span className="flex items-center gap-1.5">
              <ArrowsInLineHorizontal size={13} weight="bold" /> {t("Zur Mitte")}
            </span>
          </Button>
        </Row>
      )}
      <Row label={t("Fokus-Modus")} hint={t("Halb durchsichtig, Klicks gehen durch. 3× schnell auf die Notch klicken schaltet um.")}>
        <Switch label={t("Fokus-Modus")} checked={focus} onChange={setFocusMode} />
      </Row>
      <Row
        label={t("Gaming-Modus")}
        hint={t("FPS und Auslastung in der geschlossenen Notch")}
      >
        <Segmented
          id="gaming-mode"
          size="sm"
          value={s.gaming.mode}
          onChange={(mode) => updateSettings({ gaming: { mode } })}
          options={[
            { value: "off", label: t("Aus") },
            { value: "fullscreen", label: t("Bei Vollbild") },
            { value: "on", label: t("Immer") },
          ]}
        />
      </Row>
      {fpsError === "no-admin" && <FpsUnlockRow />}
      <Row label={t("Aufnahme-Punkte")} hint={t("Grün: Mikrofon/Kamera aktiv · Rot: Bildschirm wird aufgenommen")}>
        <Switch label={t("Aufnahme-Punkte")} checked={s.privacyDots} onChange={(privacyDots) => updateSettings({ privacyDots })} />
      </Row>
    </Group>
  );
}

const discordStatus: Record<string, string> = {
  off: "Aus – Tool „Discord“ einschalten",
  "no-config": "Client-ID und Secret fehlen",
  "no-client": "Discord läuft nicht",
  connecting: "Verbinde …",
  authorizing: "In Discord bestätigen",
  ready: "Verbunden",
  error: "Fehler",
};

/** Discord-Anruf: eigene Anwendung im Developer-Portal (nur so gibt Discord Sprach-Rechte frei). */
function Discord() {
  const s = settings.use();
  const state = discordState.use();
  const [id, setId] = useState(s.discord.clientId);
  const save = () => updateSettings({ discord: { clientId: id.trim() } });
  return (
    <Group title="Discord" id="settings-discord">
      <Row label={t("Status")} hint={state.error ? tBackend(state.error) : undefined}>
        <span className={`text-caption ${state.status === "ready" ? "text-green" : "text-label-2"}`}>{t(discordStatus[state.status] ?? state.status)}</span>
      </Row>
      <Row label={t("Client-ID")}>
        <div className="flex items-center gap-1.5">
          <TextField value={id} onChange={setId} onSubmit={save} placeholder="123456789012345678" width="w-40" />
          {id.trim() !== s.discord.clientId && <Button onClick={save}>{t("Sichern")}</Button>}
        </div>
      </Row>
      <SecretRow name="discord.secret" label={t("Client-Secret")} onSaved={reconnectDiscord} />
      <div className="px-3 py-2 text-caption text-label-3">
        {t("discord.com/developers → New Application → OAuth2: Client-ID und Client-Secret kopieren. Keine Weiterleitung (Redirect) eintragen. Beim ersten Verbinden fragt Discord einmal nach.")}
      </div>
    </Group>
  );
}

const durations: { value: string; label: string }[] = [
  { value: "0", label: "1×" },
  { value: "5", label: "5 s" },
  { value: "15", label: "15 s" },
  { value: "30", label: "30 s" },
  { value: "-1", label: "Bis Stopp" },
];

/** Timer-Alarm: Ton, Lautstärke, Dauer — mit Probehören. */
function Alarm() {
  const a = settings.use().alarm;
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const set = (patch: Partial<typeof a>) => updateSettings((cur) => ({ alarm: { ...cur.alarm, ...patch } }));

  const preview = (next = a) => {
    window.clearTimeout(timer.current);
    playAlarm(next.sound, next.volume, 0);
    setPreviewing(true);
    timer.current = window.setTimeout(() => setPreviewing(false), 2500);
  };
  useEffect(() => () => stopAlarm(), []);

  return (
    <Group id="settings-alarm">
      <Row label={t("Alarm-Ton")}>
        <div className="flex items-center gap-1.5">
          <button
            aria-label={previewing ? t("Stopp") : t("Probehören")}
            title={previewing ? t("Stopp") : t("Probehören")}
            onClick={() => {
              if (!previewing) return preview();
              stopAlarm();
              setPreviewing(false);
            }}
            className="pressable pressable-fill flex size-7 items-center justify-center rounded-full bg-fill-2 text-label"
          >
            {previewing ? <Stop size={11} weight="fill" /> : <Play size={11} weight="fill" />}
          </button>
          <Select
            width="w-36"
            value={a.sound}
            onChange={(sound) => {
              set({ sound });
              preview({ ...a, sound });
            }}
            options={alarmSounds.map((o) => ({ ...o, label: t(o.label) }))}
          />
        </div>
      </Row>
      <Row label={t("Lautstärke")}>
        <div className="flex w-52 items-center gap-2">
          <Slider label={t("Lautstärke")} value={Math.round(a.volume * 100)} min={5} max={100} step={5} onChange={(v) => set({ volume: v / 100 })} />
          <span className="tabular w-8 text-right text-caption text-label-2">{Math.round(a.volume * 100)}</span>
        </div>
      </Row>
      <Row label={t("Dauer")} hint={t("Wie lange der Alarm klingelt")}>
        <Segmented id="alarm-duration" size="sm" value={String(a.duration)} onChange={(v) => set({ duration: Number(v) as AlarmDuration })} options={durations.map((o) => ({ ...o, label: t(o.label) }))} />
      </Row>
    </Group>
  );
}

/** AI-Nutzung: welche Abos angezeigt werden. Daten kommen aus den angemeldeten Apps. */
const usageSources: { id: UsageId | "grok"; hint: string; available: boolean }[] = [
  { id: "claude", hint: "Über die Anmeldung von Claude Code", available: true },
  { id: "codex", hint: "Über die Anmeldung der Codex CLI", available: true },
  { id: "gemini", hint: "Über die Anmeldung der Gemini CLI", available: true },
  { id: "cursor", hint: "Über die Anmeldung der Cursor-App", available: true },
  { id: "grok", hint: "xAI bietet keinen Abruf der Abo-Limits", available: false },
];

function UsageProviders() {
  const usage = settings.use().usage;
  return (
    <Group title={t("AI-Nutzung")} id="settings-usage">
      {usageSources.map((src) => (
        <Row
          key={src.id}
          label={
            <span className={`flex items-center gap-2 ${src.available ? "" : "text-label-3"}`}>
              <BrandLogo id={src.id} size={14} /> {brandName[src.id]}
            </span>
          }
          hint={t(src.hint)}
        >
          {src.available ? (
            <Switch
              label={brandName[src.id]}
              checked={usage[src.id as UsageId]}
              onChange={(on) => updateSettings((cur) => ({ usage: { ...cur.usage, [src.id]: on } }))}
            />
          ) : (
            <span className="text-caption text-label-4">{t("Nicht verfügbar")}</span>
          )}
        </Row>
      ))}
    </Group>
  );
}

/** FPS ohne Admin: einmal freischalten statt die Notch jedes Mal als Administrator zu starten. */
function FpsUnlockRow() {
  const [state, setState] = useState<"idle" | "busy" | "relogin" | "cancelled" | "failed">("idle");
  const hint = {
    idle: t("Einmalige Windows-Abfrage, danach nie wieder Administratorrechte"),
    busy: t("Bitte die Windows-Abfrage bestätigen …"),
    relogin: t("Fertig – einmal ab- und wieder anmelden, dann laufen die FPS"),
    cancelled: t("Abgebrochen"),
    failed: t("Hat nicht geklappt – Notch einmal als Administrator starten"),
  }[state];
  return (
    <Row label={t("FPS freischalten")} hint={hint}>
      {state === "relogin" ? (
        <CheckCircle size={18} weight="fill" className="text-green" />
      ) : (
        <Button
          disabled={state === "busy"}
          onClick={() => {
            setState("busy");
            void unlockFps().then(setState);
          }}
        >
          {t("Freischalten")}
        </Button>
      )}
    </Row>
  );
}

/** Wetter-Ort: automatisch per IP oder fest gewählt — direkt hier, ohne ins Wetter-Tool zu springen. */
function Weather() {
  const w = settings.use().weather;
  const [searching, setSearching] = useState(false);
  return (
    <Group title={t("Wetter")} id="settings-weather">
      <Row label={t("Standort")} hint={w?.auto ? t("Ungefähr, aus deiner IP-Adresse") : undefined}>
        <Segmented<"auto" | "manual">
          id="weather-mode"
          size="sm"
          value={!w || w.auto ? "auto" : "manual"}
          onChange={(m) => {
            if (m === "auto") {
              setSearching(false);
              void detectPlace(true);
            } else setSearching(true);
          }}
          options={[
            { value: "auto", label: t("Automatisch") },
            { value: "manual", label: t("Manuell") },
          ]}
        />
      </Row>
      <Row label={t("Ort")}>
        <Button onClick={() => setSearching((v) => !v)}>{w?.name ?? t("Wird erkannt …")}</Button>
      </Row>
      <AnimatePresence initial={false}>
        {searching && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <div className="p-2">
              <PlaceSearch compact canCancel onDone={() => setSearching(false)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Group>
  );
}

/** Tools ein-/ausblenden und per Ziehen sortieren. Mindestens eins bleibt an. */
function Tools() {
  const s = settings.use();
  const enabledCount = s.tools.filter((x) => x.enabled).length;
  const [dragging, setDragging] = useState<string | null>(null);

  return (
    <Group>
      <Reorder.Group
        as="div"
        axis="y"
        values={s.tools.map((x) => x.id)}
        onReorder={(ids: string[]) => updateSettings((cur) => ({ tools: ids.map((id) => cur.tools.find((x) => x.id === id)!) }))}
        className="divide-y divide-separator"
      >
        {s.tools.map((tool) => {
          const tab = tabs.find((x) => x.id === tool.id);
          if (!tab) return null;
          return (
            <Reorder.Item
              key={tool.id}
              value={tool.id}
              as="div"
              transition={springs.snappy}
              onDragStart={() => setDragging(tool.id)}
              onDragEnd={() => setDragging(null)}
              whileDrag={{ scale: 1.02 }}
              className={`group relative flex h-9 cursor-grab items-center gap-2.5 px-3 active:cursor-grabbing ${
                dragging === tool.id ? "z-10 rounded-[10px] bg-elevated shadow-[0_6px_18px_rgb(0_0_0/0.45)]" : ""
              }`}
            >
              <DotsSixVertical size={13} weight="bold" className="-ml-1 text-label-4 transition-colors group-hover:text-label-3" />
              <tab.icon size={15} weight="bold" className={tool.enabled ? "text-label-2" : "text-label-4"} />
              <span className={`flex-1 text-body select-none ${tool.enabled ? "text-label" : "text-label-3"}`}>{t(tab.label)}</span>
              <div onPointerDown={(e) => e.stopPropagation()}>
                <Switch
                  label={t(tab.label)}
                  checked={tool.enabled}
                  onChange={(enabled) => {
                    if (!enabled && enabledCount <= 1) return;
                    updateSettings((cur) => ({ tools: cur.tools.map((x) => (x.id === tool.id ? { ...x, enabled } : x)) }));
                  }}
                />
              </div>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
    </Group>
  );
}

/**
 * Feld für einen Schlüssel. Gespeicherte Werte werden nie zurückgelesen —
 * nur "gespeichert ✓". Neu eintippen überschreibt, leer speichern löscht.
 */
function SecretRow({ name, label, hint, onSaved }: { name: SecretName; label: string; hint?: string; onSaved?: () => void }) {
  const [stored, setStored] = useState(false);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue("");
    void secrets.has(name).then(setStored);
  }, [name]);

  const save = async () => {
    await secrets.set(name, value);
    setStored(!!value.trim());
    setValue("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
    onSaved?.();
  };

  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-1.5">
        <AnimatePresence>
          {(saved || (stored && !value)) && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
              <CheckCircle size={14} weight="fill" className="text-green" />
            </motion.span>
          )}
        </AnimatePresence>
        <TextField secret value={value} onChange={setValue} onSubmit={() => void save()} placeholder={stored ? t("Gespeichert") : t("Einfügen")} width="w-40" />
        {(value || stored) && (
          <Button onClick={() => void save()} disabled={!value && !stored}>
            {value ? t("Sichern") : t("Löschen")}
          </Button>
        )}
      </div>
    </Row>
  );
}
