import { useRef } from "react";
import { AnimatePresence } from "motion/react";
import { useNowPlaying } from "../platform/media";
import { LiveActivity } from "../features/now-playing/LiveActivity";
import { LiveTimer, useTimerLive } from "../features/timer/LiveTimer";
import { LiveDiscord } from "../features/discord/LiveDiscord";
import { useDiscordCall } from "../features/discord/store";
import { LiveGaming } from "../features/system/LiveGaming";
import { useGamingLive } from "../features/system/gaming";
import { geometry } from "./geometry";

/**
 * Which live activity the closed notch shows. Exactly one, by priority:
 * gaming mode (turned on deliberately) before time-critical (timer, call) before
 * background (music). Add new activities here. The ID is also the tool that opens.
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

/**
 * The activity sits in a fixed box the size of the closed live notch, centered, so it
 * stays put while the shape opens, closes or peeks around it. Pinned to the animated
 * edges instead, it crept in subpixel steps at the end of every spring (issue #3).
 */
export function LiveSlot({ id }: { id: string | null }) {
  const np = useNowPlaying();
  const call = useDiscordCall();
  // Keep the last size while an activity fades out (id is null when the notch opens).
  const last = useRef(id);
  if (id) last.current = id;
  const box = last.current === "system" ? geometry.gaming : geometry.live;
  return (
    <div className="absolute top-0 left-1/2" style={{ width: box.w, height: box.h, marginLeft: -box.w / 2 }}>
      <AnimatePresence initial={false}>
        {id === "system" && <LiveGaming key="system" />}
        {id === "timer" && <LiveTimer key="timer" />}
        {id === "discord" && call && <LiveDiscord key="discord" call={call} />}
        {id === "media" && np && <LiveActivity key="media" np={np} />}
      </AnimatePresence>
    </div>
  );
}
