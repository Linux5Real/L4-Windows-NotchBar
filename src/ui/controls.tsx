import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { CaretUpDown, Eye, EyeSlash, type Icon } from "@phosphor-icons/react";
import { popover, springs } from "../design/motion";
import { t } from "../i18n";

/*
 * Shared controls. Every tool uses these instead of its own variants, so sizes,
 * radii and motion are identical everywhere.
 */

/** Segmented control with a sliding pill. `id` must be unique per instance. */
export function Segmented<T extends string>(props: {
  id: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  const h = props.size === "sm" ? "h-5 px-2" : "h-6 px-3";
  return (
    <div className="flex shrink-0 rounded-full bg-fill-1 p-0.5">
      {props.options.map((o) => {
        const active = o.value === props.value;
        return (
          <button
            key={o.value}
            onClick={() => props.onChange(o.value)}
            className={`relative rounded-full text-caption font-medium transition-colors duration-150 ${h} ${
              active ? "text-label" : "text-label-3 hover:text-label-2"
            }`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${props.id}`}
                className="absolute inset-0 rounded-full bg-fill-3"
                transition={springs.snappy}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** iOS switch. Green like Apple's; the knob slides with a spring. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`pressable relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors duration-200 ${checked ? "bg-green" : "bg-fill-3"}`}
    >
      <motion.span
        className="absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow-sm"
        initial={false}
        animate={{
          transform: checked ? "translateX(12px)" : "translateX(0px)",
        }}
        transition={springs.snappy}
      />
    </button>
  );
}

/** Row in settings lists: label on the left, control on the right. */
export function Row({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 px-3 py-1.5">
      <div className="min-w-0">
        <div className="truncate text-body text-label">{label}</div>
        {hint && <div className="text-caption text-label-3">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Grouped list with fine separators (like iOS Settings). */
export function Group({
  title,
  children,
  id,
}: {
  title?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="scroll-mt-2">
      {title && (
        <h3 className="mb-1 px-3 text-caption font-medium tracking-wide text-label-3 uppercase">
          {title}
        </h3>
      )}
      <div className="divide-y divide-separator overflow-hidden rounded-[12px] bg-fill-1">
        {children}
      </div>
    </section>
  );
}

/** Single-line field. `secret` masks it and offers show/hide. */
export function TextField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
  onSubmit?: () => void;
  width?: string;
  /** Shows a secret from outside (e.g. right after generating a password). */
  revealed?: boolean;
  autoFocus?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (props.revealed !== undefined) setReveal(props.revealed);
  }, [props.revealed]);
  return (
    <div
      className={`flex h-7 items-center gap-1 rounded-[8px] bg-fill-2 px-2 ${props.width ?? "w-44"}`}
    >
      <input
        value={props.value}
        type={props.secret && !reveal ? "password" : "text"}
        spellCheck={false}
        autoComplete="off"
        placeholder={props.placeholder}
        ref={(el) => {
          if (props.autoFocus && el && !el.dataset.focused) {
            el.dataset.focused = "1";
            el.focus({ preventScroll: true });
          }
        }}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && props.onSubmit?.()}
        className="min-w-0 flex-1 bg-transparent text-footnote text-label outline-none placeholder:text-label-4"
      />
      {props.secret && props.value && (
        <button
          aria-label={reveal ? t("Verbergen") : t("Anzeigen")}
          onClick={() => setReveal((r) => !r)}
          className="text-label-3 hover:text-label-2"
        >
          {reveal ? (
            <EyeSlash size={13} weight="bold" />
          ) : (
            <Eye size={13} weight="bold" />
          )}
        </button>
      )}
    </div>
  );
}

/** Small text button (secondary) or filled (primary). */
export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  icon?: Icon;
}) {
  const I = props.icon;
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className={`pressable flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-footnote font-medium disabled:opacity-35 ${
        props.primary
          ? "bg-label text-black"
          : "pressable-fill bg-fill-2 text-label"
      }`}
    >
      {I && <I size={13} weight="bold" />}
      {props.children}
    </button>
  );
}

/** Fill level 0–100 with traffic-light color (green → orange → red). Only transform animates. */
export function Meter({
  percent,
  height = 6,
  color,
}: {
  percent: number;
  height?: number;
  color?: string;
}) {
  const p = Math.max(0, Math.min(100, percent));
  const tint =
    color ??
    (p >= 85
      ? "var(--color-red)"
      : p >= 60
        ? "var(--color-orange)"
        : "var(--color-green)");
  return (
    <div
      className="relative w-full overflow-hidden rounded-full bg-fill-2"
      style={{ height }}
    >
      <motion.div
        className="absolute inset-0 origin-left rounded-full"
        style={{ backgroundColor: tint }}
        initial={{ transform: "scaleX(0)" }}
        animate={{ transform: `scaleX(${p / 100})` }}
        transition={springs.morph}
      />
    </div>
  );
}

/** Empty state: calm, centered, one sentence, optionally an action. */
export function Empty(props: {
  icon?: Icon;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  const I = props.icon;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 pb-2 text-center">
      {I && <I size={22} weight="duotone" className="mb-1 text-label-3" />}
      <span className="text-body text-label-2">{props.title}</span>
      {props.text && (
        <span className="max-w-72 text-caption text-label-3">{props.text}</span>
      )}
      {props.action && <div className="mt-2">{props.action}</div>}
    </div>
  );
}

/** Slider. Drags via pointer capture; arrow keys ±step. */
export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const step = props.step ?? 1;
  const ratio = (props.value - props.min) / (props.max - props.min);
  const set = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const raw =
      props.min +
      Math.min(1, Math.max(0, (clientX - r.left) / r.width)) *
        (props.max - props.min);
    props.onChange(Math.round(raw / step) * step);
  };
  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label={props.label}
      aria-valuenow={props.value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      className="relative flex h-5 w-full cursor-pointer touch-none items-center outline-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        set(e.clientX);
      }}
      onPointerMove={(e) =>
        e.currentTarget.hasPointerCapture(e.pointerId) && set(e.clientX)
      }
      onKeyDown={(e) => {
        if (e.key === "ArrowRight")
          props.onChange(Math.min(props.max, props.value + step));
        if (e.key === "ArrowLeft")
          props.onChange(Math.max(props.min, props.value - step));
      }}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-fill-2">
        <div
          className="absolute inset-0 origin-left rounded-full bg-label-2"
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
      <span
        className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.5)]"
        style={{ left: `${ratio * 100}%` }}
      />
    </div>
  );
}

/** Compact select menu (instead of a native <select>, which looks foreign on Windows). */
/*
 * The menu is portaled into the notch's hit zone (`data-notch-hit`) so overflow
 * containers don't clip it while it still counts as "inside" (outside-click close,
 * hit rect). It opens toward the side with more room and stays inside the notch.
 */
const MENU_ROW = 28;
const MENU_MAX = 160;
const MENU_GAP = 4;
const MENU_EDGE = 8;

type MenuPos = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  up: boolean;
  maxHeight: number;
};

export function Select<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const measure = () => {
    const trigger = ref.current?.getBoundingClientRect();
    if (!trigger) return;
    const bounds = ref.current
      ?.closest("[data-notch-hit]")
      ?.getBoundingClientRect();
    const minY = (bounds?.top ?? 0) + MENU_EDGE;
    const maxY =
      Math.min(bounds?.bottom ?? window.innerHeight, window.innerHeight) -
      MENU_EDGE;
    const wanted = Math.min(MENU_MAX, props.options.length * MENU_ROW + 8);
    const below = maxY - trigger.bottom - MENU_GAP;
    const above = trigger.top - minY - MENU_GAP;
    const up = below < wanted && above > below;
    const room = up ? above : below;
    setPos({
      left: trigger.left,
      width: trigger.width,
      up,
      maxHeight: Math.max(MENU_ROW + 8, Math.min(wanted, room)),
      ...(up
        ? { bottom: window.innerHeight - trigger.top + MENU_GAP }
        : { top: trigger.bottom + MENU_GAP }),
    });
  };

  useLayoutEffect(() => {
    if (open) measure();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menu.current?.contains(t))
        setOpen(false);
    };
    const close = () => setOpen(false);
    // Scrolling the list behind moves the trigger → close; our own list doesn't.
    const onScroll = (e: Event) =>
      !menu.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const host = ref.current?.closest("[data-notch-hit]") ?? document.body;
  const current = props.options.find((o) => o.value === props.value);
  return (
    <div ref={ref} className={`relative ${props.width ?? "w-28"}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="pressable pressable-fill flex h-7 w-full items-center justify-between gap-1 rounded-[8px] bg-fill-2 px-2 text-footnote text-label"
      >
        <span className="truncate">{current?.label}</span>
        <CaretUpDown
          size={11}
          weight="bold"
          className="shrink-0 text-label-3"
        />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={menu}
              className="pointer-events-auto fixed z-[60] overflow-y-auto rounded-[10px] bg-elevated p-1 shadow-[0_10px_30px_rgb(0_0_0/0.6)] ring-1 ring-separator [scrollbar-width:none]"
              style={{
                left: pos.left,
                width: pos.width,
                top: pos.top,
                bottom: pos.bottom,
                maxHeight: pos.maxHeight,
                transformOrigin: pos.up ? "50% 100%" : "50% 0",
              }}
              initial={{
                opacity: 0,
                transform: `scale(0.96) translateY(${pos.up ? 2 : -2}px)`,
              }}
              animate={{
                opacity: 1,
                transform: "scale(1) translateY(0px)",
                transition: popover.enter,
              }}
              exit={{
                opacity: 0,
                transform: "scale(0.98)",
                transition: popover.exit,
              }}
            >
              {props.options.map((o) => (
                <button
                  key={o.value}
                  onClick={() => {
                    props.onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex h-7 w-full items-center rounded-[6px] px-2 text-left text-footnote hover:bg-fill-2 ${
                    o.value === props.value ? "text-label" : "text-label-2"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        host,
      )}
    </div>
  );
}

/** Calm loading placeholder (pulsing area instead of a spinner). */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-[8px] bg-fill-1 ${className}`} />
  );
}
