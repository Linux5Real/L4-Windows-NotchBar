import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { CaretUpDown, Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import { popover } from "../../design/motion";
import { t } from "../../i18n";
import { nav } from "../../notch/nav";
import {
  listOpenCodeModels,
  modelLabel,
  modelOptionLabel,
  providerLabel,
  type OpenCodeModel,
} from "./providers";

const providerOrder: Record<string, number> = {
  opencode: 0,
  "opencode-go": 1,
  openai: 2,
  anthropic: 3,
  google: 4,
  "google-vertex": 5,
  openrouter: 6,
};

/** Providers in a stable product order, unknown ones alphabetically. */
function sortProviders(list: Iterable<string>): string[] {
  return [...list].sort(
    (a, b) => (providerOrder[a] ?? 99) - (providerOrder[b] ?? 99) || a.localeCompare(b),
  );
}

/** "128K", "256K", "1M" — the context window at a glance. */
function contextLabel(tokens: number): string {
  if (!tokens || !Number.isFinite(tokens)) return "";
  if (tokens >= 1_000_000) {
    return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** Matches a model against the search box: name, id or provider. */
function matchesModel(model: OpenCodeModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    modelOptionLabel(model).toLowerCase().includes(q) ||
    model.id.toLowerCase().includes(q) ||
    providerLabel(model.provider).toLowerCase().includes(q)
  );
}

/**
 * Model picker: providers on the left, their models on the right, with a
 * search that spans every provider. The menu is a wide, short sheet — width
 * capped at 440px, height at 240px — instead of the old narrow column.
 * Opening focuses the search; while a query is active the rail narrows to
 * providers with matches and shows their count.
 */
export function ModelSelect({
  value,
  onChange,
  width = "w-52",
  variant = "default",
  menuAlign,
  menuMaxHeight = 240,
}: {
  value: string;
  onChange: (model: string) => void;
  width?: string;
  variant?: "default" | "bare";
  menuAlign?: "left" | "right";
  menuMaxHeight?: number;
}) {
  const [catalog, setCatalog] = useState<OpenCodeModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>("");
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    up: boolean;
    maxHeight: number;
  } | null>(null);

  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const load = () => {
    if (catalog || loading) return;
    setLoading(true);
    setFailed(false);
    void listOpenCodeModels()
      .then((res) => {
        setCatalog(res);
        const cur = res.find((m) => m.id === value);
        if (cur) setTab(cur.provider);
        else if (res.length) setTab(res[0].provider);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  };

  const toggle = () => {
    if (!open) {
      load();
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  const visibleModels = catalog ? catalog.filter((m) => matchesModel(m, query)) : [];
  const counts = new Map<string, number>();
  for (const m of visibleModels) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  const providers = sortProviders(counts.keys());

  const modelsForTab = visibleModels.filter((m) => m.provider === tab);

  // The menu is content-adaptive, but a max-height on the menu alone does not
  // bound the grid's implicit row: the columns would grow past it and never
  // scroll. So the grid gets a definite height, estimated from the row counts
  // (provider row ~28px, model row 32px) and capped by the measured room.
  const gridHeight = Math.max(
    60,
    Math.min(
      Math.max(providers.length * 28, modelsForTab.length * 32) + 12,
      Math.max(60, (pos?.maxHeight ?? menuMaxHeight) - 44),
    ),
  );

  const current = catalog?.find((m) => m.id === value);

  const measure = () => {
    const trigger = ref.current?.getBoundingClientRect();
    if (!trigger) return;
    const bounds = ref.current?.closest("[data-notch-hit]")?.getBoundingClientRect();
    const minY = (bounds?.top ?? 0) + 8;
    const maxY = Math.min(bounds?.bottom ?? window.innerHeight, window.innerHeight) - 8;
    // The hit zone is 16px wider than the black body on each side. Keep the
    // wide sheet inside the body so it never clips at the notch edge.
    const bodyLeft = (bounds?.left ?? 0) + 16;
    const bodyRight = (bounds?.right ?? window.innerWidth) - 16;
    const wanted = Math.min(menuMaxHeight, 360);
    const below = maxY - trigger.bottom - 4;
    const above = trigger.top - minY - 4;
    const up = below < wanted && above > below;
    const room = up ? above : below;
    const width = Math.min(440, Math.max(trigger.width, bodyRight - bodyLeft - 16));
    const aligned = menuAlign === "right" ? trigger.right - width : trigger.left;
    const minLeft = bodyLeft + 8;
    const maxLeft = bodyRight - 8 - width;
    // A wide sheet anchored to a trigger that is not at the notch edge would
    // hit the clamp and hug one side; center it in the body instead.
    const left =
      aligned < minLeft || aligned > maxLeft
        ? Math.max(minLeft, Math.min((bodyLeft + bodyRight) / 2 - width / 2, maxLeft))
        : aligned;
    setPos({
      left,
      width,
      up,
      maxHeight: Math.max(120, Math.min(wanted, room)),
      ...(up ? { bottom: window.innerHeight - trigger.top + 4 } : { top: trigger.bottom + 4 }),
    });
  };

  useLayoutEffect(() => {
    if (open) measure();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const close = () => setOpen(false);
    const onScroll = (e: Event) => !menu.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Return focus to the trigger instead of dropping it on the document.
      ref.current?.querySelector("button")?.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", close);
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

  // Clear the search once the menu closes, so every open starts blank.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Opening always starts on the provider of the active model, even when the
  // menu was last used in another provider.
  useLayoutEffect(() => {
    if (!open || !catalog) return;
    const cur = catalog.find((m) => m.id === value);
    if (cur) setTab(cur.provider);
  }, [open, catalog, value]);

  // A query can match in another provider: never leave the list empty when
  // results exist elsewhere. Layout effect so the switch happens before paint,
  // otherwise the empty state flashes for one frame.
  useLayoutEffect(() => {
    if (!open || !catalog || !query.trim()) return;
    const matches = catalog.filter((m) => matchesModel(m, query));
    if (matches.length === 0) return;
    if (matches.some((m) => m.provider === tab)) return;
    // Jump to the top provider of the rail, not the first raw catalog match.
    setTab(sortProviders(matches.map((m) => m.provider))[0]);
  }, [open, catalog, query, tab]);

  const host = (ref.current?.closest("[data-notch-hit]") as HTMLElement | null) ?? document.body;

  const triggerLabel = current
    ? modelOptionLabel(current)
    : modelLabel(value, catalog) || t("Modell wählen");

  const bare = variant === "bare";

  return (
    <div ref={ref} className={`relative ${width}`}>
      <button
        aria-label={t("Modell ändern")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
        className={
          bare
            ? "pressable flex h-6 w-full items-center justify-between gap-1 rounded-full px-2 text-caption text-label-3 hover:bg-fill-1 hover:text-label-2"
            : "pressable pressable-fill flex h-7 w-full items-center justify-between gap-1 rounded-full bg-notch px-3 text-footnote text-label ring-1 ring-white/10"
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <CaretUpDown size={11} weight="bold" className="shrink-0 text-label-3" />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={menu}
              role="dialog"
              aria-label={t("Modell wählen")}
              className="pointer-events-auto fixed z-[60] flex flex-col overflow-hidden rounded-[22px] bg-notch shadow-[0_20px_50px_rgb(0_0_0/0.75)] ring-1 ring-white/10"
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
              {loading || (catalog === null && !failed) ? (
                <div className="flex h-8 items-center px-3 text-footnote text-label-3">
                  {t("Modelle werden geladen …")}
                </div>
              ) : failed ? (
                <div className="flex h-8 items-center px-3 text-footnote text-label-3">
                  {t("Modelle konnten nicht geladen werden")}
                </div>
              ) : (
                <>
                  {/* Search keeps the two-column layout but finds a model by
                      name, id or provider without switching tabs first. */}
                  <label className="mx-1.5 mt-1.5 flex items-center gap-1.5 rounded-[8px] bg-fill-1 px-2 py-1.5 focus-within:bg-fill-2">
                    <MagnifyingGlass size={11} weight="bold" className="shrink-0 text-label-3" />
                    <input
                      ref={search}
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("Modell suchen …")}
                      aria-label={t("Modell suchen …")}
                      spellCheck={false}
                      className="min-w-0 flex-1 bg-transparent text-footnote text-label outline-none placeholder:text-label-3"
                    />
                    {query && (
                      <button
                        type="button"
                        aria-label={t("Entfernen")}
                        onClick={() => {
                          setQuery("");
                          search.current?.focus();
                        }}
                        className="text-label-3 hover:text-label-2"
                      >
                        <X size={10} weight="bold" />
                      </button>
                    )}
                  </label>
                  <div
                    className="grid min-h-0 grid-rows-[minmax(0,1fr)] grid-cols-[128px_1fr] divide-x divide-separator"
                    style={{ height: gridHeight }}
                  >
                    {/* Providers — during a search only those with matches, with
                        their count, so the result spread stays visible. */}
                    <div className="min-h-0 overflow-y-auto p-1.5 [scrollbar-width:none]">
                      {providers.length === 0 ? (
                        <div className="px-2 py-1.5 text-[11px] text-label-4">—</div>
                      ) : (
                        providers.map((p) => (
                          <button
                            key={p}
                            onClick={() => setTab(p)}
                            className={`flex w-full min-w-0 items-center gap-1 rounded-[8px] px-2 py-1.5 text-left text-[11px] font-medium transition-colors ${
                              tab === p ? "bg-fill-3 text-label" : "text-label-3 hover:bg-fill-1 hover:text-label-2"
                            }`}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {p === "opencode" ? "OpenCode" : p === "opencode-go" ? "OpenCode Go" : providerLabel(p)}
                            </span>
                            {query.trim() && (
                              <span className="shrink-0 tabular text-[9px] text-label-4">{counts.get(p)}</span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                    {/* Models */}
                    <div className="min-h-0 overflow-y-auto p-1.5 [scrollbar-width:none]">
                      {modelsForTab.length === 0 ? (
                        <div className="flex h-7 items-center px-2 text-footnote text-label-3">
                          {t("Keine Modelle gefunden")}
                        </div>
                      ) : (
                        modelsForTab.map((model) => {
                          const selected = model.id === value;
                          const context = contextLabel(model.context);
                          return (
                            <button
                              key={model.id}
                              title={modelOptionLabel(model)}
                              onClick={() => {
                                onChange(model.id);
                                setOpen(false);
                              }}
                              className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-[8px] px-2 text-left transition-colors hover:bg-fill-2 ${
                                selected ? "bg-fill-2/60 text-label" : "text-label-2"
                              }`}
                            >
                              <span className="min-w-0 flex-1 truncate text-footnote">
                                {modelOptionLabel(model)}
                              </span>
                              {context && (
                                <span className="shrink-0 tabular text-[9px] text-label-4">{context}</span>
                              )}
                              {selected && <Check size={12} weight="bold" className="shrink-0 text-label" />}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        host,
      )}
    </div>
  );
}
