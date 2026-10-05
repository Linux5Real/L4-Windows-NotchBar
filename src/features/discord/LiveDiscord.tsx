import { motion } from "motion/react";
import { MicrophoneSlash, SpeakerSimpleSlash } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import type { DiscordCall } from "../../platform/services";
import { Equalizer } from "../now-playing/Equalizer";
import { GuildIcon } from "./DiscordView";
import { LiveEdge } from "../../notch/liveEdges";

/**
 * Closed notch during a Discord call (like a phone call on the Dynamic Island):
 * server icon on the left, the same equalizer as for music (green) on the right while
 * someone talks. Real levels come from loopback (the others' voices); for your own
 * voice it moves synthetically. Muted/deafened = red icon.
 */
export function LiveDiscord({ call }: { call: DiscordCall }) {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-between px-[9px]"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <LiveEdge side="left">
        <GuildIcon call={call} size={20} />
      </LiveEdge>
      <LiveEdge side="right">
        {call.deaf ? (
          <SpeakerSimpleSlash
            size={15}
            weight="fill"
            className="mr-0.5 text-red"
          />
        ) : call.mute ? (
          <MicrophoneSlash
            size={15}
            weight="fill"
            className="mr-0.5 text-red"
          />
        ) : (
          <span className="mr-0.5">
            <Equalizer
              playing={call.speaking || call.members.some((m) => m.speaking)}
              tint="bg-green"
            />
          </span>
        )}
      </LiveEdge>
    </motion.div>
  );
}
