import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "../../platform/native";
import type { AskEffort, AskMode, AskProvider, AskProviderConfig } from "../../settings/store";
import { showcase, showcaseAnswer } from "../../dev/showcase-data";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Model reasoning/thinking text (assistant messages only). */
  reasoning?: string;
  /** Seconds the reply took (assistant messages only). */
  duration?: number;
  /** App actions that ran after this reply (assistant messages only). */
  effects?: string[];
}

/** A conversation persisted in the chat history. */
export interface SavedChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  savedAt: number;
}

export const providerInfo: Record<AskProvider, { label: string; modelHint: string }> = {
  opencode: { label: "OpenCode", modelHint: "DeepSeek V4.1 Flash" },
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

/** Mode names are brand names, so they stay the same in every language. */
export const askModes: { value: AskMode; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "studio", label: "Studio" },
];

/** A model from OpenCode's own catalog. `id` is the real provider/model value. */
export interface OpenCodeModel {
  id: string;
  provider: string;
  name: string;
  context: number;
}

const demoModels: OpenCodeModel[] = [
  { id: "opencode/deepseek-v4.1-flash-free", provider: "opencode", name: "DeepSeek V4.1 Flash", context: 128000 },
  { id: "opencode/glm-5.3-flash-free", provider: "opencode", name: "GLM 5.3 Flash", context: 128000 },
  { id: "opencode/mimo-v2.6-flash-free", provider: "opencode", name: "MiMo V2.6 Flash", context: 128000 },
  { id: "opencode/flint-40b-free", provider: "opencode", name: "Flint 40B", context: 262144 },
  { id: "opencode-go/minimax-m3.1-flash", provider: "opencode-go", name: "MiniMax M3.1 Flash", context: 1024000 },
  { id: "opencode-go/gemini-3.6-flash", provider: "opencode-go", name: "Gemini 3.6 Flash", context: 1000000 },
  { id: "openai/gpt-5.5", provider: "openai", name: "GPT-5.5", context: 400000 },
  { id: "anthropic/claude-opus-5-5", provider: "anthropic", name: "Claude Opus 5.5", context: 200000 },
];

let models: OpenCodeModel[] | null = null;
let loadingModels: Promise<OpenCodeModel[]> | null = null;

/** Models are fetched once from OpenCode and kept for the app session. */
export async function listOpenCodeModels(): Promise<OpenCodeModel[]> {
  if (!isNative) return demoModels;
  if (models) return models;
  if (!loadingModels) {
    loadingModels = invoke<OpenCodeModel[]>("opencode_models")
      .then((result) => {
        models = result;
        return result;
      })
      .finally(() => {
        loadingModels = null;
      });
  }
  return loadingModels;
}

/** Human-readable name for a stored model id, without the `free` suffix. */
export function modelLabel(id: string, catalog?: OpenCodeModel[] | null): string {
  if (!id) return "";
  const found = (catalog ?? models)?.find((model) => model.id === id);
  if (found) return cleanModelName(found.name);
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return cleanModelName(bare);
}

/** Menu label: only the readable model name; the provider is the group heading. */
export function modelOptionLabel(model: OpenCodeModel): string {
  return cleanModelName(model.name || modelLabel(model.id));
}

const providerNames: Record<string, string> = {
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  google: "Google",
  "google-vertex": "Google Vertex",
  "github-copilot": "GitHub Copilot",
  "amazon-bedrock": "Amazon Bedrock",
  azure: "Azure",
  mistral: "Mistral",
  gitlab: "GitLab",
};

export function providerLabel(provider: string): string {
  return providerNames[provider] ?? provider;
}

const brands: Record<string, string> = {
  deepseek: "DeepSeek",
  glm: "GLM",
  mimo: "MiMo",
  minimax: "MiniMax",
  nemotron: "Nemotron",
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  llama: "Llama",
  mistral: "Mistral",
};

function cleanModelName(name: string): string {
  const cleaned = name
    .replace(/[-_]+/g, " ")
    .replace(/\bfree\b/gi, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return name;
  return cleaned
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (brands[lower]) return brands[lower];
      if (/^v\d/i.test(word)) return `V${word.slice(1)}`;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

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
  /** `replace` = the server rewrote the message (OpenCode retry): set content, don't append. */
  onDelta: (text: string, replace?: boolean) => void,
  signal: AbortSignal,
  onReasoning?: (text: string, replace?: boolean) => void,
): Promise<void> {
  if (!isNative) return demoStream(messages, onDelta, signal);

  const id = crypto.randomUUID();
  const off = await listen<{ id: string; text: string; replace?: boolean }>("ai://delta", (e) => {
    if (e.payload.id === id && !signal.aborted) onDelta(e.payload.text, e.payload.replace);
  });
  const offR = onReasoning
    ? await listen<{ id: string; text: string; replace?: boolean }>("ai://reasoning", (e) => {
        if (e.payload.id === id && !signal.aborted) onReasoning(e.payload.text, e.payload.replace);
      })
    : () => {};
  const onAbort = () => void invoke("ai_cancel", { id });
  signal.addEventListener("abort", onAbort);
  try {
    await invoke("ai_chat", { id, config: { provider, ...config }, messages });
  } catch (e) {
    throw new Error(String(e));
  } finally {
    signal.removeEventListener("abort", onAbort);
    off();
    offR();
  }
}

/** Ends the OpenCode session and stops the background server. */
export async function resetOpenCodeSession(): Promise<void> {
  if (!isNative) return;
  try {
    await invoke("ai_reset");
  } catch {
    // The chat is local; a missing OpenCode process is not an error here.
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
