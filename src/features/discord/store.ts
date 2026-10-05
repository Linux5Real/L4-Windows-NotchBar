import { createStore } from "../../lib/store";
import { discord, type DiscordSnapshot } from "../../platform/services";
import { settings } from "../../settings/store";

/** Last state from Rust (`discord://state`). */
export const discordState = createStore<DiscordSnapshot>({ status: "off", error: null, call: null });

let started = false;

/** Connects/disconnects when the Discord tool or the client ID changes. */
export function startDiscord() {
  if (started) return;
  started = true;
  discord.onState((s) => discordState.set(s));
  void discord.state().then((s) => discordState.set(s));

  let last = "";
  const apply = () => {
    const s = settings.get();
    const enabled = s.tools.some((x) => x.id === "discord" && x.enabled);
    const key = `${enabled}|${s.discord.clientId}`;
    if (key === last) return;
    last = key;
    discord.configure(enabled, s.discord.clientId);
  };
  apply();
  settings.subscribe(apply);
}

/** Reconnect (e.g. after saving the client secret). */
export function reconnectDiscord() {
  const s = settings.get();
  discord.configure(s.tools.some((x) => x.id === "discord" && x.enabled), s.discord.clientId);
}

export function useDiscordCall() {
  return discordState.use().call;
}
