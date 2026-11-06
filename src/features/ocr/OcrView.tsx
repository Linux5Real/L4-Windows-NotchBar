import { useEffect, useState, useMemo } from "react";
import { ClipboardText, Copy, Scan, SpinnerGap, TextAa, Trash, WarningCircle, Camera, Crop } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { fade, spin } from "../../design/motion";
import { t, tBackend } from "../../i18n";
import { HeaderButton } from "../../notch/header";
import { ScrollArea } from "../../ui/ScrollArea";
import { Button, Select } from "../../ui/controls";
import { drop, pasteFiles, takeDropped, usePasteFiles } from "../../platform/drop";
import { filePreview, ocrRecognize, screenshotFullscreen, screenshotRegion, type OcrResult, type ScreenshotResult } from "../../platform/services";
import { translateState } from "../translate/store";
import { languages } from "../translate/languages";
import { navigate } from "../../notch/nav";
import { createStore } from "../../lib/store";

interface OcrState {
  /** Path of the current image (null = empty state). Kept in memory only, never persisted. */
  image: string | null;
  text: string;
  busy: boolean;
  error: string | null;
  /** "auto" = try installed languages and pick the best by glyph score, otherwise a BCP-47 tag. */
  language: string;
  /** Screenshot thumbnail data URL, shown instantly before filePreview resolves. */
  thumbnail: string | null;
}

const initial: OcrState = { image: null, text: "", busy: false, error: null, language: "auto", thumbnail: null };
const ocrState = createStore<OcrState>(initial);

/** OCR language list: auto first, then Arabic / German / English, then all translator languages. */
function languageOptions(): { value: string; label: string }[] {
  const top = ["ar", "de", "en"];
  const byCode = new Map(languages.map((l) => [l.code, l.name]));
  const topOptions = top.map((code) => ({ value: code, label: byCode.get(code) ?? code }));
  const restOptions = languages
    .filter((l) => !top.includes(l.code))
    .map((l) => ({ value: l.code, label: l.name }));
  return [{ value: "auto", label: t("Automatisch") }, ...topOptions, ...restOptions];
}

