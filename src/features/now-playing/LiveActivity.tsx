import { AnimatePresence, motion } from "motion/react";
import { MusicNoteSimple } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import type { NowPlaying } from "../../platform/media";
import { Equalizer } from "./Equalizer";

/**
 * Geschlossene Notch während Musik läuft: Cover links, Equalizer rechts —
 * die Mitte bleibt leer, wie bei einer echten Notch.
 */
export function LiveActivity({ np }: { np: NowPlaying }) {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-between px-[9px]"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <LiveArtwork artwork={np.artwork} />
      <Equalizer playing={np.isPlaying} />
    </motion.div>
  );
}

/**
 * Songwechsel: altes und neues Cover liegen übereinander und blenden mit Blur-Brücke
 * ineinander (wie die Dynamic Island) — kein hartes Ersetzen, keine Lücke.
 */
function LiveArtwork({ artwork }: { artwork: string | null }) {
  return (
    <div className="relative size-5 shrink-0">
      <AnimatePresence initial={false}>
        <motion.div
          key={artwork ?? "placeholder"}
          className="absolute inset-0 flex items-center justify-center"
          initial={{ opacity: 0, transform: "scale(0.9)", filter: "blur(3px)" }}
          animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)", transition: { ...content.enter, delay: 0 } }}
          exit={{ opacity: 0, transform: "scale(1.06)", filter: "blur(3px)", transition: content.enter }}
        >
          {artwork ? (
            <img src={artwork} alt="" draggable={false} className="size-5 rounded-[5px] object-cover" />
          ) : (
            <MusicNoteSimple size={15} weight="fill" className="text-accent" />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
