//! Text aus Bildern (OCR) über die in Windows eingebaute Engine.
//!
//! Läuft vollständig lokal: keine Schlüssel, keine Netzwerkanfragen. Zu große Bilder
//! werden zuerst im Rust-Teil verkleinert, danach an `Windows.Media.Ocr` übergeben.
//! Beim "auto"-Modus versucht Windows-OCR alle installierten Sprachen und die mit der
//! besten Treffergüte wird zurückgegeben.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};

const TEXT_OPEN: &str = "Datei nicht lesbar";
const TEXT_DECODE: &str = "Bild konnte nicht dekodiert werden";
const TEXT_OCR: &str = "Erkennung fehlgeschlagen";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    /// "" = beste verfügbare Sprache offen (auto), sonst das gewählte Tag.
    pub language: String,
}

#[tauri::command]
pub async fn ocr_recognize(path: String, language: Option<String>) -> Result<OcrResult, String> {
    tauri::async_runtime::spawn_blocking(move || recognize_file(&path, language.as_deref()))
        .await
        .map_err(|_| TEXT_OCR.to_string())?
}

fn recognize_file(path: &str, language: Option<&str>) -> Result<OcrResult, String> {
    match prepare_png(path)? {
        Prepared::Original => recognize_with(Path::new(path), language),
        Prepared::Png(png) => {
            let temp = temp_png();
            std::fs::write(&temp, &png).map_err(|_| TEXT_OPEN.to_string())?;
            let result = recognize_with(&temp, language);
            let _ = std::fs::remove_file(&temp);
            result
        }
    }
}

enum Prepared {
    Original,
    Png(Vec<u8>),
}

fn prepare_png(path: &str) -> Result<Prepared, String> {
    let bytes = std::fs::read(path).map_err(|_| TEXT_OPEN.to_string())?;
    let max = OcrEngine::MaxImageDimension().map_err(|_| TEXT_OCR.to_string()).unwrap_or(2600);
    match image::load_from_memory(&bytes) {
        Ok(img) => {
            let (w, h) = (img.width(), img.height());
            if w.max(h) <= max {
                return Ok(Prepared::Original);
            }
            let scale = max as f32 / w.max(h) as f32;
            let nw = (w as f32 * scale).round().max(1.0) as u32;
            let nh = (h as f32 * scale).round().max(1.0) as u32;
            let resized =
                image::imageops::resize(&img.to_rgba8(), nw, nh, image::imageops::FilterType::Triangle);
            let mut png = Vec::new();
            image::DynamicImage::ImageRgba8(resized)
                .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
                .map_err(|_| TEXT_DECODE.to_string())?;
            Ok(Prepared::Png(png))
        }
        Err(_) => Ok(Prepared::Original),
    }
}

fn temp_png() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("notch-ocr-{}-{}.png", std::process::id(), nanos))
}

/// Counts "meaningful" characters across scripts Windows can actually OCR, with a strong penalty
/// on replacement glyphs and private-use area. Used only to pick the best engine — not to filter output.
fn score_text(text: &str) -> i32 {
    let mut score = 0;
    for c in text.chars() {
        if c == '\u{FFFD}' || ('\u{E000}'..='\u{F8FF}').contains(&c) {
            score -= 3;
            continue;
        }
        let good = ('\u{0400}'..='\u{04FF}').contains(&c)      // Cyrillic
            || ('\u{0590}'..='\u{05FF}').contains(&c)           // Hebrew
            || ('\u{0600}'..='\u{06FF}').contains(&c)            // Arabic
            || ('\u{0750}'..='\u{077F}').contains(&c)           // Arabic Supplement
            || ('\u{0800}'..='\u{083F}').contains(&c)           // Arabic Extended-A / Samaritan
            || ('\u{08A0}'..='\u{08FF}').contains(&c)           // Arabic Extended-A
            || ('\u{FB50}'..='\u{FDFF}').contains(&c)           // Arabic Presentation Forms-A
            || ('\u{FE70}'..='\u{FEFF}').contains(&c)           // Arabic Presentation Forms-B
            || ('\u{0900}'..='\u{097F}').contains(&c)           // Devanagari
            || ('\u{0980}'..='\u{09FF}').contains(&c)           // Bengali
            || ('\u{0E00}'..='\u{0E7F}').contains(&c)           // Thai
            || ('\u{0370}'..='\u{03FF}').contains(&c)           // Greek
            || ('\u{4E00}'..='\u{9FFF}').contains(&c)           // CJK Unified Ideographs
            || ('\u{3040}'..='\u{30FF}').contains(&c)           // Hiragana + Katakana
            || ('\u{AC00}'..='\u{D7A3}').contains(&c)           // Hangul
            || c.is_alphabetic();
        if good {
            score += 1;
            if c.is_alphabetic() && !c.is_ascii() {
                score += 1; // slight bias toward non-Latin meaningful glyphs (Arabic etc.)
            }
        } else if c.is_numeric() || c.is_whitespace() || c.is_ascii_punctuation() {
            score += 1;
        }
    }
    score
}

