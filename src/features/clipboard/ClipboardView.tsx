import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowsOutSimple,
  Check,
  Copy,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileDoc,
  FilePdf,
  FileVideo,
  FileXls,
  Files,
  Folder,
  ImageSquare,
  LinkSimple,
  TextAa,
  Trash,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { content, fade, springs } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { MAX_SIZE, requestSize } from "../../notch/size";
import { findTab } from "../../notch/tabs";
import { clipboard, useClipboard, type ClipItem, type ClipPreview } from "../../platform/clipboard";
import { Segmented } from "../../ui/controls";
import { t } from "../../i18n";

const kindIcon: Record<ClipItem["kind"], Icon> = {
  text: TextAa,
  link: LinkSimple,
  image: ImageSquare,
  files: Files,
};

type Filter = "all" | "text" | "link" | "image" | "files";
const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "Alle" },
  { value: "text", label: "Text" },
  { value: "link", label: "Links" },
  { value: "image", label: "Bilder" },
  { value: "files", label: "Dateien" },
];

/** Height of the card row; the image preview attaches below it. */
const ROW_H = 146;
const PREVIEW_MAX_H = 290;
/** Gap + row below the image (size, buttons). */
const PREVIEW_CHROME = 46;

type LoadedPreview = ClipPreview & { w: number; h: number };

/**
 * History as a horizontal card row, newest on the left. The wheel scrolls sideways,
 * edges fade out. Click copies back, × removes.
 * Images: click opens a large preview; the notch grows down smoothly for it.
 */
