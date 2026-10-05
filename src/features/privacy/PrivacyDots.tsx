import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { springs } from "../../design/motion";
import { t } from "../../i18n";
import { fetchPrivacy, type PrivacyState } from "../../platform/services";
import { settings } from "../../settings/store";
import { discordState } from "../discord/store";

const POLL_MS = 1500;

/**
 * Punkte wie beim iPhone, rechts neben der Kamera: grün = Mikrofon oder Kamera in
 * Benutzung (Anruf, Discord), rot = Bildschirm wird aufgenommen bzw. gestreamt.
 * Spricht man im Discord-Anruf, glimmt der grüne Punkt.
 */
export function PrivacyDots() {
  const enabled = settings.use().privacyDots;
  const [p, setP] = useState<PrivacyState>({ mic: false, camera: false, screen: false });
  const call = discordState.use().call;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => void fetchPrivacy().then((next) => alive && setP(next));
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);

  const talk = p.mic || p.camera || (!!call && !call.mute);
  const dots = enabled ? [p.screen && "red", talk && "green"].filter((d): d is string => !!d) : [];

  return (
    // Ein Stück rechts der gedachten Kamera in der Mitte — geschlossen wie offen frei.
    <div className="pointer-events-none absolute top-0 left-1/2 ml-[24px] flex h-[30px] items-center gap-[5px]">
      <AnimatePresence>
        {dots.map((color) => (
          <motion.span
            key={color}
            className="privacy-dot size-[6px] rounded-full"
            title={color === "red" ? t("Bildschirm wird aufgenommen") : t("Mikrofon oder Kamera aktiv")}
            data-pulse={color === "green" && call?.speaking ? true : undefined}
            style={{ backgroundColor: `var(--color-${color})`, ["--dot" as string]: `var(--color-${color})` }}
            initial={{ opacity: 0, transform: "scale(0.9)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.9)" }}
            transition={springs.snappy}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
