import { useEffect, useState } from "react";
import { Keyboard, X } from "@phosphor-icons/react";
import { t } from "../../i18n";

/*
 * Records a global hotkey: click the chip, then press the combination.
 * Ctrl or Alt is required (Shift alone would fire while typing).
 * Escape cancels, Backspace/Delete clears.
 */

/** Keys we accept beyond letters, digits and F-keys; the names are what the parser expects. */
const namedKeys: Record<string, string> = {
  " ": "Space",
  Enter: "Enter",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ",": "Comma",
  ".": "Period",
  "-": "Minus",
  "=": "Equal",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
};

function keyToken(e: KeyboardEvent): string | null {
  if (namedKeys[e.key]) return namedKeys[e.key];
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase();
  if (/^[0-9]$/.test(e.key)) return e.key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(e.key)) return e.key.toUpperCase();
  return null;
}

/** The accelerator for the combination, or null while only modifiers are down. */
function acceleratorOf(e: KeyboardEvent): string | null {
  if (!e.ctrlKey && !e.altKey) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const key = keyToken(e);
  return key ? [...mods, key].join("+") : null;
}

/** "Ctrl+Alt+1" → "Strg+Alt+1" (German UI). */
export function prettyShortcut(accelerator: string): string {
  const names: Record<string, string> = {
    Ctrl: t("Strg"),
    Shift: t("Umschalt"),
    Super: t("Windows"),
    Space: t("Leertaste"),
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
  };
  return accelerator
    .split("+")
    .map((part) => names[part] ?? part)
    .join("+");
}

export function ShortcutField({
  value,
  reserved,
  onChange,
}: {
  value?: string;
  /** The main notch toggle; never assignable to a tool. */
  reserved?: string;
  onChange: (accelerator: string | undefined) => void;
}) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        onChange(undefined);
        setRecording(false);
        return;
      }
      // Swallow the modifier-only presses; wait for the real key.
      if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) return;
      const accelerator = acceleratorOf(e);
      if (!accelerator || accelerator === reserved) return;
      onChange(accelerator);
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, reserved, onChange]);

  return (
    <div className="flex shrink-0 items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
      <button
        aria-label={t("Tastenkürzel")}
        title={t("Öffnet die Notch direkt in diesem Tool")}
        onClick={() => setRecording((r) => !r)}
        className={`pressable pressable-fill flex h-6 items-center gap-1.5 rounded-full px-2 text-caption ${
          recording ? "bg-fill-3 text-label" : value ? "bg-fill-2 text-label-2" : "text-label-4 hover:text-label-2"
        }`}
      >
        <Keyboard size={12} weight="bold" className={recording ? "animate-pulse" : ""} />
        {recording ? t("Tasten drücken …") : value ? prettyShortcut(value) : t("Kürzel")}
      </button>
      {value && !recording && (
        <button
          aria-label={t("Entfernen")}
          title={t("Entfernen")}
          onClick={() => onChange(undefined)}
          className="pressable pressable-fill flex size-5 items-center justify-center rounded-full text-label-4 hover:text-label-2"
        >
          <X size={11} weight="bold" />
        </button>
      )}
    </div>
  );
}
