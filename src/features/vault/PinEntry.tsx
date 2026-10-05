import { useEffect, useRef, useState } from "react";
import { motion, useAnimate } from "motion/react";
import { LockSimple, ShieldCheck } from "@phosphor-icons/react";
import { content, shake, springs } from "../../design/motion";
import { keyboardFocus } from "../../platform/native";
import { t } from "../../i18n";

/**
 * Four-dot PIN entry. Digits come from a hidden field (keyboard, numpad), so the
 * dots stay the only visible element. Submits by itself after the 4th digit.
 *
 * `onSubmit` resolves with null (done), an error text (shake, clear) or a lockout.
 * `lockedFor` > 0 disables input and counts down.
 */
export type PinResult = null | string | { lockedFor: number };

export function PinEntry(props: {
  title: string;
  hint?: string;
  setup?: boolean;
  lockedFor?: number;
  onSubmit: (pin: string) => Promise<PinResult>;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(props.lockedFor ?? 0);
  const input = useRef<HTMLInputElement>(null);
  const [dots, animate] = useAnimate();

  useEffect(() => setWait(props.lockedFor ?? 0), [props.lockedFor]);
  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  // The PIN appears after a click (show, copy), so taking keyboard focus is expected.
  useEffect(() => {
    keyboardFocus(true);
    input.current?.focus({ preventScroll: true });
  }, [props.title]);

  const submit = async (value: string) => {
    setBusy(true);
    const err = await props.onSubmit(value);
    setBusy(false);
    if (err === null) return;
    setPin("");
    if (typeof err === "object") {
      setError(null);
      setWait(err.lockedFor);
    } else setError(err);
    void animate(dots.current, { transform: shake.keyframes }, shake.transition);
    input.current?.focus({ preventScroll: true });
  };

  const locked = wait > 0;
  const Icon = props.setup ? ShieldCheck : LockSimple;
  return (
    <motion.div
      className={`flex h-full flex-col items-center justify-center text-center ${props.compact ? "gap-2 py-3" : "gap-2.5 pb-2"}`}
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
      onPointerDown={(e) => {
        // Clicking anywhere keeps the focus in the hidden field.
        if (!(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          input.current?.focus({ preventScroll: true });
        }
      }}
    >
      {!props.compact && (
        <div className="flex size-10 items-center justify-center rounded-full bg-fill-2 text-label-2">
          <Icon size={18} weight="bold" />
        </div>
      )}
      <div>
        <div className="text-body font-medium text-label">{props.title}</div>
        {props.hint && <div className="mt-0.5 max-w-72 text-caption text-label-3">{props.hint}</div>}
      </div>

      <div ref={dots} className="flex gap-3.5 py-1.5" aria-hidden>
        {[0, 1, 2, 3].map((i) => {
          const filled = i < pin.length;
          return (
            <span key={i} className="relative size-3">
              <span className={`absolute inset-0 rounded-full border-[1.5px] ${error && !filled ? "border-red/70" : "border-label-3"}`} />
              <motion.span
                className="absolute inset-0 rounded-full bg-label"
                initial={false}
                animate={{ opacity: filled ? 1 : 0, transform: filled ? "scale(1)" : "scale(0.6)" }}
                transition={springs.snappy}
              />
            </span>
          );
        })}
      </div>

      <input
        ref={input}
        value={pin}
        disabled={busy || locked}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-label={props.title}
        maxLength={4}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 4);
          setPin(v);
          setError(null);
          if (v.length === 4) void submit(v);
        }}
        onKeyDown={(e) => e.key === "Escape" && props.onCancel && (e.stopPropagation(), props.onCancel())}
        className="pointer-events-none absolute size-px opacity-0"
      />

      <div className="flex h-4 items-center text-caption">
        {locked ? (
          <span className="tabular text-orange">{t("Zu viele Versuche · wieder in {s}", { s: clock(wait) })}</span>
        ) : error ? (
          <span className="text-red">{error}</span>
        ) : (
          <span className="text-label-4">{t("Ziffern eintippen")}</span>
        )}
      </div>

      {props.onCancel && (
        <button onClick={props.onCancel} className="pressable text-caption text-label-3 hover:text-label-2">
          {t("Abbrechen")}
        </button>
      )}
    </motion.div>
  );
}

function clock(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Unlock error from Rust → what the PIN entry shows. */
export function unlockResult(code: string): PinResult {
  const [kind, n] = code.split(":");
  if (kind === "wrong") return Number(n) === 1 ? t("Falscher PIN · noch 1 Versuch") : t("Falscher PIN · noch {n} Versuche", { n });
  if (kind === "lockout") return { lockedFor: Number(n) };
  return t("Tresor nicht lesbar");
}
