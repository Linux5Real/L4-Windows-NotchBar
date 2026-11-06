import { navigate } from "../notch/nav";
import { setFocusMode } from "../notch/focus";
import { media } from "../platform/media";
import { mockDiscord, mockPrivacy, secrets } from "../platform/services";
import { settings, updateSettings } from "../settings/store";
import { previewPrayerAlert } from "../features/prayer/alerts";

/** Tools in the dock during the showcase, in this order. */
const SHOWCASE_TOOLS = ["overview", "media", "discord", "trading", "ask", "convert", "clipboard", "vault", "timer", "weather", "prayer", "shelf"];

/**
 * Browser only (`?showcase`): English UI, a curated dock and a demo depot key.
 * `window.__showcase` lets a capture script start a call or the music.
 */
export function startShowcase() {
  setFocusMode(false);
  const params = new URLSearchParams(location.search);
  updateSettings((s) => ({
    language: "en",
    // Screenshot URLs for the prayer banner must not open the notch on a stray cursor.
    openMode: params.has("prayer") ? "click" : "hover",
    hoverDelay: "normal",
    tools: [
      ...SHOWCASE_TOOLS.map((id) => ({ id, enabled: true })),
      ...s.tools.filter((x) => !SHOWCASE_TOOLS.includes(x.id)).map((x) => ({ id: x.id, enabled: false })),
    ],
    trading: { env: "live" },
    // Screenshots start centered and closed, whatever a previous demo stored.
    display: { ...s.display, offset: 0, idleStyle: "notch" },
    weather: { name: "Amsterdam", lat: 52.37, lon: 4.89, auto: false },
    ask: { provider: "anthropic", configs: { ...s.ask.configs, anthropic: { model: "Claude Opus 5.5", effort: "high", baseUrl: "" } } },
  }));
  void secrets.set("t212.key", "showcase");
  navigate("overview");

  // `?showcase&prayer` opens the prayer banner for screenshots (silent).
  // `?showcase&prayer&line` proves it also shows in the thin idle line.
  if (params.has("prayer")) {
    if (params.has("line")) {
      updateSettings((s) => ({ display: { ...s.display, idleStyle: "line" } }));
    }
    window.setTimeout(() => previewPrayerAlert(), 500);
  }

  Object.assign(window, {
    __showcase: {
      play: () => !media.get()?.isPlaying && media.toggle(),
      pause: () => media.get()?.isPlaying && media.toggle(),
      // A call also lights the green mic dot, like on the iPhone.
      call: (on: boolean) => {
        mockPrivacy.mic = on;
        if (on !== !!mockDiscord.get().call) mockDiscord.toggleCall();
      },
      navigate,
      settings,
      // Prayer banner for screenshots (no sound, no Windows toast).
      prayer: () => previewPrayerAlert(),
    },
  });
}
