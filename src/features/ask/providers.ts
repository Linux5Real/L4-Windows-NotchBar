import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "../../platform/native";
import type { AskEffort, AskProvider, AskProviderConfig } from "../../settings/store";

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
 * Antwort streamen. In der App über Rust (`ai_chat`, src-tauri/src/ai.rs) — der
 * Schlüssel bleibt dort. Im Browser eine lokale Demo, damit sich die Oberfläche
 * ohne App gestalten lässt.
 * Fehlercode "no-key" = kein Schlüssel für diesen Anbieter gespeichert.
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
  const reply = `Browser-Vorschau: In der App antwortet hier das eingestellte Modell auf „${last.slice(0, 120)}“.`;
  for (const chunk of reply.match(/\S+\s*/g) ?? []) {
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 35));
    onDelta(chunk);
  }
}
