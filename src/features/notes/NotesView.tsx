import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { content } from "../../design/motion";
import { createStore } from "../../lib/store";
import { t } from "../../i18n";

const note = createStore("", { persist: "note" });

/** Eine einzige Notiz, die sich selbst speichert — kein Speichern-Knopf. */
export function NotesView() {
  const value = note.use();
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-1">
      <textarea
        value={value}
        autoFocus
        placeholder={t("Schnelle Notiz …")}
        onChange={(e) => {
          note.set(e.target.value);
          setSaved(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setSaved(false), 1200);
        }}
        className="flex-1 resize-none rounded-[12px] bg-fill-1 px-3 py-2.5 text-body text-label outline-none [scrollbar-width:none] placeholder:text-label-4"
      />
      <div className="mt-1.5 flex h-4 items-center justify-between px-1 text-caption text-label-3">
        <span className="tabular">{words} {words === 1 ? t("Wort") : t("Wörter")}</span>
        <AnimatePresence>
          {saved && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: content.enter }}
              exit={{ opacity: 0, transition: { duration: 0.4 } }}
            >
              {t("Gespeichert")}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
