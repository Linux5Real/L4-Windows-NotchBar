import { motion } from "motion/react";
import { MicrophoneSlash, SpeakerSimpleSlash } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import type { DiscordCall } from "../../platform/services";
import { Equalizer } from "../now-playing/Equalizer";
import { GuildIcon } from "./DiscordView";

/**
 * Geschlossene Notch im Discord-Anruf (wie ein Telefonat in der Dynamic Island):
 * links das Server-Icon, rechts der gleiche Equalizer wie bei Musik (grün), solange
 * jemand spricht — echte Pegel kommen aus dem Loopback (Stimmen der anderen), bei der
 * eigenen Stimme bewegt er sich synthetisch. Stumm/taub = rotes Symbol.
 */
export function LiveDiscord({ call }: { call: DiscordCall }) {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-between px-[9px]"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <GuildIcon call={call} size={20} />
      {call.deaf ? (
        <SpeakerSimpleSlash size={15} weight="fill" className="mr-0.5 text-red" />
      ) : call.mute ? (
        <MicrophoneSlash size={15} weight="fill" className="mr-0.5 text-red" />
      ) : (
        <span className="mr-0.5">
          <Equalizer playing={call.speaking || call.members.some((m) => m.speaking)} tint="bg-green" />
        </span>
      )}
    </motion.div>
  );
}