export function ClipboardView() {
  const all = useClipboard();
  const now = useNow(30_000);
  const scroller = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const items = filter === "all" ? all : all.filter((i) => i.kind === filter || (filter === "image" && !!i.thumbnail));
  const preview = usePreview(previewId);

  // Drop the preview when its entry disappears.
  useEffect(() => {
    if (previewId !== null && !all.some((i) => i.id === previewId)) setPreviewId(null);
  }, [all, previewId]);

  // Vertical wheel → horizontal scroll.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [all.length === 0]);

  const copy = async (id: number) => {
    await clipboard.copy(id);
    setCopied(id);
    scroller.current?.scrollTo({ left: 0, behavior: "smooth" });
    window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
  };

  if (all.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-0.5 pb-2">
        <span className="text-body text-label-2">{t("Noch nichts kopiert")}</span>
        <span className="text-caption text-label-3">{t("Text, Links, Bilder und Dateien erscheinen hier")}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <HeaderActions>
        <Segmented id="clip-filter" size="sm" value={filter} onChange={setFilter} options={filters.map((f) => ({ ...f, label: t(f.label) }))} />
        <HeaderButton
          label={t("Alle löschen")}
          onClick={() => {
            setPreviewId(null);
            clipboard.clear();
          }}
        >
          <Trash size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>

      <div
        ref={scroller}
        className="flex shrink-0 gap-2 overflow-x-auto px-4 pt-1 [scrollbar-width:none]"
        style={{ height: ROW_H, maskImage: "linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 24px), transparent)" }}
      >
        {items.length === 0 && <div className="flex w-full items-center justify-center text-body text-label-3">{t("Nichts in dieser Kategorie")}</div>}
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item) => (
            <motion.div
              key={item.id}
              layout
              transition={springs.snappy}
              initial={{ opacity: 0, transform: "scale(0.94)" }}
              animate={{ opacity: 1, transform: "scale(1)" }}
              exit={{ opacity: 0, transform: "scale(0.94)", transition: fade }}
              className="group relative h-full w-[128px] shrink-0"
            >
              <Card
                item={item}
                now={now}
                copied={copied === item.id}
                selected={previewId === item.id}
                onClick={() => (item.thumbnail ? setPreviewId((p) => (p === item.id ? null : item.id)) : void copy(item.id))}
              />
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                {item.thumbnail && <CardButton label={t("Kopieren")} icon={Copy} onClick={() => void copy(item.id)} />}
                <CardButton label={t("Entfernen")} icon={X} onClick={() => clipboard.remove(item.id)} />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {previewId !== null && preview && (
          <PreviewPane key="preview" preview={preview} onCopy={() => void copy(previewId)} onClose={() => setPreviewId(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

function CardButton({ label, icon: I, onClick }: { label: string; icon: Icon; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className="pressable flex size-5 items-center justify-center rounded-full bg-fill-3 text-label-2 backdrop-blur-md hover:text-label"
    >
      <I size={10} weight="bold" />
    </button>
  );
}

/**
 * Loads the large preview and tells the notch the right height:
 * the image as large as its aspect ratio allows, at most PREVIEW_MAX_H tall.
 */
function usePreview(id: number | null): LoadedPreview | null {
  const [data, setData] = useState<LoadedPreview | null>(null);
  useEffect(() => {
    if (id === null) {
      setData(null);
      requestSize("clipboard", null);
      return;
    }
    let alive = true;
    void clipboard.preview(id).then((p) => {
      if (!alive || !p) return;
      const base = findTab("clipboard")!.size;
      // As tall as possible without growing past the window.
      const h = Math.min(PREVIEW_MAX_H, MAX_SIZE.h - base.h - PREVIEW_CHROME, ((base.w - 32) * p.height) / p.width);
      setData({ ...p, w: (h * p.width) / p.height, h });
      requestSize("clipboard", { w: base.w, h: base.h + h + PREVIEW_CHROME });
    });
    return () => {
      alive = false;
    };
  }, [id]);
  useEffect(() => () => requestSize("clipboard", null), []);
  return data;
}

function PreviewPane({ preview, onCopy, onClose }: { preview: LoadedPreview; onCopy: () => void; onClose: () => void }) {
  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col items-center gap-1.5 px-4 pt-2.5"
      initial={{ opacity: 0, filter: "blur(6px)", transform: "translateY(-6px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transform: "translateY(0px)", transition: { ...content.enter, delay: 0.08 } }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      {/* Image change: crossfade on top of each other, the area itself stays put. */}
      <div className="relative" style={{ width: preview.w, height: preview.h }}>
        <AnimatePresence initial={false}>
          <motion.img
            key={preview.src}
            src={preview.src}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full rounded-[12px] object-contain"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          />
        </AnimatePresence>
      </div>
      <div className="flex w-full items-center justify-between" style={{ maxWidth: Math.max(preview.w, 240) }}>
        <span className="tabular flex items-center gap-1 text-caption text-label-3">
          <ArrowsOutSimple size={11} weight="bold" /> {preview.width} × {preview.height}
        </span>
        <div className="flex gap-0.5">
          <HeaderButton label={t("Kopieren")} onClick={onCopy}>
            <Copy size={13} weight="bold" />
          </HeaderButton>
          <HeaderButton label={t("Vorschau schließen")} onClick={onClose}>
            <X size={13} weight="bold" />
          </HeaderButton>
        </div>
      </div>
    </motion.div>
  );
}

function Card(props: { item: ClipItem; now: number; copied: boolean; selected: boolean; onClick: () => void }) {
  const { item, now, copied } = props;
  const KindIcon = kindIcon[item.kind];
  // Images and copied image files fill the card.
  const isImage = !!item.thumbnail;

  return (
    <button
      onClick={props.onClick}
      title={isImage ? t("Vorschau") : item.text}
      className={`pressable pressable-fill relative flex size-full flex-col justify-between overflow-hidden rounded-[14px] bg-fill-1 p-3 text-left ${
        props.selected ? "ring-2 ring-label ring-inset" : ""
      }`}
    >
      {isImage && (
        <>
          <img src={item.thumbnail!} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
          {/* Gradient so icon and time stay readable on any image. */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/50" />
        </>
      )}

      <div className="relative flex items-center justify-between text-label-3">
        <KindIcon size={14} weight="bold" className={isImage ? "text-label" : undefined} />
        <span className={`text-caption transition-opacity duration-150 group-hover:opacity-0 ${isImage ? "text-label-2" : ""}`}>
          {relative(item.copiedAt, now)}
        </span>
      </div>

      <Body item={item} />

      <AnimatePresence>
        {copied && (
          <motion.div
            className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/55 text-footnote font-medium text-label backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
          >
            <Check size={14} weight="bold" /> {t("Kopiert")}
          </motion.div>
        )}
      </AnimatePresence>
    </button>
  );
}

function Body({ item }: { item: ClipItem }) {
  switch (item.kind) {
    case "image":
      return <p className="relative text-caption font-medium text-label-2 tabular">{item.text}</p>;
    case "files": {
      const names = item.text.split("\n");
      const FileIcon = item.folders === names.length ? Folder : fileIcon(names[0]);
      return (
        <div className="relative min-w-0">
          {!item.thumbnail && <FileIcon size={26} weight="duotone" className="mb-1.5 text-label-2" />}
          <p className="line-clamp-2 text-footnote font-medium text-label [overflow-wrap:anywhere]">{names[0]}</p>
          {names.length > 1 && <p className="text-caption text-label-3">{t("+{n} weitere", { n: names.length - 1 })}</p>}
        </div>
      );
    }
    case "link": {
      const { host, rest } = splitUrl(item.text);
      return (
        <div className="relative min-w-0">
          <p className="truncate text-footnote font-semibold text-link">{host}</p>
          {rest && <p className="line-clamp-2 text-caption text-label-3 [overflow-wrap:anywhere]">{rest}</p>}
        </div>
      );
    }
    default:
      return <p className="relative line-clamp-3 text-footnote text-label-2 [overflow-wrap:anywhere]">{item.text}</p>;
  }
}

const fileTypes: [RegExp, Icon][] = [
  [/\.pdf$/i, FilePdf],
  [/\.(docx?|odt|rtf|txt|md|pages)$/i, FileDoc],
  [/\.(xlsx?|csv|ods|numbers)$/i, FileXls],
  [/\.(zip|rar|7z|tar|gz)$/i, FileArchive],
  [/\.(mp3|wav|flac|m4a|ogg|aac)$/i, FileAudio],
  [/\.(mp4|mov|mkv|avi|webm)$/i, FileVideo],
  [/\.(png|jpe?g|webp|gif|bmp|heic|svg|ico)$/i, ImageSquare],
  [/\.(tsx?|jsx?|rs|py|cs|json|html?|css|ya?ml|toml|sh|ps1)$/i, FileCode],
];

function fileIcon(name: string): Icon {
  return fileTypes.find(([re]) => re.test(name))?.[1] ?? File;
}

/** "https://www.github.com/a/b?x" → host "github.com", rest "/a/b?x". */
function splitUrl(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url.startsWith("www.") ? `https://${url}` : url);
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
    let decoded = rest;
    try {
      decoded = decodeURI(rest);
    } catch {
      // Invalid %-sequence → show it raw.
    }
    return { host: u.hostname.replace(/^www\./, ""), rest: decoded };
  } catch {
    return { host: url, rest: "" };
  }
}

function useNow(interval: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

function relative(time: number, now: number): string {
  const s = Math.max(0, (now - time) / 1000);
  if (s < 60) return t("Jetzt");
  if (s < 3600) return t("{n} Min.", { n: Math.floor(s / 60) });
  if (s < 86_400) return t("{n} Std.", { n: Math.floor(s / 3600) });
  return t("{n} T.", { n: Math.floor(s / 86_400) });
}
