/*
 * Free translation without API keys: public endpoints are tried in order, the
 * next one taking over whenever one fails (network, rate limit, empty answer).
 * The assistant has no access to this – the tool is user-facing only.
 */

export type ProviderId = "google" | "google-dict" | "mymemory";

/** Shown in the footer as a quiet credit. */
export const providerLabel: Record<ProviderId, string> = {
  google: "Google",
  "google-dict": "Google",
  mymemory: "MyMemory",
};

export interface TranslateResult {
  text: string;
  provider: ProviderId;
  /** Source language the text was detected as (only with `from = "auto"`). */
  detected?: string;
}

interface Provider {
  id: ProviderId;
  /** Longest text per request (URL length / provider cap). */
  maxChunk: number;
  run(chunk: string, from: string, to: string, signal: AbortSignal): Promise<{ text: string; detected?: string }>;
}

/** Per chunk; a dead endpoint falls through quickly instead of blocking the chain. */
const TIMEOUT = 12_000;

const providers: Provider[] = [
  {
    id: "google",
    maxChunk: 900,
    async run(q, from, to, signal) {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${from}&tl=${to}&q=${encodeURIComponent(q)}`;
      const data = await getJson(url, signal);
      if (!Array.isArray(data?.[0])) throw new Error("google:format");
      // Segments of one answer; each `[translated, original, …]`.
      const text = (data[0] as unknown[][])
        .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
        .join("");
      if (!text.trim()) throw new Error("google:empty");
      return { text, detected: from === "auto" && typeof data[2] === "string" ? data[2] : undefined };
    },
  },
  {
    id: "google-dict",
    maxChunk: 900,
    async run(q, from, to, signal) {
      // Same vendor, different host – only reached when the endpoint above is gone.
      const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${from}&tl=${to}&q=${encodeURIComponent(q)}`;
      const data = await getJson(url, signal);
      const text = typeof data?.[0]?.[0] === "string" ? (data[0][0] as string) : "";
      if (!text.trim()) throw new Error("google-dict:empty");
      return { text, detected: from === "auto" && typeof data?.[0]?.[1] === "string" ? (data[0][1] as string) : undefined };
    },
  },
  {
    id: "mymemory",
    maxChunk: 450,
    async run(q, from, to, signal) {
      const source = from === "auto" ? "autodetect" : from;
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(to)}`;
      const data = await getJson(url, signal);
      const text = decodeEntities(String(data?.responseData?.translatedText ?? ""));
      const status = Number(data?.responseStatus ?? 0);
      // Errors come back as 200 with a message in translatedText.
      if (status !== 200 || /^(MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID (LANGUAGE PAIR|EMAIL))/i.test(text)) {
        throw new Error("mymemory:rejected");
      }
      if (!text.trim()) throw new Error("mymemory:empty");
      return { text, detected: from === "auto" ? String(data?.responseData?.detectedLanguage ?? "") || undefined : undefined };
    },
  },
];

/**
 * Translates `text` with the first provider that answers; long texts are split
 * at sentence boundaries (per provider limit) and put back together.
 * Rejects with the last error once every provider failed.
 */
export async function translate(text: string, from: string, to: string, signal?: AbortSignal): Promise<TranslateResult> {
  const clean = text.trim();
  if (!clean) throw new Error("translate:empty");
  if (from !== "auto" && from === to) throw new Error("translate:same-language");

  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  let lastError: unknown = null;
  try {
    for (const provider of providers) {
      try {
        const chunks = chunkText(clean, provider.maxChunk);
        const parts: string[] = [];
        let detected: string | undefined;
        for (const chunk of chunks) {
          const result = await provider.run(chunk, from, to, ctrl.signal);
          parts.push(result.text);
          detected ??= result.detected;
        }
        return { text: parts.join(" "), provider: provider.id, detected };
      } catch (error) {
        if (ctrl.signal.aborted) throw error;
        lastError = error;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  throw lastError ?? new Error("translate:failed");
}

/** Splits at sentence ends, packs up to `max` characters; long runs are cut at spaces. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    const part = current.trim();
    if (part) chunks.push(part);
    current = "";
  };
  for (const raw of text.split(/(?<=[.!?…。！？؟:;])\s+|\n+/)) {
    let part = raw.trim();
    if (!part) continue;
    // A single sentence beyond the limit gets cut down at spaces (or hard).
    while (part.length > max) {
      let cut = part.lastIndexOf(" ", max);
      if (cut < max * 0.5) cut = max;
      push();
      chunks.push(part.slice(0, cut).trim());
      part = part.slice(cut).trim();
    }
    if (!part) continue;
    if (current && current.length + 1 + part.length > max) push();
    current = current ? `${current} ${part}` : part;
  }
  push();
  return chunks;
}

/** MyMemory HTML-escapes quotes and ampersands. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:quot|#39|amp|lt|gt);/g, (m) => ({ "&quot;": '"', "&#39;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" })[m] ?? m);
}

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { signal: withTimeout(signal) });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json();
}

/** External abort plus a hard timeout, whichever comes first. */
function withTimeout(signal: AbortSignal): AbortSignal {
  const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof anySignal === "function" ? anySignal([signal, AbortSignal.timeout(TIMEOUT)]) : signal;
}
