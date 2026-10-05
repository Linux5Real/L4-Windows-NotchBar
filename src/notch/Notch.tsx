import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { GearSix, PushPin, Selection } from "@phosphor-icons/react";
import { content, springs } from "../design/motion";
import { useNowPlaying } from "../platform/media";
import { isNative, keyboardFocus, onNativeBlur, onNativeHover, onShortcut, onTrayOpen, setHitRect } from "../platform/native";
import { PrivacyDots } from "../features/privacy/PrivacyDots";
import { FOCUS_CLICKS, focusMode, setFocusMode } from "./focus";
import { useDragToMove } from "./drag";
import { LiveSlot, useLiveActivity } from "./live";
import { DOCK_HEIGHT, HEADER_HEIGHT, geometry, openGeometry, type NotchGeometry } from "./geometry";
import { HeaderButton, headerSlot } from "./header";
import { sizeOverride } from "./size";
import { NotchShape } from "./NotchShape";
import { drop } from "../platform/drop";
import { settings } from "../settings/store";
import { nav, navigate } from "./nav";
import { update } from "../lib/update";
import { findTab, settingsTab, tabs, type NotchTab } from "./tabs";
import { holdOpen, pinned, togglePin, useNotchState, type NotchStatus } from "./useNotchState";
import { t } from "../i18n";

/** War die Notch höchstens so lange zu, öffnet sie wieder beim zuletzt genutzten Tool. */
const RESUME_MS = 60_000;

