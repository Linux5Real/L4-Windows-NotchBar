import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUp, ArrowsClockwise, CheckCircle, Copy, Check, NotePencil, Sparkle, Stop, Translate, TextAlignLeft, X, CaretDown, Plus, type Icon } from "@phosphor-icons/react";
import { content, fade } from "../../design/motion";
import { createStore } from "../../lib/store";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { clipboard } from "../../platform/clipboard";
import { settings, updateAsk } from "../../settings/store";
import { modelLabel, providerInfo, resetOpenCodeSession, streamChat, type ChatMessage, type SavedChat } from "./providers";
import { ModelSelect } from "./ModelSelect";
import { ChatHistory } from "./ChatHistory";
import { MarkdownText } from "./Markdown";
import { parseAppActions, runAppActions, visibleAnswer, withAppContext } from "./appActions";
import { ScrollArea } from "../../ui/ScrollArea";
import { t, tBackend } from "../../i18n";
import { invoke } from "@tauri-apps/api/core";
import { isNative } from "../../platform/native";

/** In-memory working chat. */
const chat = createStore<ChatMessage[]>([]);
/** Persisted saved chats (only used when saveHistory is on). */
const savedChats = createStore<SavedChat[]>([], { persist: "ask-saved-chats" });
/** Which saved chat is currently loaded (null = fresh unsaved). */
const activeSavedId = createStore<string | null>(null, { persist: "ask-active-chat" });

/**
 * Streaming outlives the view: closing the notch unmounts AskView, but the
 * OpenCode turn must keep running so the answer is there when it reopens.
 */
const askStreaming = createStore(false);
const askError = createStore<string | null>(null);
let activeAbort: AbortController | null = null;
let streamSeq = 0;
/**
 * Permission already written to the Rust side in this process. The view mounts
 * often (notch open/close); repeating the call used to reset the OpenCode
 * session in the middle of a running reply.
 */
let syncedPermission: string | null = null;

const rtlChar = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ltrChar = /[A-Za-z\u00C0-\u024F]/;
function isRtl(text: string): boolean {
  for (const ch of text) {
    if (rtlChar.test(ch)) return true;
    if (ltrChar.test(ch)) return false;
  }
  return false;
}

/** Reasoning at 11px in the ~500px panel: about 85 characters per line. */
const THINKING_LINE = 85;

/** Open the thinking block by default only when it fits in two lines. */
function isShortThinking(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  let lines = 0;
  for (const part of trimmed.split("\n")) {
    lines += Math.max(1, Math.ceil(part.length / THINKING_LINE));
    if (lines > 2) return false;
  }
  return true;
}
localStorage.removeItem("notch:ask-chat");

const quick: { icon: Icon; label: string; prompt: (text: string) => string }[] = [
  { icon: NotePencil, label: "Als Datei", prompt: (text) => t("Speichere den folgenden Text als Datei auf dem Desktop: {x}", { x: text }) },
  { icon: TextAlignLeft, label: "Erklären", prompt: (text) => t("Erkläre kurz: {x}", { x: text }) },
  { icon: Translate, label: "Übersetzen", prompt: (text) => t("Übersetze ins Englische: {x}", { x: text }) },
];

function chatTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return t("Neuer Chat");
  return first.content.slice(0, 40) || t("Neuer Chat");
}