/// All OCR languages Windows can actually use on this machine, in a handy priority order
/// (Common: Arabic, German, English first, then rest).
fn available_languages() -> Vec<String> {
    let all: Vec<String> = OcrEngine::AvailableRecognizerLanguages()
        .map(|langs| {
            langs.into_iter()
                .filter_map(|l| l.LanguageTag().ok().map(|t| t.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut seen: Vec<String> = Vec::new();
    let mut push = |tag: &str| {
        let tag = tag.to_string();
        if !seen.contains(&tag) {
            seen.push(tag);
        }
    };

    for prio in ["ar", "de", "en"] {
        if all.iter().any(|t| t == prio || t.to_lowercase().starts_with(&format!("{}-", prio))) {
            push(prio);
        }
    }
    for tag in all {
        push(&tag);
    }
    seen
}

fn collect_text(result: windows::Media::Ocr::OcrResult) -> Result<String, String> {
    let mut text = String::new();
    for line in result.Lines().map_err(|_| TEXT_OCR.to_string())?.into_iter() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&line.Text().map_err(|_| TEXT_OCR.to_string())?.to_string());
    }
    Ok(text.trim().to_string())
}

fn recognize_with(path: &Path, language: Option<&str>) -> Result<OcrResult, String> {
    let file = StorageFile::GetFileFromPathAsync(&windows::core::HSTRING::from(path.as_os_str()))
        .map_err(|_| TEXT_OPEN.to_string())?
        .join()
        .map_err(|_| TEXT_OPEN.to_string())?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|_| TEXT_OPEN.to_string())?
        .join()
        .map_err(|_| TEXT_OPEN.to_string())?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|_| TEXT_DECODE.to_string())?
        .join()
        .map_err(|_| TEXT_DECODE.to_string())?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|_| TEXT_DECODE.to_string())?
        .join()
        .map_err(|_| TEXT_DECODE.to_string())?;
    let bitmap = SoftwareBitmap::ConvertWithAlpha(&bitmap, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)
        .map_err(|_| TEXT_DECODE.to_string())?;

    if let Some(tag) = language.filter(|t| !t.is_empty()) {
        let lang = Language::CreateLanguage(&windows::core::HSTRING::from(tag)).map_err(|_| TEXT_OCR.to_string())?;
        let engine = OcrEngine::TryCreateFromLanguage(&lang)
            .map_err(|_| "Diese Sprache ist nicht installiert (Einstellungen → Zeit & Sprache).".to_string())?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|_| TEXT_OCR.to_string())?
            .join()
            .map_err(|_| TEXT_OCR.to_string())?;
        let text = collect_text(result)?;
        if text.is_empty() {
            return Err("Kein Text erkannt".into());
        }
        return Ok(OcrResult { text, language: tag.to_string() });
    }

    let candidates = available_languages();
    if candidates.is_empty() {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| "Keine OCR-Sprache gefunden – Deutsch oder Arabisch installieren.".to_string())?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|_| TEXT_OCR.to_string())?
            .join()
            .map_err(|_| TEXT_OCR.to_string())?;
        let text = collect_text(result)?;
        if text.is_empty() {
            return Err("Kein Text erkannt".into());
        }
        return Ok(OcrResult { text, language: String::new() });
    }

    let mut best_text = String::new();
    let mut best_score = i32::MIN;
    let mut best_tag = String::new();

    for tag in candidates {
        let lang = match Language::CreateLanguage(&windows::core::HSTRING::from(&tag)) {
            Ok(l) => l,
            Err(_) => continue,
        };
        let engine = match OcrEngine::TryCreateFromLanguage(&lang) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let result = match engine
            .RecognizeAsync(&bitmap)
            .map_err(|_| TEXT_OCR.to_string())
            .and_then(|op| op.join().map_err(|_| TEXT_OCR.to_string()))
        {
            Ok(r) => r,
            Err(_) => continue,
        };
        let text = match collect_text(result) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if text.is_empty() {
            continue;
        }
        let score = score_text(&text);
        if score > best_score {
            best_score = score;
            best_text = text;
            best_tag = tag;
        }
    }

    if best_text.is_empty() {
        return Err("Kein Text erkannt".into());
    }
    Ok(OcrResult {
        text: best_text,
        language: best_tag,
    })
}