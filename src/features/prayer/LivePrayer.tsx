import { motion } from "motion/react";
import { BellRinging, SpeakerSlash } from "@phosphor-icons/react";
import { content, pulse, springs } from "../../design/motion";
import { t } from "../../i18n";
import { adhanPlaying, ALERT_MS, stopAdhan, type PrayerAlert } from "./alerts";
import art from "./prayer-art.svg";

/**
 * Prayer arrival banner in the closed notch: mosque artwork, the Arabic name,
 * the Latin name and time, plus a stop control while the adhan plays. Stays for
 * a minute and also opens the idle "line" look (see Notch.tsx).
 */
export function LivePrayer({ alert }: { alert: PrayerAlert }) {
  const playing = adhanPlaying.use();
  const remaining = Math.max(0, ALERT_MS - (Date.now() - alert.at));

  return (
    <motion.div
      className="absolute inset-0"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      {/* Emerald glow behind the artwork; the shape itself stays black. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 160% at 8% 50%, rgb(48 209 88 / 0.18), transparent 58%)",
        }}
      />

      <div className="relative flex h-full items-center gap-2.5 px-2.5">
        <motion.div
          className="relative size-[36px] shrink-0 overflow-hidden rounded-[10px] ring-1 ring-separator"
          initial={{ opacity: 0, scale: 0.88 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={springs.snappy}
        >
          <img src={art} alt="" draggable={false} className="size-full object-cover" />
        </motion.div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              dir="rtl"
              lang="ar"
              className="prayer-arabic truncate text-[17px] leading-none font-semibold text-label"
            >
              {alert.ar}
            </span>
            <span className="truncate text-[8px] font-semibold tracking-[0.14em] text-label-3 uppercase">
              {t(alert.name)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-caption">
            <span className="tabular font-semibold text-label">{alert.time}</span>
            <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-label-4" />
            <span className="truncate text-label-2">{alert.place}</span>
          </div>
        </div>

        {playing ? (
          <button
            type="button"
            aria-label={t("Adhan stoppen")}
            title={t("Adhan stoppen")}
            onClick={(e) => {
              e.stopPropagation();
              stopAdhan();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="pressable grid size-6 shrink-0 place-items-center rounded-full bg-green/15 text-green"
          >
            <SpeakerSlash size={12} weight="bold" />
          </button>
        ) : (
          <motion.div
            aria-hidden
            title={t("Jetzt")}
            className="grid size-6 shrink-0 place-items-center rounded-full bg-green/15 text-green"
            animate={{ opacity: [1, 0.45] }}
            transition={pulse}
          >
            <BellRinging size={12} weight="fill" />
          </motion.div>
        )}
      </div>

      {/* Quiet countdown: the banner leaves after a minute. */}
      <div aria-hidden className="absolute inset-x-4 bottom-0 h-px overflow-hidden">
        <motion.div
          className="h-full w-full bg-green/60"
          style={{ transformOrigin: "left" }}
          initial={{ scaleX: remaining / ALERT_MS }}
          animate={{ scaleX: 0 }}
          transition={{ duration: remaining / 1000, ease: "linear" }}
        />
      </div>
    </motion.div>
  );
}
