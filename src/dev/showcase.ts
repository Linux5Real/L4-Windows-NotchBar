import { navigate } from "../notch/nav";
import { media } from "../platform/media";
import { mockDiscord, mockPrivacy, secrets } from "../platform/services";
import { settings, updateSettings } from "../settings/store";

/** Tools in the dock during the showcase, in this order. */
const SHOWCASE_TOOLS = ["overview", "media", "discord", "trading", "ask", "convert", "clipboard", "vault", "timer", "weather", "shelf"];

/**
 * Browser only (`?showcase`): English UI, a curated dock and a demo depot key.
 * `window.__showcase` lets a capture script start a call or the music.
 */
export function startShowcase() {
  updateSettings((s) => ({
    language: "en",
    openMode: "hover",
    hoverDelay: "normal",
    tools: [
      ...SHOWCASE_TOOLS.map((id) => ({ id, enabled: true })),
      ...s.tools.filter((x) => !SHOWCASE_TOOLS.includes(x.id)).map((x) => ({ id: x.id, enabled: false })),
    ],
    trading: { env: "live" },
    weather: { name: "Amsterdam", lat: 52.37, lon: 4.89, auto: false },
    ask: { provider: "anthropic", configs: { ...s.ask.configs, anthropic: { model: "Claude Opus 5.5", effort: "high", baseUrl: "" } } },
  }));
  void secrets.set("t212.key", "showcase");
  navigate("overview");

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
    },
  });
}
