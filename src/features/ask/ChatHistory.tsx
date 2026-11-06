import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ChatCircle, Trash } from "@phosphor-icons/react";
import { popover } from "../../design/motion";
import { t } from "../../i18n";
import { formatAgo } from "../../lib/format";
import { nav } from "../../notch/nav";
import { ScrollArea } from "../../ui/ScrollArea";
import type { SavedChat } from "./providers";

/**
 * Chat history behind the header's chat button.
 *
 * The trigger lives in the portaled notch header, so the list is a popover
 * portaled next to it: a black notch panel instead of a block that pushes the
 * conversation down. Each row shows its age and message count, the active chat
 * is highlighted, and deleting appears on hover so the list stays quiet.
 */
export function ChatHistory({
  chats,
  activeId,
  onOpen,
  onDelete,
}: {
  chats: SavedChat[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    up: boolean;
    maxHeight: number;
  } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const measure = () => {
    const trigger = ref.current?.getBoundingClientRect();
    if (!trigger) return;
    const bounds = ref.current?.closest("[data-notch-hit]")?.getBoundingClientRect();
    const minY = (bounds?.top ?? 0) + 8;
    const maxY = Math.min(bounds?.bottom ?? window.innerHeight, window.innerHeight) - 8;
    const width = Math.min(292, window.innerWidth - 16);
    const left = Math.min(
      Math.max(8, trigger.right - width),
      Math.max(8, window.innerWidth - width - 8),
    );
    const wanted = 320;
    const below = maxY - trigger.bottom - 6;
    const above = trigger.top - minY - 6;
    const up = below < 200 && above > below;
    setPos({
      left,
      width,
      up,
      maxHeight: Math.max(140, Math.min(wanted, up ? above : below)),
      ...(up ? { bottom: window.innerHeight - trigger.top + 6 } : { top: trigger.bottom + 6 }),
    });
  };

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, chats.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    const unsub = nav.subscribe(() => setOpen(false));
    return () => {
      unsub();
      setOpen(false);
    };
  }, []);

  const host = (ref.current?.closest("[data-notch-hit]") as HTMLElement | null) ?? document.body;
  // Newest activity first; the store keeps creation order for persistence.
  const ordered = [...chats].sort((a, b) => b.savedAt - a.savedAt);

  return (
    <>
      <button
        ref={ref}
        aria-label={t("Chats")}
        title={t("Chats")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={`pressable flex size-6 shrink-0 items-center justify-center rounded-full ${
          open ? "bg-fill-3 text-label" : "bg-fill-2 text-label-2 hover:bg-fill-3"
        }`}
      >
        <ChatCircle size={13} weight="bold" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={menu}
              role="dialog"
              aria-label={t("Chats")}
              className="pointer-events-auto fixed z-[60] flex flex-col overflow-hidden rounded-[18px] bg-notch shadow-[0_20px_50px_rgb(0_0_0/0.75)] ring-1 ring-white/10"
              style={{
                left: pos.left,
                width: pos.width,
                top: pos.top,
                bottom: pos.bottom,
                maxHeight: pos.maxHeight,
                transformOrigin: pos.up ? "50% 100%" : "50% 0",
              }}
              initial={{ opacity: 0, transform: `scale(0.96) translateY(${pos.up ? 2 : -2}px)` }}
              animate={{ opacity: 1, transform: "scale(1) translateY(0px)", transition: popover.enter }}
              exit={{ opacity: 0, transform: "scale(0.98)", transition: popover.exit }}
            >
              <div className="flex items-center justify-between border-b border-separator px-3 pt-2 pb-1.5">
                <span className="text-[10px] font-semibold tracking-[0.06em] text-label-3 uppercase">
                  {t("Chats")}
                </span>
                <span className="tabular text-[10px] text-label-3">{chats.length}</span>
              </div>
              {chats.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 pt-1 pb-5">
                  <span className="grid size-8 place-items-center rounded-full bg-fill-1 text-label-3">
                    <ChatCircle size={15} weight="regular" />
                  </span>
                  <span className="text-caption text-label-3">{t("Noch keine gespeicherten Chats")}</span>
                </div>
              ) : (
                <ScrollArea
                  className="px-1.5 pt-1 pb-1.5"
                  style={{ maxHeight: Math.max(96, pos.maxHeight - 34) }}
                >
                  {ordered.map((c) => {
                    const active = activeId === c.id;
                    return (
                      <div
                        key={c.id}
                        className={`group/chat flex items-center gap-1 rounded-[10px] pe-2 ps-2.5 transition-colors ${
                          active ? "bg-fill-2" : "hover:bg-fill-1"
                        }`}
                      >
                        <button
                          onClick={() => {
                            onOpen(c.id);
                            setOpen(false);
                          }}
                          className="min-w-0 flex-1 py-1.5 text-start"
                        >
                          <span
                            dir="auto"
                            className={`block truncate text-footnote ${active ? "text-label" : "text-label-2"}`}
                          >
                            {c.title}
                          </span>
                          <span className="mt-0.5 block truncate text-[10px] text-label-3">
                            {formatAgo(Date.now() - c.savedAt)} · {t("{n} Nachrichten", { n: c.messages.length })}
                          </span>
                        </button>
                        <button
                          onClick={() => onDelete(c.id)}
                          aria-label={t("Entfernen")}
                          title={t("Entfernen")}
                          className="pointer-events-none grid size-6 shrink-0 place-items-center rounded-full text-label-4 opacity-0 transition-opacity group-focus-within/chat:pointer-events-auto group-hover/chat:pointer-events-auto hover:bg-fill-2 hover:text-red group-focus-within/chat:opacity-100 group-hover/chat:opacity-100"
                        >
                          <Trash size={11} weight="bold" />
                        </button>
                      </div>
                    );
                  })}
                </ScrollArea>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        host,
      )}
    </>
  );
}
