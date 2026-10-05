import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Fingerprint } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { vault, vaultError } from "../../platform/vault";
import { Button } from "../../ui/controls";
import { errorText } from "./errors";
import { t } from "../../i18n";

/**
 * Unlock with Windows Hello instead of the PIN. Starts the Windows dialog right
 * away; after a cancel it offers to try again.
 */
export function HelloPrompt(props: { onUnlocked: () => Promise<void>; onCancel: () => void; compact?: boolean }) {
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const unlock = async () => {
    setWaiting(true);
    setError(null);
    try {
      await vault.helloUnlock();
    } catch (e) {
      setWaiting(false);
      setError(errorText(vaultError(e)));
      return;
    }
    await props.onUnlocked();
  };

  useEffect(() => {
    // Once per prompt, also under StrictMode's double effects.
    if (started.current) return;
    started.current = true;
    void unlock();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div
      className={`flex h-full flex-col items-center justify-center text-center ${props.compact ? "gap-2 py-3" : "gap-2.5 pb-2"}`}
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      {!props.compact && (
        <div className={`flex size-10 items-center justify-center rounded-full bg-fill-2 ${waiting ? "animate-pulse text-label" : "text-label-2"}`}>
          <Fingerprint size={20} weight="bold" />
        </div>
      )}
      <div>
        <div className="text-body font-medium text-label">{t("Mit Windows Hello entsperren")}</div>
        <div className="mt-0.5 h-4 text-caption">
          {error ? <span className="text-red">{error}</span> : <span className="text-label-3">{t("Gesicht, Finger oder Windows-PIN bestätigen")}</span>}
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={props.onCancel}>{t("Abbrechen")}</Button>
        {!waiting && (
          <Button primary onClick={() => void unlock()}>
            {t("Erneut versuchen")}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
