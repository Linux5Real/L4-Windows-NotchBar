import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { springs } from "../../design/motion";
import { t } from "../../i18n";
import { fetchPrivacy, type PrivacyState } from "../../platform/services";
import { settings } from "../../settings/store";
import { discordState } from "../discord/store";

const POLL_MS = 1500;

/**
 * Dots like on iPhone, right of the camera: green = mic or camera in use
 * (call, Discord), red = screen is being recorded or streamed.
 * While you talk in a Discord call, the green dot glows.
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
    // A bit right of the imagined camera in the middle, clear both closed and open.
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
