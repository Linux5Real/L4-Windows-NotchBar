import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { GearSix, PushPin, Selection } from "@phosphor-icons/react";
import { content, springs } from "../design/motion";
import { useNowPlaying } from "../platform/media";
import { isNative, keyboardFocus, onNativeBlur, onNativeHover, onShortcut, onTrayOpen, setHitRect, setMemoryLow } from "../platform/native";
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
import { useUnseen } from "../lib/changelog";
import { nav, navigate } from "./nav";
import { update } from "../lib/update";
import { findTab, settingsTab, tabs, type NotchTab } from "./tabs";
import { holdOpen, pinned, togglePin, useNotchState, type NotchStatus } from "./useNotchState";
import { t } from "../i18n";
import { timer } from "../features/timer/store";

/** If the notch was closed at most this long, it reopens on the last used tool. */
const RESUME_MS = 60_000;
/** Closed this long → lower WebView2's memory target. */
const MEMORY_LOW_AFTER_MS = 20_000;

export function Notch() {
  const { status, open, close, dismiss, toggle, onPointerEnter, onPointerLeave } = useNotchState();
  const focus = focusMode.use();
  const { tools: toolSettings, display: displaySettings } = settings.use();
  // Focus mode as a line: no live activity, no dots, only the thin strip at the edge.
  const line = focus && displaySettings.focusStyle === "line";
  // Line as the normal closed look: hover and click work as usual, but nothing shows
  // while closed. Only a finished timer opens it into the notch, until dismissed.
  const timerDone = timer.use().finished;
  const idleLine = !focus && displaySettings.idleStyle === "line";
  const alert = idleLine && timerDone;
  const visible = toolSettings.filter((t) => t.enabled).map((t) => findTab(t.id)).filter((t): t is NotchTab => !!t);
  const { tabId } = nav.use();
  // Hidden tool active (e.g. just disabled) → first visible one.
  const tab = tabId === settingsTab.id ? settingsTab : (visible.find((t) => t.id === tabId) ?? visible[0] ?? tabs[0]);
  const np = useNowPlaying();
  const live = useLiveActivity();

  // Like the Dynamic Island: opening jumps to the running activity's tool,
  // but only after a pause. Closed briefly (copying a key, grabbing a file) → you
  // land where you were, e.g. in the settings.
  // Layout effect runs before paint → no frame with the old tab size.
  const prevStatus = useRef(status);
  const closedAt = useRef(0);
  // A target tool from the tray (settings entry) takes priority over the live activity.
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
  // Live activity shown in the closed notch (the idle line only lets the timer alarm through).
  const shownLive = line ? null : idleLine ? (alert ? "timer" : null) : live.id;
  const shape = line || (idleLine && status === "closed" && !alert) ? geometry.line : shapeFor(status, shownLive, size);
  const sticky = useStickyHitZone(status, size.h);
  const transition = useTransitionFor(status, shape);

  // Click outside closes (in the browser the fake desktop, in Tauri the window blur).
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

  // Focus mode on → notch closes, no more hover.
  useEffect(() => {
    if (focus) close();
  }, [focus, close]);

  // Three quick clicks toggle focus mode (in the browser also off; natively Rust counts).
  const onClick = (e: React.MouseEvent) => {
    if (drag.moved()) return;
    if (e.detail >= FOCUS_CLICKS && !isInteractive(e.target)) return setFocusMode(!focus);
    if (!focus && status !== "open") open();
  };

  // Shortcut: opening takes focus (Esc, typing), closing gives it back.
  useEffect(() => onShortcut(() => toggle() === "open" && keyboardFocus(true)), [toggle]);
  useEffect(
    () =>
      onTrayOpen((tab) => {
        // Only remember it while opening, otherwise it would stick for the next open.
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

  // Closed for a while → WebView2 may trim memory; back to normal on the first touch
  // (peek), so the hover delay covers paging it back in before the notch opens.
  useEffect(() => {
    if (status !== "closed") return setMemoryLow(false);
    const id = window.setTimeout(() => setMemoryLow(true), MEMORY_LOW_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  // 1–9 switches tools while open and not typing.
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
      // In the browser the notch moves inside the window; natively the whole window moves (display.rs).
      style={{ ["--accent" as string]: np?.accent, opacity: focus && !line ? 0.5 : 1, transform: isNative ? undefined : `translateX(${drag.offset}px)` }}
    >
      {/* Hit zone: bigger than the visible shape (Fitts) and flush with the top edge. */}
      <div
        ref={hitRef}
        data-notch-hit
        // The line is meant to stay out of the way: only a hair of extra hit zone, so
        // the cursor has to be on it (the normal notch gets the generous Fitts margin).
        className={`pointer-events-auto ${shape === geometry.line ? "px-1 pb-1" : "px-4 pb-3"}`}
        style={{ minHeight: sticky.minHeight, cursor: drag.dragging ? "grabbing" : undefined }}
        onPointerMove={sticky.onPointerMove}
        onPointerDown={focus ? undefined : drag.onPointerDown}
        // In Tauri, hover comes from the Rust poll (useNativeBridge), not the DOM.
        onPointerEnter={isNative || focus ? undefined : onPointerEnter}
        onPointerLeave={isNative || focus ? undefined : onPointerLeave}
        onClick={onClick}
      >
        <NotchShape geometry={shape} transition={transition} elevated={status === "open"}>
          <LiveSlot id={status === "open" ? null : shownLive} />
          {!line && !idleLine && <PrivacyDots />}

          <AnimatePresence>
            {status === "open" && (
              <motion.div
                key="open"
                className="absolute top-0 left-1/2 flex flex-col"
                style={{ width: size.w, height: size.h, marginLeft: -size.w / 2 }}
                // No scale here: scaling re-rasterizes the small dock icons at shifting subpixels every frame, which reads as jitter (issue #3).
                initial={{ opacity: 0, transform: "translateY(-6px)", filter: "blur(6px)" }}
                animate={{ opacity: 1, transform: "translateY(0px)", filter: "blur(0px)", transition: content.enter }}
                exit={{ opacity: 0, transform: "translateY(-4px)", filter: "blur(4px)", transition: content.exit }}
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

/** Header: tool title on the left, actions + pin on the right. The middle (camera) stays free. */
function Header({ title, onDragStart }: { title: string; onDragStart: (e: React.PointerEvent) => void }) {
  const isPinned = pinned.use();
  return (
    // Empty header space = drag handle.
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
        {/* Tools render here via <HeaderActions> (src/notch/header.tsx). The grid stacks old and new during a switch. */}
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

/** Tool bar at the bottom (like OmniNotch). The gear at the end toggles between settings and the last tool. */
function Dock({ tabs, activeId }: { tabs: NotchTab[]; activeId: string }) {
  const lastTool = useRef(tabs[0]?.id);
  if (activeId !== settingsTab.id) lastTool.current = activeId;
  const inSettings = activeId === settingsTab.id;
  const updateReady = update.use().phase === "available";
  // Dot on the gear = update ready or unseen changes → jump straight to that section.
  const unseen = useUnseen().length > 0;
  const badge = updateReady || unseen;

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
        badge={badge}
        onClick={() => (inSettings ? navigate(lastTool.current ?? tabs[0].id) : navigate(settingsTab.id, badge ? "updates" : null))}
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
      {/* Badge dot (e.g. update available) at the icon's top right. */}
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
 * With the dock at the bottom, a shorter tool moves it up, so the cursor would
 * suddenly be outside and the notch would close. So the hit zone only shrinks
 * once the cursor is back over the shape (or the notch closes).
 * Applies natively too: Rust gets this zone's rectangle.
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

/** pb-3 of the hit zone. */
const HIT_PAD_BOTTOM = 12;

function shapeFor(status: NotchStatus, live: string | null, size: { w: number; h: number }): NotchGeometry {
  if (status === "open") return openGeometry(size.w, size.h);
  const base = live === "system" ? geometry.gaming : live ? geometry.live : geometry.closed;
  if (status === "peek") {
    // Hover nudge relative to the current width so it also fits the live state.
    const bump = geometry.peek.w - geometry.closed.w;
    return { ...geometry.peek, w: base.w + bump };
  }
  return base;
}

/** Picks the spring for the transition (open ≠ close ≠ morph). */
function useTransitionFor(status: NotchStatus, shape: NotchGeometry): Transition {
  const prev = useRef(status);
  const key = `${shape.w}x${shape.h}`;
  const prevKey = useRef(key);

  let t: Transition;
  if (status === "open") t = prev.current === "open" ? springs.morph : springs.open;
  else if (status === "peek") t = springs.peek;
  else t = prev.current === "open" ? springs.close : springs.morph;

  // Only switch when the shape actually changes, otherwise the running spring continues.
  const stable = useRef(t);
  if (prevKey.current !== key) stable.current = t;

  useEffect(() => {
    prev.current = status;
    prevKey.current = key;
  });

  return stable.current;
}

/**
 * Quick drop: drag files over the notch and it opens on Shelf or Converter
 * (whichever was used last).
 * A cancelled drag closes it again if it only opened for that.
 */
function useQuickDrop(status: NotchStatus, open: () => void, dismiss: () => void) {
  const openedByDrag = useRef(false);
  // Drops land in the last used file tool (Shelf or Converter).
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
          // Drag over: dropped → stay open, cancelled → close again.
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
 * Link to the native shell: reports the hit zone to Rust (click-through), receives
 * hover from the Rust poll and keeps the window clickable while typing.
 */
function useNativeBridge(
  hitRef: RefObject<HTMLDivElement | null>,
  onEnter: () => void,
  onLeave: () => void,
) {
  useEffect(() => {
    const el = hitRef.current;
    if (!isNative || !el) return;

    // The shape's size is animated by a spring → ResizeObserver fires every frame.
    const report = () => {
      const r = el.getBoundingClientRect();
      setHitRect({ x: r.x, y: r.y, w: r.width, h: r.height });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();

    const offHover = onNativeHover((inside) => (inside ? onEnter() : onLeave()));
    // Text field focused → hold (clickable, no collapse) until focus leaves.
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
