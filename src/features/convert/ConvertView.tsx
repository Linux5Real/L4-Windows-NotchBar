import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowsLeftRight,
  CheckCircle,
  File,
  FileAudio,
  FileText,
  FileVideo,
  Table,
  FolderOpen,
  ImageSquare,
  Sparkle,
  UploadSimple,
  WarningCircle,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { content, fade, spin, springs } from "../../design/motion";
import { formatBytes } from "../../lib/format";
import { drop, takeDropped, usePasteFiles } from "../../platform/drop";
import { PasteHint } from "../shelf/ShelfView";
import { convertFiles, probeFiles, revealFile, type ConvertResult, type DroppedFile, type FileKind } from "../../platform/services";
import { Button, Segmented, Slider } from "../../ui/controls";
import { UnitsPanel } from "./units";
import { HeaderActions } from "../../notch/header";
import { t, tBackend } from "../../i18n";

const kindIcon: Record<FileKind, Icon> = { image: ImageSquare, audio: FileAudio, video: FileVideo, document: FileText, table: Table, other: File };

/**
 * Zielformate je Dateiart. Video → MP3 zieht die Tonspur heraus. DDS = Spiele-Textur
 * (BC3 mit Mipmaps). Dokumente: PDF-Eingabe liefert nur den Text; PDF-Ausgabe druckt Edge.
 */
const targets: Record<Exclude<FileKind, "other">, string[]> = {
  image: ["png", "jpg", "webp", "ico", "bmp", "dds"],
  audio: ["mp3", "m4a", "wav", "flac"],
  video: ["mp4", "webm", "gif", "mp3"],
  document: ["pdf", "docx", "txt", "md", "html"],
  table: ["xlsx", "csv", "pdf", "json", "html"],
};

const sizes = [
  { value: "0", label: "Original" },
  { value: "2048", label: "2048" },
  { value: "1024", label: "1024" },
  { value: "512", label: "512" },
];

type Mode = "files" | "units";

