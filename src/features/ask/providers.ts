import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "../../platform/native";
import type { AskEffort, AskProvider, AskProviderConfig } from "../../settings/store";
import { showcase, showcaseAnswer } from "../../dev/showcase-data";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export const providerInfo: Record<AskProvider, { label: string; modelHint: string }> = {
  openrouter: { label: "OpenRouter", modelHint: "z. B. anthropic/claude-opus-5-5" },
  openai: { label: "ChatGPT", modelHint: "Modell-ID von OpenAI" },
  anthropic: { label: "Claude", modelHint: "claude-opus-5-5" },
  custom: { label: "Custom", modelHint: "z. B. grok-4.7" },
};

export const effortLevels: { value: AskEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

/**
 * Streams a reply. In the app via Rust (`ai_chat`, src-tauri/src/ai.rs), so the key
 * stays there. In the browser a local demo, so the UI can be designed without
 * the app.
 * Error code "no-key" = no key stored for this provider.
 */
export async function streamChat(
  provider: AskProvider,
  config: AskProviderConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!isNative) return demoStream(messages, onDelta, signal);

  const id = crypto.randomUUID();
  const off = await listen<{ id: string; text: string }>("ai://delta", (e) => {
    if (e.payload.id === id && !signal.aborted) onDelta(e.payload.text);
  });
  const onAbort = () => void invoke("ai_cancel", { id });
  signal.addEventListener("abort", onAbort);
  try {
    await invoke("ai_chat", { id, config: { provider, ...config }, messages });
  } catch (e) {
    throw new Error(String(e));
  } finally {
    signal.removeEventListener("abort", onAbort);
    off();
  }
}

async function demoStream(messages: ChatMessage[], onDelta: (text: string) => void, signal: AbortSignal) {
  const last = messages.at(-1)?.content ?? "";
  const reply = showcase ? showcaseAnswer : `Browser-Vorschau: In der App antwortet hier das eingestellte Modell auf „${last.slice(0, 120)}“.`;
  if (showcase) await new Promise((r) => setTimeout(r, 380));
  for (const chunk of reply.match(/\S+\s*/g) ?? []) {
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, showcase ? 34 : 25 + Math.random() * 35));
    onDelta(chunk);
  }
}
