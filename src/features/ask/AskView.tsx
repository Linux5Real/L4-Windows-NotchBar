import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Copy, Check, NotePencil, Stop, Translate, TextAlignLeft, X, type Icon } from "@phosphor-icons/react";
import { content, fade } from "../../design/motion";
import { createStore } from "../../lib/store";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { clipboard } from "../../platform/clipboard";
import { settings } from "../../settings/store";
import { providerInfo, streamChat, type ChatMessage } from "./providers";
import { t, tBackend } from "../../i18n";

/** Unterhaltung lebt nur bis zum Neustart (kein Verlauf auf der Platte); × leert sie. */
const chat = createStore<ChatMessage[]>([]);
// Ältere Versionen haben den Chat gespeichert → einmalig entfernen.
localStorage.removeItem("notch:ask-chat");

const quick: { icon: Icon; label: string; prompt: (text: string) => string }[] = [
  { icon: TextAlignLeft, label: "Zusammenfassen", prompt: (text) => t("Fasse kurz zusammen: {x}", { x: text }) },
  { icon: NotePencil, label: "Umformulieren", prompt: (text) => t("Formuliere klarer um: {x}", { x: text }) },
  { icon: Translate, label: "Ins Englische", prompt: (text) => t("Übersetze ins Englische: {x}", { x: text }) },
];

/*
 *   Ask                                    grok-4.7  [×] [📌]
 *   ┌───────────────────────────────────────────────┐
 *   │                         Wie spät ist es in NY? │
 *   │ Die Antwort …▍                                │
 *   └───────────────────────────────────────────────┘
 *   [ Frag etwas …                             (↑) ]
 *
 * Anbieter, Modell und Effort stellt man nur in den Einstellungen ein.
 */
export function AskView() {
  const messages = chat.use();
  const ask = settings.use().ask;
  const provider = ask.provider;
  const config = ask.configs[provider];
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    return () => abort.current?.abort();
  }, []);

  // Beim Streamen unten mitlaufen.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages]);

  const send = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || streaming) return;
    setDraft("");
    setError(null);
    const history: ChatMessage[] = [...chat.get(), { role: "user", content: prompt }];
    chat.set([...history, { role: "assistant", content: "" }]);
    setStreaming(true);
    abort.current = new AbortController();
    try {
      await streamChat(provider, config, history, (delta) => {
        chat.set((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, content: last.content + delta };
          return next;
        });
      }, abort.current.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg === "no-key" ? t("Kein API-Schlüssel für {p} – in den Einstellungen eintragen.", { p: providerInfo[provider].label }) : tBackend(msg));
      // Leere Antwortblase wieder entfernen.
      chat.set((m) => (m.at(-1)?.content === "" ? m.slice(0, -1) : m));
    } finally {
      setStreaming(false);
    }
  };

  const runQuick = (q: (typeof quick)[number]) => {
    const latest = clipboard.get().find((c) => c.kind === "text" || c.kind === "link");
    if (!latest) {
      setError(t("Zuerst einen Text kopieren – die Schnellaktionen arbeiten mit der Zwischenablage."));
      return;
    }
    void send(q.prompt(latest.text));
  };

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-2">
      <HeaderActions>
        <button
          onClick={() => navigate("settings", "ask")}
          title={t("Modell in den Einstellungen ändern")}
          className="mr-1 max-w-40 truncate text-caption text-label-3 hover:text-label-2"
        >
          {config.model || providerInfo[provider].label}
        </button>
        <HeaderButton
          label={t("Chat leeren")}
          disabled={messages.length === 0}
          onClick={() => {
            abort.current?.abort();
            chat.set([]);
            setError(null);
            input.current?.focus({ preventScroll: true });
          }}
        >
          <X size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <span className="text-body text-label-2">{t("Frag etwas oder nutze die Zwischenablage")}</span>
            <div className="flex gap-1.5">
              {quick.map((q) => (
                <button
                  key={q.label}
                  onClick={() => runQuick(q)}
                  className="pressable pressable-fill flex h-7 items-center gap-1.5 rounded-full bg-fill-1 px-3 text-footnote text-label-2"
                >
                  <q.icon size={13} weight="bold" /> {t(q.label)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 pb-1">
            {messages.map((m, i) => (
              <Bubble key={i} message={m} streaming={streaming && i === messages.length - 1} />
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {error && (
          <motion.div
            className="mb-1 text-caption text-orange"
            initial={{ opacity: 0, transform: "translateY(2px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0 }}
            transition={fade}
          >
            {error}{" "}
            <button onClick={() => navigate("settings", "ask")} className="underline underline-offset-2 hover:text-label">
              {t("Einstellungen")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <form
        className="mt-1 flex items-end gap-2 rounded-[16px] bg-fill-1 py-1.5 pr-1.5 pl-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          ref={input}
          value={draft}
          rows={1}
          placeholder={t("Frag etwas …")}
          onChange={(e) => {
            setDraft(e.target.value);
            // Wächst bis 3 Zeilen mit.
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 54)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
          className="max-h-[54px] min-h-[18px] flex-1 resize-none bg-transparent py-0.5 text-body text-label outline-none [scrollbar-width:none] placeholder:text-label-4"
        />
        {streaming ? (
          <button type="button" aria-label={t("Stopp")} onClick={() => abort.current?.abort()} className="pressable flex size-6 shrink-0 items-center justify-center rounded-full bg-fill-3 text-label">
            <Stop size={11} weight="fill" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label={t("Senden")}
            disabled={!draft.trim()}
            className="pressable flex size-6 shrink-0 items-center justify-center rounded-full bg-label text-black transition-opacity duration-150 disabled:opacity-25"
          >
            <ArrowUp size={13} weight="bold" />
          </button>
        )}
      </form>

    </div>
  );
}

function Bubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const user = message.role === "user";
  return (
    <motion.div
      className={`group flex ${user ? "justify-end" : "justify-start"}`}
      initial={{ opacity: 0, transform: "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={content.enter}
    >
      <div
        className={`relative max-w-[85%] text-body whitespace-pre-wrap ${
          user ? "rounded-[14px] rounded-br-[4px] bg-fill-2 px-3 py-1.5 text-label" : "px-1 text-label-2"
        }`}
      >
        {message.content}
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse bg-label-2" />}
        {!user && !streaming && message.content && (
          <button
            aria-label={t("Kopieren")}
            onClick={() => {
              void navigator.clipboard.writeText(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="pressable mt-1 flex items-center gap-1 text-caption text-label-4 opacity-0 group-hover:opacity-100 hover:text-label-2"
          >
            {copied ? <Check size={11} weight="bold" /> : <Copy size={11} weight="bold" />} {copied ? t("Kopiert") : t("Kopieren")}
          </button>
        )}
      </div>
    </motion.div>
  );
}
