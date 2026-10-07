import { AnimatePresence, motion } from "motion/react";
import { MusicNoteSimple } from "@phosphor-icons/react";
import { artwork as artworkSwap, content } from "../../design/motion";
import { useSmoothArtwork } from "./artwork";
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
 * Track or app change: the new cover (already decoded) fades in on top of the old one
 * with a blur bridge, the old one leaves a beat later. No cut, no gap, same calm
 * pace as the accent color of the equalizer.
 */
function LiveArtwork({ artwork: src }: { artwork: string | null }) {
  const artwork = useSmoothArtwork(src);
  return (
    <div className="relative size-5 shrink-0">
      <AnimatePresence initial={false}>
        <motion.div
          key={artwork ?? "placeholder"}
          className="absolute inset-0 flex items-center justify-center"
          initial={{ opacity: 0, transform: "scale(0.94)", filter: "blur(3px)" }}
          animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)", transition: artworkSwap.enter }}
          exit={{ opacity: 0, filter: "blur(2px)", transition: artworkSwap.exit }}
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