export function ConvertView() {
  const [mode, setMode] = useState<Mode>("files");
  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-1">
      <HeaderActions>
        <Segmented
          id="convert-mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "files", label: t("Dateien") },
            { value: "units", label: t("Einheiten") },
          ]}
        />
      </HeaderActions>
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={mode}
            className="absolute inset-0"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            {mode === "files" ? <FilesPanel /> : <UnitsPanel />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function FilesPanel() {
  const { dragging } = drop.use();
  const [files, setFiles] = useState<DroppedFile[]>([]);
  const [ffmpeg, setFfmpeg] = useState(true);
  const [target, setTarget] = useState<string | null>(null);
  const [quality, setQuality] = useState(85);
  const [size, setSize] = useState("0");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ConvertResult[] | null>(null);
  const [nothing, setNothing] = useState(false);
  usePasteFiles(() => {
    setNothing(true);
    setTimeout(() => setNothing(false), 1600);
  });

  // Dateien übernehmen, sobald welche auf die Notch fallen (auch wenn sie vorher zu war).
  const dropped = drop.use().dropped;
  useEffect(() => {
    const paths = takeDropped();
    if (!paths?.length) return;
    void probeFiles(paths).then((p) => {
      setFiles(p.files);
      setFfmpeg(p.ffmpeg);
      setResults(null);
      const kind = commonKind(p.files);
      // Vorauswahl: ein Format, das noch keine der Dateien hat.
      setTarget(kind ? (targets[kind].find((t) => !p.files.some((f) => sameFormat(f.ext, t))) ?? targets[kind][0]) : null);
    });
  }, [dropped]);

  const kind = commonKind(files);
  const options = kind ? targets[kind] : [];
  const needsFfmpeg = kind === "audio" || kind === "video";
  const showQuality = target === "jpg" || (needsFfmpeg && target !== "wav" && target !== "flac");

  // Dateien, die schon im Zielformat sind, werden übersprungen statt als Fehler gezählt.
  const pending = target ? files.filter((f) => !sameFormat(f.ext, target)) : [];

  const run = async () => {
    if (!target || pending.length === 0) return;
    setBusy(true);
    setResults(await convertFiles(pending.map((f) => f.path), target, quality, kind === "image" && size !== "0" ? Number(size) : null));
    setBusy(false);
  };

  const reset = () => {
    setFiles([]);
    setResults(null);
    setTarget(null);
  };

  if (files.length === 0) {
    return (
      <motion.div
        className={`flex h-full flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed transition-colors duration-200 ${
          dragging ? "border-label-2 bg-fill-2" : "border-fill-3 bg-fill-1"
        }`}
        animate={{ transform: dragging ? "scale(1.015)" : "scale(1)" }}
        transition={springs.snappy}
      >
        <UploadSimple size={22} weight="bold" className={dragging ? "text-label" : "text-label-3"} />
        <span className="text-body text-label-2">{dragging ? t("Loslassen zum Umwandeln") : t("Bilder, Audio, Video, Dokumente oder Tabellen hierher ziehen")}</span>
        <PasteHint nothing={nothing} />
      </motion.div>
    );
  }

  const done = results?.filter((r) => r.output) ?? [];
  const failed = results?.filter((r) => r.error) ?? [];

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] bg-fill-1 [scrollbar-width:none]">
        {files.map((f) => {
          const I = kindIcon[f.kind];
          const r = results?.find((x) => x.input === f.path);
          const skipped = !!target && sameFormat(f.ext, target);
          return (
            <div key={f.path} className="flex h-8 items-center gap-2.5 border-b border-separator px-3 last:border-0">
              <I size={15} weight="duotone" className={`shrink-0 ${skipped ? "text-label-4" : "text-label-2"}`} />
              <span className={`min-w-0 flex-1 truncate text-footnote transition-colors duration-150 ${skipped ? "text-label-3" : "text-label"}`}>{f.name}</span>
              {skipped && <span className="text-caption text-label-4">schon {target?.toUpperCase()}</span>}
              <span className="tabular text-caption text-label-3">{formatBytes(f.size)}</span>
              <span className="flex w-4 justify-center">
                {busy && !r && !skipped && (
                  <motion.span className="flex text-label-3" animate={{ rotate: 360 }} transition={spin}>
                    <Sparkle size={12} weight="fill" />
                  </motion.span>
                )}
                {r?.output && <CheckCircle size={14} weight="fill" className="text-green" />}
                {r?.error && (
                  <span title={tBackend(r.error)}>
                    <WarningCircle size={14} weight="fill" className="text-red" />
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {results ? (
          <motion.div
            key="result"
            className="flex items-center gap-2"
            initial={{ opacity: 0, transform: "translateY(4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)", transition: content.enter }}
            exit={{ opacity: 0, transition: content.exit }}
          >
            <span className="min-w-0 flex-1 truncate text-footnote text-label-2">
              {done.length > 0 && t(done.length === 1 ? "{n} Datei umgewandelt" : "{n} Dateien umgewandelt", { n: done.length })}
              {failed.length > 0 && <span className="text-red">{done.length ? " · " : ""}{t("{n} fehlgeschlagen", { n: failed.length })} – {tBackend(failed[0].error!)}</span>}
            </span>
            {done[0]?.output && (
              <Button icon={FolderOpen} onClick={() => revealFile(done[0].output!)}>
                Anzeigen
              </Button>
            )}
            <Button onClick={reset}>{t("Neu")}</Button>
          </motion.div>
        ) : (
          <motion.div key="options" className="flex flex-col gap-2" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: content.enter }} exit={{ opacity: 0, transition: content.exit }}>
            {!kind ? (
              <div className="text-caption text-label-3">{t("Gemischte oder unbekannte Dateiarten – bitte nur eine Art auf einmal (z. B. nur Bilder oder nur Dokumente).")}</div>
            ) : needsFfmpeg && !ffmpeg ? (
              <div className="text-caption text-label-3">
                {t("Für Audio/Video wird ffmpeg gebraucht:")} <span className="font-mono text-label-2">winget install Gyan.FFmpeg</span>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <ArrowsLeftRight size={13} weight="bold" className="mr-1 text-label-3" />
                {options.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTarget(t)}
                    className={`pressable pressable-fill relative h-6 rounded-full px-2.5 text-caption font-semibold uppercase ${t === target ? "text-black" : "text-label-2"}`}
                  >
                    {t === target && <motion.span layoutId="convert-target" className="absolute inset-0 rounded-full bg-label" transition={springs.snappy} />}
                    <span className="relative">{t}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3">
              {kind === "image" && (
                <Segmented id="convert-size" size="sm" value={size} onChange={setSize} options={sizes.map((o) => ({ ...o, label: t(o.label) }))} />
              )}
              {showQuality && (
                <div className="flex flex-1 items-center gap-2">
                  <span className="text-caption text-label-3">{t("Qualität")}</span>
                  <Slider label={t("Qualität")} value={quality} min={30} max={100} step={5} onChange={setQuality} />
                  <span className="tabular w-7 text-right text-caption text-label-2">{quality}</span>
                </div>
              )}
              <div className="ml-auto flex gap-1.5">
                <button aria-label={t("Leeren")} onClick={reset} className="pressable pressable-fill flex size-7 items-center justify-center rounded-full text-label-3">
                  <X size={12} weight="bold" />
                </button>
                <Button primary disabled={!target || busy || pending.length === 0 || (needsFfmpeg && !ffmpeg)} onClick={() => void run()}>
                  {busy ? t("Wandle um …") : pending.length > 1 ? `${pending.length} umwandeln` : t("Umwandeln")}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {dragging && (
          <motion.div
            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-label-2 bg-black/70 text-body text-label"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
          >
            Loslassen, um diese Dateien zu ersetzen
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function sameFormat(ext: string, target: string): boolean {
  const norm = (e: string) => ({ jpeg: "jpg", tif: "tiff", htm: "html", markdown: "md", xlsm: "xlsx" })[e] ?? e;
  return norm(ext) === norm(target);
}

function commonKind(files: DroppedFile[]): Exclude<FileKind, "other"> | null {
  const kinds = new Set(files.map((f) => f.kind));
  if (kinds.size !== 1) return null;
  const k = [...kinds][0];
  return k === "other" ? null : k;
}