export function AskView() {
  const messages = chat.use();
  const saved = savedChats.use();
  const aid = activeSavedId.use();
  const ask = settings.use().ask;
  const provider = ask.provider;
  const config = ask.configs[provider];
  const saveHistory = ask.saveHistory ?? false;
  const showThinking = ask.thinking ?? true;
  const [draft, setDraft] = useState("");
  const [chatEpoch, setChatEpoch] = useState(0);
  const streaming = askStreaming.use();
  const error = askError.use();
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (stick.current) list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages]);

  // Sync permission to the backend once per process, not on every mount.
  useEffect(() => {
    if (provider !== "opencode" || !isNative) return;
    const current = settings.get().ask.permission ?? "allow";
    if (syncedPermission === current) return;
    syncedPermission = current;
    void invoke("opencode_set_permission", { level: current }).catch(() => {
      syncedPermission = null;
    });
  }, []);

  const persistCurrent = () => {
    if (!saveHistory) return;
    const msgs = chat.get();
    if (msgs.length === 0) return;
    const id = activeSavedId.get();
    const known = id ? savedChats.get().some((c) => c.id === id) : false;
    if (id && known) {
      savedChats.set((prev) =>
        prev.map((c) => (c.id === id ? { ...c, messages: msgs, title: chatTitle(msgs), savedAt: Date.now() } : c)),
      );
      return;
    }
    // A persisted id that no longer points at a saved chat (history cleared):
    // start a fresh entry instead of silently dropping the conversation.
    const newId = crypto.randomUUID();
    activeSavedId.set(newId);
    savedChats.set((prev) => [{ id: newId, title: chatTitle(msgs), messages: msgs, savedAt: Date.now() }, ...prev]);
  };

  /** Runs one turn for a prepared history (last message is the user prompt). */
  const runTurn = async (history: ChatMessage[]) => {
    if (askStreaming.get()) return;
    askError.set(null);
    stick.current = true;
    setAtBottom(true);
    const seq = ++streamSeq;
    const started = Date.now();
    chat.set([...history, { role: "assistant", content: "" }]);
    askStreaming.set(true);
    const controller = new AbortController();
    activeAbort = controller;
    let failed = false;
    // The model gets the live app state and the action schema with the last
    // user turn; the chat itself stays clean.
    try {
      const backend = await Promise.all(
        history.map((message, index) =>
          index === history.length - 1 && message.role === "user"
            ? (async () => ({ ...message, content: await withAppContext(message.content) }))()
            : Promise.resolve(message),
        ),
      );
      await streamChat(provider, config, backend, (delta, replace) => {
        if (seq !== streamSeq) return;
        chat.set((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, content: replace ? delta : last.content + delta };
          return next;
        });
      }, controller.signal, (delta, replace) => {
        if (seq !== streamSeq) return;
        chat.set((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, reasoning: replace ? delta : (last.reasoning ?? "") + delta };
          return next;
        });
      });
    } catch (e) {
      if (seq !== streamSeq || controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      // The answer already streamed and only the final status poll lost the
      // server (a session reset or restart). Keep the reply and run its actions.
      const tail = chat.get().at(-1);
      const received = tail?.role === "assistant" && tail.content.trim().length > 0;
      if (received && /^Keine Verbindung zu OpenCode: error sending request/i.test(msg)) return;
      failed = true;
      askError.set(msg === "no-key" ? t("Kein API-Schlüssel für {p} – in den Einstellungen eintragen.", { p: providerInfo[provider].label }) : tBackend(msg));
      chat.set((m) => (m.at(-1)?.content === "" ? m.slice(0, -1) : m));
    } finally {
      if (seq === streamSeq) {
        const elapsed = (Date.now() - started) / 1000;
        const tail = chat.get().at(-1);
        let content = tail?.role === "assistant" ? tail.content : "";
        let effects: string[] | undefined;
        if (tail?.role === "assistant") {
          const parsed = parseAppActions(content);
          content = parsed.text;
          if (parsed.invalid) askError.set(t("Die App-Aktion in der Antwort war ungültig."));
          // If the user's own message quoted the protocol, the model likely parroted it — don't act on it.
          const lastUser = [...chat.get()].reverse().find((m) => m.role === "user");
          const quoted = !!lastUser && lastUser.content.includes("```notch-actions");
          if (!failed && !controller.signal.aborted && parsed.actions.length > 0 && !quoted) {
            const run = await runAppActions(parsed.actions);
            if (run.labels.length > 0) effects = run.labels;
            if (run.errors.length > 0) askError.set(t("Aktion fehlgeschlagen: {e}", { e: run.errors[0] }));
          }
        }
        chat.set((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, content, duration: elapsed, ...(effects ? { effects } : {}) };
          }
          return next;
        });
        askStreaming.set(false);
        activeAbort = null;
        persistCurrent();
      }
    }
  };

  const send = (text: string) => {
    const prompt = text.trim();
    if (!prompt || askStreaming.get()) return;
    setDraft("");
    void runTurn([...chat.get(), { role: "user", content: prompt }]);
  };

  /** Drops the assistant reply at `index` (and anything after it) and reruns the last user prompt. */
  const regenerate = (index: number) => {
    if (askStreaming.get()) return;
    // Drop the server-side memory too; the rerun must not see the discarded answer.
    void resetOpenCodeSession();
    const history = chat.get().slice(0, index);
    let lastUser = history.length - 1;
    while (lastUser >= 0 && history[lastUser].role !== "user") lastUser -= 1;
    if (lastUser < 0) return;
    void runTurn(history.slice(0, lastUser + 1));
  };

  const scrollToBottom = () => {
    stick.current = true;
    setAtBottom(true);
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  };

  const runQuick = (q: (typeof quick)[number]) => {
    const latest = clipboard.get().find((c) => c.kind === "text" || c.kind === "link");
    if (!latest) {
      askError.set(t("Zuerst einen Text kopieren – die Schnellaktionen arbeiten mit der Zwischenablage."));
      return;
    }
    void send(q.prompt(latest.text));
  };

  const newChat = () => {
    streamSeq += 1;
    activeAbort?.abort();
    activeAbort = null;
    askStreaming.set(false);
    chat.set([]);
    askError.set(null);
    activeSavedId.set(null);
    stick.current = true;
    setAtBottom(true);
    void resetOpenCodeSession();
    input.current?.focus({ preventScroll: true });
  };

  const loadChat = (id: string) => {
    const c = saved.find((x) => x.id === id);
    if (!c) return;
    streamSeq += 1;
    activeAbort?.abort();
    activeAbort = null;
    askStreaming.set(false);
    chat.set(c.messages);
    activeSavedId.set(id);
    // Different conversation: drop the server-side session so the next turn
    // does not answer from the previous chat's memory.
    void resetOpenCodeSession();
    // Remount the bubbles so per-message UI state (thinking open, copied) does
    // not leak from the chat that was open before.
    setChatEpoch((n) => n + 1);
    askError.set(null);
    stick.current = true;
    input.current?.focus({ preventScroll: true });
  };

  const deleteChat = (id: string) => {
    savedChats.set((prev) => prev.filter((c) => c.id !== id));
    if (activeSavedId.get() === id) {
      activeSavedId.set(null);
      chat.set([]);
    }
  };

  const clearAll = () => {
    streamSeq += 1;
    activeAbort?.abort();
    activeAbort = null;
    askStreaming.set(false);
    chat.set([]);
    askError.set(null);
    activeSavedId.set(null);
    stick.current = true;
    void resetOpenCodeSession();
    if (saveHistory) savedChats.set([]);
    input.current?.focus({ preventScroll: true });
  };

  const formRtl = isRtl(draft);

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-2">
      <HeaderActions>
        {provider === "opencode" ? (
          <ModelSelect
            value={config.model}
            onChange={(model) => updateAsk("opencode", { model })}
            width="w-40"
            variant="bare"
            menuAlign="right"
          />
        ) : (
          <button
            onClick={() => navigate("settings", "ask")}
            title={t("Modell in den Einstellungen ändern")}
            className="mr-1 max-w-40 truncate text-caption text-label-3 hover:text-label-2"
          >
            {modelLabel(config.model) || providerInfo[provider].label}
          </button>
        )}
        {saveHistory && (
          <ChatHistory chats={saved} activeId={aid} onOpen={loadChat} onDelete={deleteChat} />
        )}
        <button
          onClick={newChat}
          title={t("Neuer Chat")}
          className="pressable flex size-6 shrink-0 items-center justify-center rounded-full bg-fill-2 text-label-2 hover:bg-fill-3"
        >
          <Plus size={13} weight="bold" />
        </button>
        <HeaderButton
          label={t("Chat leeren")}
          disabled={messages.length === 0}
          onClick={clearAll}
        >
          <X size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>

      <div className="relative min-h-0 flex-1">
        <div
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            stick.current = bottom;
            setAtBottom(bottom);
          }}
          className="h-full overflow-y-auto [scrollbar-width:none]"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-fill-1 text-label-3">
                <Sparkle size={18} weight="regular" />
              </span>
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
              <span className="text-caption text-label-4">{t("Enter zum Senden · Shift+Enter für Zeilenumbruch")}</span>
              <span className="text-caption text-label-4">{t("Auch: „Timer 10 Minuten“ · „Aufgabe: Milch kaufen“ · „Notiz: Einkaufsliste“")}</span>
            </div>
          ) : (
            <div className="flex flex-col pt-2 pb-2">
              {messages.map((m, i) => (
                <Bubble
                  key={`${chatEpoch}:${i}`}
                  message={m}
                  showThinking={showThinking}
                  streaming={streaming && i === messages.length - 1}
                  spacing={i === 0 ? "" : m.role === "user" ? "mt-5" : "mt-2"}
                  onResend={send}
                  onRegenerate={
                    !streaming && i === messages.length - 1 && m.role === "assistant"
                      ? () => regenerate(i)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
        <AnimatePresence>
          {!atBottom && messages.length > 0 && (
            <motion.button
              type="button"
              aria-label={t("Zum Ende scrollen")}
              title={t("Zum Ende scrollen")}
              onClick={scrollToBottom}
              initial={{ opacity: 0, transform: "translateY(4px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={{ opacity: 0 }}
              transition={fade}
              className="pressable absolute inset-x-0 bottom-2 mx-auto flex size-6 items-center justify-center rounded-full bg-fill-3 text-label-2 shadow-sm hover:text-label"
            >
              <ArrowDown size={12} weight="bold" />
            </motion.button>
          )}
        </AnimatePresence>
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
        dir={formRtl ? "rtl" : "ltr"}
        className="mt-2 flex items-end gap-2 rounded-[16px] bg-fill-1 py-1.5 pe-1.5 ps-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          ref={input}
          value={draft}
          rows={1}
          dir="auto"
          placeholder={t("Frag etwas …")}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 66)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(draft);
            }
          }}
          className="max-h-[66px] min-h-[22px] flex-1 resize-none bg-transparent py-0.5 text-body leading-[1.7] text-label outline-none [scrollbar-width:none] placeholder:text-label-4"
        />
        {streaming ? (
          <button type="button" aria-label={t("Stopp")} onClick={() => activeAbort?.abort()} className="pressable flex size-6 shrink-0 items-center justify-center rounded-full bg-fill-3 text-label">
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

function Bubble({
  message,
  streaming,
  showThinking,
  spacing,
  onResend,
  onRegenerate,
}: {
  message: ChatMessage;
  streaming: boolean;
  showThinking: boolean;
  spacing: string;
  onResend: (text: string) => void;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(() => isShortThinking(message.reasoning ?? ""));
  // A manual toggle wins over the automatic open/collapse for the rest of the turn.
  const thinkingTouched = useRef(false);
  useEffect(() => {
    if (thinkingTouched.current) return;
    setThinkingOpen(isShortThinking(message.reasoning ?? ""));
  }, [message.reasoning]);
  const user = message.role === "user";
  const shown = user ? message.content : visibleAnswer(message.content);
  const rtl = isRtl(shown);
  const resend = () => {
    if (askStreaming.get()) return;
    void onResend(message.content);
  };
  const copy = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(shown).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {
        // Clipboard blocked (permissions): leave the reply on screen, no feedback needed.
      },
    );
  };
  return (
    <motion.div
      className={`group flex ${user ? "justify-end" : "justify-start"} ${spacing}`}
      initial={{ opacity: 0, transform: "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={content.enter}
    >
      {/* The bubble holds only the text; Copy/Resend sit underneath, outside it. */}
      <div className={`flex min-w-0 flex-col ${user ? "max-w-[85%] items-end" : "w-full items-stretch"}`}>
        <div
          dir={rtl ? "rtl" : "ltr"}
          className={`relative break-words text-body ${rtl ? "leading-[1.7]" : ""} ${
            user
              ? `whitespace-pre-wrap rounded-[14px] bg-fill-2 px-3.5 py-2 text-start text-label ${rtl ? "rounded-bl-[4px]" : "rounded-br-[4px]"}`
              : "w-full px-1 text-start text-label-2"
          }`}
        >
          {!user && showThinking && message.reasoning && (
            <div
              dir={isRtl(message.reasoning) ? "rtl" : "ltr"}
              className="mb-2.5 overflow-hidden rounded-[10px] border border-label-4/15 bg-fill-1/40"
            >
              <button
                aria-expanded={thinkingOpen}
                onClick={() => {
                  thinkingTouched.current = true;
                  setThinkingOpen((o) => !o);
                }}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-caption font-medium text-label-3 hover:text-label-2"
              >
                <CaretDown
                  size={12}
                  weight="bold"
                  className={`transition-transform duration-200 ${thinkingOpen ? "" : "-rotate-90"}`}
                />
                {t("Denken")}
                {!shown && streaming && (
                  <span className="ms-1 inline-block size-1.5 animate-pulse rounded-full bg-label-3" />
                )}
                <span className="ms-auto text-[10px] text-label-4">{message.reasoning.length} {t("Zeichen")}</span>
              </button>
              {thinkingOpen && (
                <ScrollArea className="max-h-40 border-t border-label-4/10 py-2 ps-3 pe-4 text-[11px] leading-relaxed text-label-3 [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {message.reasoning}
                </ScrollArea>
              )}
            </div>
          )}
          {user ? message.content : (
            streaming && !shown && !(showThinking && message.reasoning) ? (
              <span className="inline-flex items-center gap-1.5 text-label-3">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-label-3" />
                {t("Denkt nach …")}
              </span>
            ) : (
              <MarkdownText text={shown} dir={rtl ? "rtl" : "ltr"} />
            )
          )}
          {streaming && shown && <span className="ms-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse bg-label-2" />}
          {!user && message.effects && message.effects.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-caption text-label-4">
              <CheckCircle size={11} weight="fill" className="shrink-0 text-green" />
              <span className="min-w-0 truncate">{t("Ausgeführt: {x}", { x: message.effects.join(" · ") })}</span>
            </div>
          )}
        </div>
        {!streaming && shown && (
          user ? (
            /* A compact floating pill: no labels, so the bubble stays clean. */
            <div
              dir="ltr"
              className="pointer-events-none mt-1.5 me-1 flex items-center gap-0.5 rounded-full bg-elevated p-0.5 opacity-0 shadow-[0_10px_26px_rgb(0_0_0/0.65)] ring-1 ring-separator transition-opacity group-focus-within:pointer-events-auto group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <button
                aria-label={copied ? t("Kopiert") : t("Kopieren")}
                title={copied ? t("Kopiert") : t("Kopieren")}
                onClick={copy}
                className="pressable grid size-6 place-items-center rounded-full text-label-3 hover:bg-fill-2 hover:text-label-2"
              >
                {copied ? <Check size={12} weight="bold" className="text-green" /> : <Copy size={12} weight="bold" />}
              </button>
              <button
                aria-label={t("Erneut senden")}
                title={t("Erneut senden")}
                onClick={resend}
                className="pressable grid size-6 place-items-center rounded-full text-label-3 hover:bg-fill-2 hover:text-label-2"
              >
                <ArrowUp size={12} weight="bold" />
              </button>
            </div>
          ) : (
            <div
              dir="ltr"
              className="pointer-events-none mt-1.5 flex w-full items-center gap-2 px-1 text-caption text-label-4 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <button
                aria-label={t("Kopieren")}
                onClick={copy}
                className="pressable flex items-center gap-1 hover:text-label-2"
              >
                {copied ? <Check size={11} weight="bold" /> : <Copy size={11} weight="bold" />} {copied ? t("Kopiert") : t("Kopieren")}
              </button>
              {onRegenerate && (
                <button
                  aria-label={t("Neu generieren")}
                  onClick={onRegenerate}
                  className="pressable flex items-center gap-1 hover:text-label-2"
                >
                  <ArrowsClockwise size={11} weight="bold" /> {t("Neu generieren")}
                </button>
              )}
              {message.duration != null && (
                <span className="ms-auto tabular text-label-4">{message.duration.toFixed(1)} s</span>
              )}
            </div>
          )
        )}
      </div>
    </motion.div>
  );
}
