import { AnimatePresence } from "motion/react";
import { useNowPlaying } from "../platform/media";
import { LiveActivity } from "../features/now-playing/LiveActivity";
import { LiveTimer, useTimerLive } from "../features/timer/LiveTimer";
import { LiveDiscord } from "../features/discord/LiveDiscord";
import { useDiscordCall } from "../features/discord/store";
import { LiveGaming } from "../features/system/LiveGaming";
import { useGamingLive } from "../features/system/gaming";

/**
 * Welche Live-Aktivität zeigt die geschlossene Notch? Genau eine, nach Priorität:
 * Gaming-Modus (bewusst eingeschaltet) vor zeitkritisch (Timer, Anruf) vor Hintergrund
 * (Musik). Neue Aktivität = hier einreihen. Die ID ist zugleich das Tool, das sich öffnet.
 */
export function useLiveActivity(): { id: string | null } {
  const gaming = useGamingLive();
  const timerLive = useTimerLive();
  const call = useDiscordCall();
  const np = useNowPlaying();
  if (gaming) return { id: "system" };
  if (timerLive) return { id: "timer" };
  if (call) return { id: "discord" };
  if (np?.isPlaying) return { id: "media" };
  return { id: null };
}

export function LiveSlot({ id }: { id: string | null }) {
  const np = useNowPlaying();
  const call = useDiscordCall();
  return (
    <AnimatePresence initial={false}>
      {id === "system" && <LiveGaming key="system" />}
      {id === "timer" && <LiveTimer key="timer" />}
      {id === "discord" && call && <LiveDiscord key="discord" call={call} />}
      {id === "media" && np && <LiveActivity key="media" np={np} />}
    </AnimatePresence>
  );
}