/** Bilder → Text (OCR): die in Windows eingebaute Erkennung, läuft lokal. */
export function OcrView() {
  const state = ocrState.use();
  const { image, busy, error, text, language } = state;
  const [preview, setPreview] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pasteHint, setPasteHint] = useState(false);
  const { dragging } = drop.use();
  usePasteFiles(() => {
    setPasteHint(true);
    window.setTimeout(() => setPasteHint(false), 1600);
  });
  const options = useMemo(() => languageOptions(), []);

  // Take dropped/pasted images as soon as they arrive (even if the notch was closed).
  const dropped = drop.use().dropped;
  useEffect(() => {
    const paths = takeDropped();
    const path = paths?.find((p) => /\.(png|jpe?g|gif|webp|bmp|tiff?|dds|heic)$/i.test(p));
    if (path) void recognizeRef(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  function recognizeRef(path: string) {
    void recognize(path);
  }

  // Decode a preview for the current image (native only; in the browser the demo text still shows).
  useEffect(() => {
    setPreview(null);
    if (!image) return;
    // Screenshot thumbnail shows instantly while filePreview loads.
    const thumb = ocrState.get().thumbnail;
    if (thumb) setPreview(thumb);
    void filePreview(image).then(setPreview);
  }, [image]);

  const setLang = (next: string) => {
    ocrState.set((s) => ({ ...s, language: next }));
    if (ocrState.get().image) void recognize(ocrState.get().image!);
  };

  const copy = () => {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  /** Sends the recognized text into the translator (language pair from there). */
  const sendToTranslate = () => {
    translateState.set((s) => ({ ...s, input: text }));
    navigate("translate");
  };

  const clear = () => ocrState.set((s) => ({ ...initial, language: s.language }));

  const pasteFromClipboard = () => {
    void pasteFiles().then((ok) => {
      if (!ok) {
        setPasteHint(true);
        window.setTimeout(() => setPasteHint(false), 1600);
      }
    });
  };

  const takeFullscreenScreenshot = async () => {
    ocrState.set((s) => ({ ...s, busy: true, error: null }));
    try {
      const result: ScreenshotResult = await screenshotFullscreen();
      if (result.path && !result.cancelled) {
        if (result.thumbnail) ocrState.set((s) => ({ ...s, thumbnail: result.thumbnail! }));
        await recognize(result.path);
      } else {
        ocrState.set((s) => ({ ...s, busy: false }));
      }
    } catch (e) {
      ocrState.set((s) => ({ ...s, busy: false, error: tBackend(String(e)) }));
    }
  };

  const takeRegionScreenshot = async () => {
    ocrState.set((s) => ({ ...s, busy: true, error: null }));
    try {
      const result: ScreenshotResult = await screenshotRegion();
      if (result.path && !result.cancelled) {
        if (result.thumbnail) ocrState.set((s) => ({ ...s, thumbnail: result.thumbnail! }));
        await recognize(result.path);
      } else {
        ocrState.set((s) => ({ ...s, busy: false }));
      }
    } catch (e) {
      ocrState.set((s) => ({ ...s, busy: false, error: tBackend(String(e)) }));
    }
  };

  if (!image) {
    return (
      <div className="flex h-full flex-col px-4 pt-1 pb-1">
        <div
          className={`relative flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-[14px] border-[1.5px] border-dashed transition-colors duration-200 ${
            dragging ? "border-label-2 bg-fill-2" : "border-fill-3 bg-fill-1"
          }`}
        >
          <Scan size={26} weight="bold" className={dragging ? "text-label" : "text-label-3"} />
          <span className="text-body text-label-2">
            {dragging ? t("Loslassen zum Erkennen") : t("Bilder hierher ziehen oder einfügen")}
          </span>
          <span className="max-w-72 text-center text-caption text-label-3">
            {t("Screenshot oder Foto – der Text wird lokal erkannt")}
          </span>
          <Button icon={ClipboardText} onClick={pasteFromClipboard}>
            {t("Aus Zwischenablage")}
          </Button>
          <div className="flex gap-1.5">
            <Button icon={Camera} onClick={takeFullscreenScreenshot}>
              {t("Vollbild")}
            </Button>
            <Button icon={Crop} onClick={takeRegionScreenshot}>
              {t("Bereich")}
            </Button>
          </div>
          {pasteHint && <span className="absolute bottom-3 text-caption text-label-4">{t("Zwischenablage enthält kein Bild")}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-1 px-4 pt-1 pb-1">
      <div className="flex min-h-0 flex-1 gap-2">
        {/* Image side */}
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-[12px] bg-fill-1">
          {preview ? (
            <img src={preview} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain p-2" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-label-4">
              <Scan size={22} weight="bold" />
              <span className="max-w-44 truncate text-footnote">{fileName(image)}</span>
            </div>
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/55">
              <motion.span className="flex text-label" animate={{ rotate: 360 }} transition={spin}>
                <SpinnerGap size={22} weight="bold" />
              </motion.span>
            </div>
          )}
        </div>

        {/* Text side */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[12px] bg-fill-1 p-2.5">
          <div className="relative min-h-0 flex-1">
            {error ? (
              <div className="absolute inset-0 flex flex-col items-start justify-center gap-2 px-1">
                <span className="flex items-start gap-1.5 text-caption text-label-2">
                  <WarningCircle size={13} weight="bold" className="mt-px shrink-0 text-red" />
                  {error}
                </span>
                <Button onClick={() => void recognize(image)}>{t("Erneut versuchen")}</Button>
              </div>
            ) : text ? (
              <ScrollArea className="h-full w-full pe-3 text-body leading-5 whitespace-pre-wrap text-label [overflow-wrap:anywhere]">
                <div dir="auto" className="select-text">
                  {text}
                </div>
              </ScrollArea>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-caption text-label-3">
                {busy ? t("Erkenne Text …") : t("Erkannter Text erscheint hier")}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-1.5 px-1 text-caption text-label-3">
        <Select
          value={language}
          onChange={setLang}
          width="w-32"
          ariaLabel={t("Sprache")}
          menuMaxHeight={220}
          menuWidth={220}
          options={options}
        />
        <span className="flex-1" />
        <AnimatePresence>
          {copied && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade }} exit={{ opacity: 0, transition: fade }}>
              {t("Kopiert")}
            </motion.span>
          )}
        </AnimatePresence>
        <HeaderButton label={t("Kopieren")} onClick={copy} disabled={!text || busy}>
          <Copy size={13} weight="bold" />
        </HeaderButton>
        <HeaderButton label={t("Übersetzen")} onClick={sendToTranslate} disabled={!text || busy}>
          <TextAa size={14} weight="bold" />
        </HeaderButton>
        <HeaderButton label={t("Leeren")} onClick={clear}>
          <Trash size={13} weight="bold" />
        </HeaderButton>
        <HeaderButton label={t("Vollbild")} onClick={takeFullscreenScreenshot} disabled={busy}>
          <Camera size={13} weight="bold" />
        </HeaderButton>
        <HeaderButton label={t("Bereich")} onClick={takeRegionScreenshot} disabled={busy}>
          <Crop size={13} weight="bold" />
        </HeaderButton>
      </div>
    </div>
  );

  async function recognize(path: string) {
    ocrState.set((s) => ({ ...s, image: path, busy: true, error: null }));
    try {
      const result: OcrResult = await ocrRecognize(path, language === "auto" ? null : language);
      ocrState.set((s) => ({ ...s, busy: false, text: result.text, error: null }));
    } catch (e) {
      ocrState.set((s) => ({ ...s, busy: false, text: "", error: tBackend(String(e)) }));
    }
  }
}

function fileName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.length > 40 ? `${name.slice(0, 18)}…${name.slice(-18)}` : name;
}