export function Notch() {
  const { status, open, close, dismiss, toggle, onPointerEnter, onPointerLeave } = useNotchState();
  const focus = focusMode.use();
  const toolSettings = settings.use().tools;
  const visible = toolSettings.filter((t) => t.enabled).map((t) => findTab(t.id)).filter((t): t is NotchTab => !!t);
  const { tabId } = nav.use();
  // Ausgeblendetes Tool aktiv (z. B. gerade deaktiviert) → erstes sichtbares.
  const tab = tabId === settingsTab.id ? settingsTab : (visible.find((t) => t.id === tabId) ?? visible[0] ?? tabs[0]);
  const np = useNowPlaying();
  const live = useLiveActivity();

  // Wie bei der Dynamic Island: Öffnen springt zum Tool der laufenden Aktivität —
  // aber nur nach einer Pause. Kurz zu (Schlüssel kopieren, Datei holen) → man landet
  // wieder dort, wo man war, z. B. in den Einstellungen.
  // Layout-Effect läuft vor dem Zeichnen → kein Frame mit der alten Tab-Größe.
  const prevStatus = useRef(status);
  const closedAt = useRef(0);
  // Ziel-Tool aus dem Tray (Eintrag für die Einstellungen) hat Vorrang vor der Live-Aktivität.
  const trayTab = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (status === "open" && prevStatus.current !== "open") {
      const resumed = Date.now() - closedAt.current < RESUME_MS;
      if (trayTab.current) navigate(trayTab.current);
      else if (!resumed && live.id && visible.some((t) => t.id === live.id)) navigate(live.id);
      trayTab.current = null;
    }
    if (status !== "open" && prevStatus.current === "open") closedAt.current = Date.now();
    prevStatus.current = status;
  });

  useQuickDrop(status, open, dismiss);

  const override = sizeOverride.use();
  const size = override?.tabId === tab.id ? override : tab.size;
  const shape = shapeFor(status, live.id, size);
  const sticky = useStickyHitZone(status, size.h);
  const transition = useTransitionFor(status, shape);

  // Klick außerhalb schließt (im Browser die Fake-Desktopfläche, in Tauri das Fenster-Blur).
  const hitRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!hitRef.current?.contains(e.target as Node)) dismiss();
    };
    window.addEventListener("pointerdown", onDown);
    const offBlur = onNativeBlur(dismiss);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      offBlur();
    };
  }, [dismiss]);

  useNativeBridge(hitRef, onPointerEnter, onPointerLeave);
  const drag = useDragToMove(status);

  // Fokus-Modus an → Notch zu, kein Hover mehr.
  useEffect(() => {
    if (focus) close();
  }, [focus, close]);

  // Drei schnelle Klicks schalten den Fokus-Modus (im Browser auch wieder aus; nativ zählt Rust).
  const onClick = (e: React.MouseEvent) => {
    if (drag.moved()) return;
    if (e.detail >= FOCUS_CLICKS && !isInteractive(e.target)) return setFocusMode(!focus);
    if (!focus && status !== "open") open();
  };

  // Tastenkürzel: öffnen holt den Fokus (Esc, Tippen), schließen gibt ihn zurück.
  useEffect(() => onShortcut(() => toggle() === "open" && keyboardFocus(true)), [toggle]);
  useEffect(
    () =>
      onTrayOpen((tab) => {
        // Nur merken, wenn sie gerade aufgeht — sonst bliebe es fürs nächste Öffnen hängen.
        trayTab.current = status === "open" ? null : tab;
        if (tab) navigate(tab);
        open();
        keyboardFocus(true);
      }),
    [open, status],
  );
  useEffect(() => {
    if (status === "closed") keyboardFocus(false);
  }, [status]);

  // 1–9 wechselt das Tool, solange offen und nicht getippt wird.
  useEffect(() => {
    if (status !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const tab = visible[Number(e.key) - 1];
      if (tab) navigate(tab.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, visible]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center transition-opacity duration-200"
      // Im Browser verschiebt die Notch sich im Fenster; nativ wandert das ganze Fenster (display.rs).
      style={{ ["--accent" as string]: np?.accent, opacity: focus ? 0.5 : 1, transform: isNative ? undefined : `translateX(${drag.offset}px)` }}
    >
      {/* Trefferzone: größer als die sichtbare Form (Fitts) und bündig mit der Oberkante. */}
      <div
        ref={hitRef}
        data-notch-hit
        className="pointer-events-auto px-4 pb-3"
        style={{ minHeight: sticky.minHeight, cursor: drag.dragging ? "grabbing" : undefined }}
        onPointerMove={sticky.onPointerMove}
        onPointerDown={focus ? undefined : drag.onPointerDown}
        // In Tauri kommt Hover aus dem Rust-Poll (useNativeBridge), nicht aus dem DOM.
        onPointerEnter={isNative || focus ? undefined : onPointerEnter}
        onPointerLeave={isNative || focus ? undefined : onPointerLeave}
        onClick={onClick}
      >
        <NotchShape geometry={shape} transition={transition} elevated={status === "open"}>
          <LiveSlot id={status === "open" ? null : live.id} />
          <PrivacyDots />

          <AnimatePresence>
            {status === "open" && (
              <motion.div
                key="open"
                className="absolute top-0 left-1/2 flex flex-col"
                style={{ width: size.w, height: size.h, marginLeft: -size.w / 2, transformOrigin: "50% 0" }}
                initial={{ opacity: 0, transform: "translateY(-6px) scale(0.96)", filter: "blur(6px)" }}
                animate={{ opacity: 1, transform: "translateY(0px) scale(1)", filter: "blur(0px)", transition: content.enter }}
                exit={{ opacity: 0, transform: "translateY(-4px) scale(0.98)", filter: "blur(4px)", transition: content.exit }}
              >
                <Header title={t(tab.label)} onDragStart={drag.onPointerDown} />
                <div className="relative min-h-0 flex-1 overflow-clip">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={tab.id}
                      className="absolute inset-0"
                      initial={{ opacity: 0, filter: "blur(4px)" }}
                      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
                      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
                    >
                      <tab.View />
                    </motion.div>
                  </AnimatePresence>
                </div>
                <Dock tabs={visible} activeId={tab.id} />
              </motion.div>
            )}
          </AnimatePresence>
        </NotchShape>
      </div>
    </div>
  );
}

/** Kopfzeile: Titel des Tools links, Aktionen + Pinnadel rechts. Die Mitte (Kamera) bleibt frei. */
function Header({ title, onDragStart }: { title: string; onDragStart: (e: React.PointerEvent) => void }) {
  const isPinned = pinned.use();
  return (
    // Freie Fläche der Kopfzeile = Griff zum Verschieben.
    <div data-drag-handle onPointerDown={onDragStart} className="flex shrink-0 items-center justify-between gap-3 pr-3 pl-5" style={{ height: HEADER_HEIGHT + 4 }}>
      <div className="relative min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.h2
            key={title}
            className="truncate text-title font-semibold"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            {title}
          </motion.h2>
        </AnimatePresence>
      </div>
      <div className="flex items-center gap-1">
        {/* Tools rendern hier per <HeaderActions> (src/notch/header.tsx). Grid stapelt alte und neue beim Wechsel. */}
        <div ref={(el) => headerSlot.set(el)} className="grid" />
        <HeaderButton label={t("Fokus-Modus (3× klicken zum Beenden)")} onClick={() => setFocusMode(true)}>
          <Selection size={14} weight="bold" />
        </HeaderButton>
        <HeaderButton label={isPinned ? t("Lösen") : t("Offen halten")} active={isPinned} onClick={togglePin}>
          <PushPin size={14} weight={isPinned ? "fill" : "bold"} />
        </HeaderButton>
      </div>
    </div>
  );
}

/** Tool-Leiste unten (wie OmniNotch). Zahnrad am Ende schaltet zwischen Einstellungen und dem letzten Tool. */
function Dock({ tabs, activeId }: { tabs: NotchTab[]; activeId: string }) {
  const lastTool = useRef(tabs[0]?.id);
  if (activeId !== settingsTab.id) lastTool.current = activeId;
  const inSettings = activeId === settingsTab.id;
  const updateReady = update.use().phase === "available";

  return (
    <div className="flex shrink-0 items-start justify-center gap-0.5 px-4 pt-1" style={{ height: DOCK_HEIGHT }}>
      {tabs.map((tab) => (
        <DockButton key={tab.id} label={t(tab.label)} icon={tab.icon} active={tab.id === activeId} onClick={() => navigate(tab.id)} />
      ))}
      <span aria-hidden className="mx-1.5 mt-2 h-4 w-px bg-separator" />
      <DockButton
        label={t(settingsTab.label)}
        icon={GearSix}
        active={inSettings}
        badge={updateReady}
        // Punkt am Zahnrad = Update bereit → direkt zum Abschnitt springen.
        onClick={() => (inSettings ? navigate(lastTool.current ?? tabs[0].id) : navigate(settingsTab.id, updateReady ? "updates" : null))}
      />
    </div>
  );
}

function DockButton(props: { label: string; icon: NotchTab["icon"]; active: boolean; onClick: () => void; badge?: boolean }) {
  const I = props.icon;
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={`pressable relative flex h-8 w-8 items-center justify-center rounded-[10px] ${
        props.active ? "text-label" : "text-label-3 hover:text-label-2"
      }`}
    >
      {props.active && <motion.span layoutId="dock-pill" className="absolute inset-0 rounded-[10px] bg-fill-2" transition={springs.snappy} />}
      <I size={16} weight={props.active ? "fill" : "bold"} className="relative" />
      {/* Hinweis-Punkt (z. B. Update verfügbar) oben rechts am Symbol. */}
      <AnimatePresence>
        {props.badge && (
          <motion.span
            className="absolute top-1 right-1 size-[7px] rounded-full bg-link ring-2 ring-notch"
            initial={{ opacity: 0, transform: "scale(0.9)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.9)" }}
            transition={springs.snappy}
          />
        )}
      </AnimatePresence>
    </button>
  );
}

