import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowSquareOut, Check, ClipboardText, Copy, File, FileAudio, FileText, FileVideo, FolderOpen, ImageSquare, Table, Trash, Tray, X, type Icon } from "@phosphor-icons/react";
import { fade, springs } from "../../design/motion";
import { createStore } from "../../lib/store";
import { formatBytes } from "../../lib/format";
import { drop, pasteFiles, takeDropped, usePasteFiles } from "../../platform/drop";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { copyFiles, filePreview, openFile, probeFiles, revealFile, type DroppedFile, type FileKind } from "../../platform/services";
import { t } from "../../i18n";

/*
 * Ablage (File Shelf): Dateien auf die Notch legen, später mit einem Klick
 * öffnen, im Explorer zeigen oder per Strg+V woanders einfügen.
 * Gespeichert werden nur Verweise — die Dateien bleiben, wo sie sind.
 *
 * Dateien kommen per Drag & Drop oder Strg+V (auch Screenshots). Fällt etwas auf die
 * geschlossene Notch, landet es im zuletzt genutzten Datei-Tool.
 */
interface ShelfItem extends DroppedFile {
  addedAt: number;
}

const shelf = createStore<ShelfItem[]>([], { persist: "shelf" });
const MAX_ITEMS = 30;

const kindIcon: Record<FileKind, Icon> = { image: ImageSquare, audio: FileAudio, video: FileVideo, document: FileText, table: Table, other: File };

export function ShelfView() {
  const items = shelf.use();
  const { dragging, dropped } = drop.use();
  const [copied, setCopied] = useState<string | null>(null);
  const [nothing, setNothing] = useState(false);
  usePasteFiles(() => flash(setNothing));

  useEffect(() => {
    const paths = takeDropped();
    if (!paths?.length) return;
    void probeFiles(paths).then(({ files }) => {
      const now = Date.now();
      shelf.set((list) => {
        const fresh = files.filter((f) => !list.some((x) => x.path === f.path)).map((f) => ({ ...f, addedAt: now }));
        return [...fresh, ...list].slice(0, MAX_ITEMS);
      });
    });
  }, [dropped]);

  const copyAll = async (paths: string[], key: string) => {
    await copyFiles(paths);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  };

  if (items.length === 0) {
    return (
      <div className="h-full px-4 pt-1 pb-2">
        <motion.div
          className={`flex h-full flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed transition-colors duration-200 ${
            dragging ? "border-label-2 bg-fill-2" : "border-fill-3 bg-fill-1"
          }`}
          animate={{ transform: dragging ? "scale(1.015)" : "scale(1)" }}
          transition={springs.snappy}
        >
          <Tray size={22} weight="bold" className={dragging ? "text-label" : "text-label-3"} />
          <span className="text-body text-label-2">{dragging ? t("Loslassen zum Ablegen") : t("Dateien hierher ziehen")}</span>
          <PasteHint nothing={nothing} />
        </motion.div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col px-4 pt-1 pb-2">
      <HeaderActions>
        <span className="tabular mr-1 text-caption text-label-3">
          {items.length} {items.length === 1 ? t("Datei") : t("Dateien")}
        </span>
        <HeaderButton label={copied === "all" ? t("Kopiert") : t("Alle kopieren")} onClick={() => void copyAll(items.map((i) => i.path), "all")}>
          {copied === "all" ? <Check size={14} weight="bold" /> : <Copy size={14} weight="bold" />}
        </HeaderButton>
        <HeaderButton label={t("Ablage leeren")} onClick={() => shelf.set([])}>
          <Trash size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none]">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item) => (
            <motion.div
              key={item.path}
              layout
              transition={springs.snappy}
              initial={{ opacity: 0, transform: "scale(0.94)" }}
              animate={{ opacity: 1, transform: "scale(1)" }}
              exit={{ opacity: 0, transform: "scale(0.94)", transition: fade }}
              className="group relative h-full w-[112px] shrink-0"
            >
              <Card item={item} copied={copied === item.path} onCopy={() => void copyAll([item.path], item.path)} />
              <button
                aria-label={t("Entfernen")}
                onClick={() => shelf.set((l) => l.filter((x) => x.path !== item.path))}
                className="pressable absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-fill-3 text-label-2 opacity-0 backdrop-blur-md group-hover:opacity-100 hover:text-label"
              >
                <X size={10} weight="bold" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {dragging && (
          <motion.div
            className="pointer-events-none absolute inset-x-4 top-1 bottom-3 flex items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-label-2 bg-black/70 text-body text-label"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
          >
            {t("Loslassen zum Ablegen")}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Card({ item, copied, onCopy }: { item: ShelfItem; copied: boolean; onCopy: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const I = kindIcon[item.kind];
  useEffect(() => {
    if (item.kind === "image") void filePreview(item.path).then(setPreview);
  }, [item.path, item.kind]);

  return (
    <div className="relative flex size-full flex-col overflow-hidden rounded-[14px] bg-fill-1">
      <button
        onClick={() => void openFile(item.path)}
        title={t("{name} öffnen", { name: item.name })}
        className="pressable relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
        {preview ? (
          <img src={preview} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
        ) : (
          <I size={30} weight="duotone" className="text-label-2" />
        )}
      </button>
      <div className="px-2 pt-1.5 pb-1">
        <p className="truncate text-caption font-medium text-label" title={item.name}>{item.name}</p>
        <div className="flex items-center justify-between">
          <span className="tabular text-caption text-label-3">{formatBytes(item.size, 0)}</span>
          <span className="flex opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <IconBtn label={t("Im Explorer zeigen")} icon={FolderOpen} onClick={() => revealFile(item.path)} />
            <IconBtn label={copied ? t("Kopiert") : t("Kopieren")} icon={copied ? Check : Copy} onClick={onCopy} />
            <IconBtn label={t("Öffnen")} icon={ArrowSquareOut} onClick={() => void openFile(item.path)} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Zweiter Weg neben Drag & Drop — sichtbar, weil Strg+V nicht auffindbar ist. */
export function PasteHint({ nothing }: { nothing: boolean }) {
  return (
    <button onClick={() => void pasteFiles()} className="pressable flex items-center gap-1 text-caption text-label-3 hover:text-label-2">
      <ClipboardText size={12} weight="bold" />
      {nothing ? t("Keine Dateien in der Zwischenablage") : t("oder Strg+V zum Einfügen")}
    </button>
  );
}

function flash(set: (v: boolean) => void) {
  set(true);
  setTimeout(() => set(false), 1600);
}

function IconBtn({ label, icon: I, onClick }: { label: string; icon: Icon; onClick: () => void }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="pressable flex size-5 items-center justify-center text-label-3 hover:text-label">
      <I size={12} weight="bold" />
    </button>
  );
}
