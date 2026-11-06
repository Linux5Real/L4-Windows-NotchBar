import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowsLeftRight, CircleNotch, Copy, WarningCircle, X } from "@phosphor-icons/react";
import { fade, spin } from "../../design/motion";
import { t } from "../../i18n";
import { HeaderButton } from "../../notch/header";
import { Button, Select } from "../../ui/controls";
import { ScrollArea } from "../../ui/ScrollArea";
import { languages, languageLabel } from "./languages";
import { providerLabel, translate, type ProviderId } from "./providers";
import { translateState } from "./store";

type Status = "idle" | "busy" | "done" | "error";

/**
 * Translator with free public providers: no key, no setup. Typing translates
 * after a short pause; each provider in `providers.ts` steps in when the
 * previous one fails.
 */
export function TranslateView() {
  const state = translateState.use();
  const { from, to, input } = state;
  const [result, setResult] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [detected, setDetected] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<Status>("idle");
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const copiedTimer = useRef<number | undefined>(undefined);

  const set = (patch: Partial<typeof state>) => translateState.set((s) => ({ ...s, ...patch }));

  const sameLanguage = from !== "auto" && from === to;

  useEffect(() => {
    const text = input.trim();
    if (!text || sameLanguage) {
      setResult(null);
      setProvider(null);
      setDetected(undefined);
      setStatus("idle");
      return;
    }
    const ctrl = new AbortController();
    const handle = window.setTimeout(() => {
      setStatus("busy");
      void translate(text, from, to, ctrl.signal)
        .then((r) => {
          setResult(r.text);
          setProvider(r.provider);
          setDetected(r.detected);
          setStatus("done");
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setStatus("error");
        });
    }, 400);
    return () => {
      ctrl.abort();
      window.clearTimeout(handle);
    };
  }, [input, from, to, sameLanguage, attempt]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copy = () => {
    if (!result) return;
    void navigator.clipboard
      .writeText(result)
      .then(() => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  const clear = () => {
    set({ input: "" });
    setResult(null);
    setStatus("idle");
  };

  // With "auto" the detected language is what the swap needs; without it there is nothing to swap yet.
  const swapSource = from === "auto" ? detected : from;
  const canSwap = !!swapSource && swapSource !== to;
  // Swap languages and take the translation along as the new input (back-translation).
  const swap = () => {
    if (!canSwap) return;
    setResult(null);
    setStatus("busy");
    set({ from: to, to: swapSource!, input: result ?? input });
  };

  const sourceOptions = useMemo(
    () => [
      { value: "auto", label: t("Automatisch erkennen") },
      ...languages.filter((l) => l.code !== to).map((l) => ({ value: l.code, label: l.name })),
    ],
    [to],
  );
  const targetOptions = useMemo(() => languages.filter((l) => l.code !== from).map((l) => ({ value: l.code, label: l.name })), [from]);

  return (
    <div className="flex h-full flex-col gap-1 px-4 pt-1 pb-1">
      <div className="flex min-h-0 flex-1 gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[12px] bg-fill-1 p-2.5">
          <Select value={from} options={sourceOptions} onChange={(v) => set({ from: v })} width="w-full" ariaLabel={t("Sprache")} />
          <textarea
            value={input}
            autoFocus
            dir="auto"
            spellCheck={false}
            placeholder={t("Text eingeben …")}
            onChange={(e) => set({ input: e.target.value })}
            className="min-h-0 flex-1 resize-none bg-transparent text-body text-label outline-none [scrollbar-width:none] placeholder:text-label-4"
          />
        </div>

        <div className="flex w-7 shrink-0 flex-col items-center justify-center">
          <button
            aria-label={t("Tauschen")}
            title={t("Tauschen")}
            disabled={!canSwap}
            onClick={swap}
            className="pressable pressable-fill flex size-7 items-center justify-center rounded-full bg-fill-2 text-label-2 disabled:opacity-30"
          >
            <ArrowsLeftRight size={13} weight="bold" />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[12px] bg-fill-1 p-2.5">
          <Select value={to} options={targetOptions} onChange={(v) => set({ to: v })} width="w-full" ariaLabel={t("Sprache")} />
          <div className="relative min-h-0 flex-1">
            {status === "error" ? (
              <div className="absolute inset-0 flex flex-col items-start justify-center gap-2 px-1">
                <span className="flex items-start gap-1.5 text-caption text-label-2">
                  <WarningCircle size={13} weight="bold" className="mt-px shrink-0 text-red" />
                  {t("Keine Verbindung zu den Übersetzern – Internet prüfen")}
                </span>
                <Button onClick={() => setAttempt((a) => a + 1)}>{t("Erneut versuchen")}</Button>
              </div>
            ) : result ? (
              <div className="absolute inset-0 flex">
                <ScrollArea className="h-full w-full pe-3 text-body leading-5 whitespace-pre-wrap text-label [overflow-wrap:anywhere]">
                  <motion.span key={result} dir="auto" className="block" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade }}>
                    {result}
                  </motion.span>
                </ScrollArea>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-caption text-label-3">
                {status === "busy" ? t("Übersetze …") : t("Übersetzung erscheint hier")}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-1 px-1 text-caption text-label-3">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {status === "busy" && (
            <>
              <motion.span className="flex shrink-0 text-label-3" animate={{ rotate: 360 }} transition={spin}>
                <CircleNotch size={11} weight="bold" />
              </motion.span>
              {t("Übersetze …")}
            </>
          )}
          {status === "done" && provider && (
            <>
              {t("Übersetzt mit {p}", { p: providerLabel[provider] })}
              {detected && <> · {t("Erkannt: {l}", { l: languageLabel(detected) })}</>}
            </>
          )}
          {status === "idle" && !sameLanguage && t("Ohne Schlüssel · automatischer Anbieterwechsel")}
        </span>
        <span className="flex-1" />
        <AnimatePresence>
          {copied && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade }} exit={{ opacity: 0, transition: fade }}>
              {t("Kopiert")}
            </motion.span>
          )}
        </AnimatePresence>
        <HeaderButton label={t("Kopieren")} onClick={copy} disabled={!result}>
          <Copy size={13} weight="bold" />
        </HeaderButton>
        <HeaderButton label={t("Leeren")} onClick={clear} disabled={!input && !result}>
          <X size={13} weight="bold" />
        </HeaderButton>
      </div>
    </div>
  );
}