/**
 * Mit dem Dock unten wandert es bei einem kürzeren Tool nach oben — die Maus stünde
 * plötzlich außerhalb und die Notch ginge zu. Deshalb schrumpft die Trefferzone erst
 * mit, sobald die Maus wieder über der Form ist (oder die Notch zugeht).
 * Gilt auch nativ: Rust bekommt das Rechteck dieser Zone gemeldet.
 */
function useStickyHitZone(status: NotchStatus, height: number) {
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
  const prev = useRef(height);
  useLayoutEffect(() => {
    if (status !== "open") setMinHeight(undefined);
    else if (height < prev.current) {
      const from = prev.current + HIT_PAD_BOTTOM;
      setMinHeight((m) => Math.max(m ?? 0, from));
    }
    prev.current = height;
  }, [status, height]);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (minHeight === undefined) return;
    const shapeBottom = e.currentTarget.getBoundingClientRect().top + height;
    if (e.clientY < shapeBottom) setMinHeight(undefined);
  };
  return { minHeight, onPointerMove };
}

/** pb-3 der Trefferzone. */
const HIT_PAD_BOTTOM = 12;

function shapeFor(status: NotchStatus, live: string | null, size: { w: number; h: number }): NotchGeometry {
  if (status === "open") return openGeometry(size.w, size.h);
  const base = live === "system" ? geometry.gaming : live ? geometry.live : geometry.closed;
  if (status === "peek") {
    // Hover-Bestätigung relativ zur aktuellen Breite, damit sie auch im Live-Zustand passt.
    const bump = geometry.peek.w - geometry.closed.w;
    return { ...geometry.peek, w: base.w + bump };
  }
  return base;
}

