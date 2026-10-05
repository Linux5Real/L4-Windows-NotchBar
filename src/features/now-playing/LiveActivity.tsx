import { AnimatePresence, motion } from "motion/react";
import { MusicNoteSimple } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import type { NowPlaying } from "../../platform/media";
import { Equalizer } from "./Equalizer";
import { LiveEdge } from "../../notch/liveEdges";

/**
 * Closed notch while music plays: cover on the left, equalizer on the right,
 * the middle stays empty like a real notch.
 */
export function LiveActivity({ np }: { np: NowPlaying }) {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-between px-[9px]"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <LiveEdge side="left">
        <LiveArtwork artwork={np.artwork} />
      </LiveEdge>
      <LiveEdge side="right">
        <Equalizer playing={np.isPlaying} />
      </LiveEdge>
    </motion.div>
  );
}

/**
 * Track change: old and new cover sit on top of each other and blend with a blur bridge
 * (like the Dynamic Island), no hard swap, no gap.
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
