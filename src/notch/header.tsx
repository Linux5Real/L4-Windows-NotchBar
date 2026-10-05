import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { content } from "../design/motion";
import { createStore } from "../lib/store";

/*
 * Aktionen eines Tools rechts in der Kopfzeile (neben der Pinnadel), z. B. "Leeren"
 * oder "Aktualisieren". Das Tool rendert <HeaderActions> irgendwo in seiner View;
 * der Inhalt landet per Portal in der Kopfzeile und blendet mit dem Tool ein und aus.
 */
export const headerSlot = createStore<HTMLElement | null>(null);

export function HeaderActions({ children }: { children: ReactNode }) {
  const slot = headerSlot.use();
  if (!slot) return null;
  return createPortal(
    <motion.div
      className="col-start-1 row-start-1 flex items-center justify-end gap-1"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      {children}
    </motion.div>,
    slot,
  );
}

/** Runder Icon-Knopf für die Kopfzeile — gleiche Größe wie die Pinnadel. */
export function HeaderButton(props: { label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`pressable pressable-fill flex size-7 items-center justify-center rounded-full disabled:opacity-30 ${
        props.active ? "bg-fill-3 text-label" : "text-label-3 hover:text-label-2"
      }`}
    >
      {props.children}
    </button>
  );
}