/** Wählt die Spring passend zum Übergang (Öffnen ≠ Schließen ≠ Morphen). */
function useTransitionFor(status: NotchStatus, shape: NotchGeometry): Transition {
  const prev = useRef(status);
  const key = `${shape.w}x${shape.h}`;
  const prevKey = useRef(key);

  let t: Transition;
  if (status === "open") t = prev.current === "open" ? springs.morph : springs.open;
  else if (status === "peek") t = springs.peek;
  else t = prev.current === "open" ? springs.close : springs.morph;

  // Nur übernehmen, wenn sich die Form tatsächlich ändert — sonst bleibt die laufende Spring.
  const stable = useRef(t);
  if (prevKey.current !== key) stable.current = t;

  useEffect(() => {
    prev.current = status;
    prevKey.current = key;
  });

  return stable.current;
}

/**
 * Quick Drop: Dateien über die Notch ziehen → sie öffnet sich bei Ablage oder Converter
 * (je nachdem, was zuletzt genutzt wurde).
 * Abgebrochenes Ziehen schließt sie wieder, wenn sie nur dafür aufging.
 */
function useQuickDrop(status: NotchStatus, open: () => void, dismiss: () => void) {
  const openedByDrag = useRef(false);
  // Drop landet im zuletzt genutzten Datei-Tool (Ablage oder Converter).
  const fileTool = useRef<"shelf" | "convert">("convert");
  useEffect(
    () =>
      nav.subscribe(() => {
        const id = nav.get().tabId;
        if (id === "shelf" || id === "convert") fileTool.current = id;
      }),
    [],
  );
  const holding = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(
    () =>
      drop.subscribe(() => {
        const { dragging, dropped } = drop.get();
        if (dragging && !holding.current) {
          holding.current = true;
          holdOpen(true);
          if (statusRef.current !== "open") {
            openedByDrag.current = true;
            open();
          }
          const current = nav.get().tabId;
          if (current !== "shelf" && current !== "convert") navigate(fileTool.current);
        } else if (!dragging && holding.current) {
          // Ziehen vorbei: fallen gelassen → offen lassen, abgebrochen → wieder zu.
          holding.current = false;
          holdOpen(false);
          if (!dropped && openedByDrag.current) dismiss();
          openedByDrag.current = false;
        }
      }),
    [open, dismiss],
  );
}

/**
 * Verbindung zur nativen Hülle: meldet die Trefferzone an Rust (Klick-Durchlass),
 * empfängt Hover aus dem Rust-Poll und hält das Fenster klickbar, solange getippt wird.
 */
function useNativeBridge(
  hitRef: RefObject<HTMLDivElement | null>,
  onEnter: () => void,
  onLeave: () => void,
) {
  useEffect(() => {
    const el = hitRef.current;
    if (!isNative || !el) return;

    // Die Form wird per Spring in der Größe animiert → ResizeObserver feuert pro Frame mit.
    const report = () => {
      const r = el.getBoundingClientRect();
      setHitRect({ x: r.x, y: r.y, w: r.width, h: r.height });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();

    const offHover = onNativeHover((inside) => (inside ? onEnter() : onLeave()));
    // Textfeld fokussiert → festhalten (klickbar, kein Wegklappen), bis der Fokus geht.
    let typing = false;
    const onFocusIn = (e: FocusEvent) => {
      if (isTextField(e.target) && !typing) holdOpen((typing = true));
    };
    const onFocusOut = (e: FocusEvent) => {
      if (typing && !isTextField(e.relatedTarget)) holdOpen((typing = false));
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);

    return () => {
      ro.disconnect();
      offHover();
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      if (typing) holdOpen(false);
    };
  }, [hitRef, onEnter, onLeave]);
}

function isInteractive(el: EventTarget | null): boolean {
  return el instanceof Element && !!el.closest("button, input, textarea, a, [role=slider]");
}

function isTextField(el: EventTarget | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
