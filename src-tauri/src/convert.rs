//! Quick-Drop-Converter: Dateien auf die Notch ziehen → in ein anderes Format wandeln.
//!
//! - Bilder (png, jpg, webp, bmp, gif, ico, tiff): direkt mit dem `image`-Crate.
//! - DDS (Spiele-Texturen): Lesen über `image`, Schreiben selbst als BC3/DXT5 mit Mipmaps.
//! - Audio/Video: über ffmpeg, falls installiert (PATH oder winget-Standardorte).
//! - Dokumente und Tabellen: siehe `documents.rs`.
//!
//! Ausgabe landet neben dem Original; existiert der Name, wird " (1)", " (2)" … angehängt.
//! Originale werden nie verändert.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::process::Command;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ImageFormat};
use serde::Serialize;

const IMAGE_IN: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "ico", "tif", "tiff", "dds", "tga"];
const AUDIO_IN: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma"];
const VIDEO_IN: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "wmv", "m4v"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    path: String,
    name: String,
    /// "image" | "audio" | "video" | "document" | "table" | "other"
    kind: &'static str,
    ext: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    files: Vec<FileInfo>,
    ffmpeg: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    input: String,
    output: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub fn convert_probe(paths: Vec<String>) -> Probe {
    let files = paths
        .into_iter()
        .filter_map(|p| {
            let path = PathBuf::from(&p);
            let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
            let ext = extension(&path);
            Some(FileInfo {
                name: path.file_name()?.to_string_lossy().into_owned(),
                kind: kind_of(&ext),
                ext,
                size: meta.len(),
                path: p,
            })
        })
        .collect();
    Probe { files, ffmpeg: ffmpeg().is_some() }
}

/// `quality`: 1–100 (nur JPEG und verlustbehaftetes Audio/Video relevant).
/// `max_size`: längste Bildkante in px, optional (nur Bilder).
#[tauri::command]
pub async fn convert_files(paths: Vec<String>, target: String, quality: Option<u8>, max_size: Option<u32>) -> Vec<Converted> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|input| {
                let result = convert_one(Path::new(&input), &target, quality.unwrap_or(85).clamp(1, 100), max_size);
                match result {
                    Ok(out) => Converted { input, output: Some(out.to_string_lossy().into_owned()), error: None },
                    Err(e) => Converted { input, output: None, error: Some(e) },
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Datei mit dem Standardprogramm öffnen.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Datei nicht mehr vorhanden".into());
    }
    // `explorer <datei>` öffnet mit der verknüpften App, ohne Konsolenfenster.
    Command::new("explorer").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Dateien in die Zwischenablage legen (Strg+V im Explorer fügt sie ein).
#[tauri::command]
pub fn copy_files(paths: Vec<String>) -> Result<(), String> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.exists()).collect();
    if files.is_empty() {
        return Err("Dateien nicht mehr vorhanden".into());
    }
    arboard::Clipboard::new().and_then(|mut c| c.set().file_list(&files)).map_err(|e| e.to_string())
}

/// Vorschau für Bilddateien (PNG-Data-URL), sonst None.
#[tauri::command]
pub async fn file_preview(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        crate::clipboard::is_image_file(p).then(|| crate::clipboard::file_thumbnail(p)).flatten()
    })
    .await
    .ok()
    .flatten()
}

/// Datei im Explorer markiert anzeigen.
#[tauri::command]
pub fn reveal_file(path: String) -> Result<(), String> {
    Command::new("explorer").arg(format!("/select,{path}")).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn convert_one(input: &Path, target: &str, quality: u8, max_size: Option<u32>) -> Result<PathBuf, String> {
    let ext = extension(input);
    if ext == target || (ext == "jpeg" && target == "jpg") || (ext == "htm" && target == "html") || (ext == "markdown" && target == "md") {
        return Err("Ist schon in diesem Format".into());
    }
    let output = free_path(input, target);
    match kind_of(&ext) {
        "image" => convert_image(input, &output, target, quality, max_size)?,
        "audio" | "video" => convert_media(input, &output, target, quality)?,
        "document" => crate::documents::convert_document(input, &output, &ext, target)?,
        "table" => crate::documents::convert_table(input, &output, &ext, target)?,
        _ => return Err("Format wird nicht unterstützt".into()),
    }
    Ok(output)
}

fn convert_image(input: &Path, output: &Path, target: &str, quality: u8, max_size: Option<u32>) -> Result<(), String> {
    let mut img = image::open(input).map_err(|_| "Bild konnte nicht gelesen werden".to_string())?;
    let longest = |i: &DynamicImage| i.width().max(i.height());
    if let Some(max) = max_size.filter(|&m| m > 0 && longest(&img) > m) {
        img = img.resize(max, max, image::imageops::FilterType::Lanczos3);
    }
    // Icons sind auf 256 px begrenzt.
    if target == "ico" && longest(&img) > 256 {
        img = img.resize(256, 256, image::imageops::FilterType::Lanczos3);
    }

    let file = File::create(output).map_err(|e| format!("Kann nicht speichern: {e}"))?;
    let mut writer = BufWriter::new(file);
    let result = match target {
        // JPEG kann keine Transparenz → auf Weiß legen statt schwarzer Flächen.
        "jpg" => DynamicImage::ImageRgb8(flatten_white(&img)).write_with_encoder(JpegEncoder::new_with_quality(&mut writer, quality)),
        "webp" => img.write_with_encoder(WebPEncoder::new_lossless(&mut writer)),
        "png" => img.write_to(&mut writer, ImageFormat::Png),
        "bmp" => img.write_to(&mut writer, ImageFormat::Bmp),
        "gif" => img.write_to(&mut writer, ImageFormat::Gif),
        "ico" => img.write_to(&mut writer, ImageFormat::Ico),
        "tiff" => img.write_to(&mut writer, ImageFormat::Tiff),
        "dds" => write_dds(&img, &mut writer),
        _ => {
            drop(writer);
            let _ = std::fs::remove_file(output);
            return Err("Zielformat für Bilder nicht verfügbar".into());
        }
    };
    result.map_err(|e| {
        let _ = std::fs::remove_file(output);
        format!("Umwandlung fehlgeschlagen: {e}")
    })
}

/// DDS als BC3 (DXT5, mit Alpha) inkl. Mipmap-Kette — das Format, das Spiele und Mods
/// am häufigsten erwarten. `image` kann DDS nur lesen, daher selbst geschrieben.
fn write_dds(img: &DynamicImage, w: &mut impl std::io::Write) -> image::ImageResult<()> {
    let (width, height) = (img.width(), img.height());
    let levels = 32 - width.max(height).leading_zeros();
    let format = texpresso::Format::Bc3;
    let mut data = Vec::new();
    let mut level = img.to_rgba8();
    for i in 0..levels {
        if i > 0 {
            let (lw, lh) = ((width >> i).max(1), (height >> i).max(1));
            level = image::imageops::resize(&img.to_rgba8(), lw, lh, image::imageops::FilterType::Triangle);
        }
        let (lw, lh) = (level.width() as usize, level.height() as usize);
        let mut out = vec![0u8; format.compressed_size(lw, lh)];
        format.compress(level.as_raw(), lw, lh, texpresso::Params::default(), &mut out);
        data.extend_from_slice(&out);
    }

    let mut header = [0u32; 31];
    header[0] = 124; // dwSize
    header[1] = 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000; // CAPS|HEIGHT|WIDTH|PIXELFORMAT|MIPMAPCOUNT|LINEARSIZE
    header[2] = height;
    header[3] = width;
    header[4] = format.compressed_size(width as usize, height as usize) as u32;
    header[6] = levels;
    header[18] = 32; // DDS_PIXELFORMAT.dwSize
    header[19] = 0x4; // DDPF_FOURCC
    header[20] = u32::from_le_bytes(*b"DXT5");
    header[26] = 0x1000 | 0x8 | 0x40_0000; // TEXTURE|COMPLEX|MIPMAP
    w.write_all(b"DDS ")?;
    for v in header {
        w.write_all(&v.to_le_bytes())?;
    }
    w.write_all(&data)?;
    Ok(())
}

fn flatten_white(img: &DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let p = rgba.get_pixel(x, y).0;
        let a = p[3] as f32 / 255.0;
        let blend = |c: u8| (c as f32 * a + 255.0 * (1.0 - a)).round() as u8;
        image::Rgb([blend(p[0]), blend(p[1]), blend(p[2])])
    })
}

fn convert_media(input: &Path, output: &Path, target: &str, quality: u8) -> Result<(), String> {
    let ffmpeg = ffmpeg().ok_or("Für Audio/Video wird ffmpeg benötigt")?;
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner").arg("-loglevel").arg("error").arg("-n").arg("-i").arg(input);

    // Qualität 1–100 grob auf sinnvolle Encoder-Werte abbilden.
    let crf = (35 - (quality as i32 * 17 / 100)).to_string(); // 100 → 18, 50 → 27
    let kbps = format!("{}k", 96 + quality as u32 * 224 / 100); // 100 → 320k
    match target {
        "mp3" => cmd.args(["-vn", "-c:a", "libmp3lame", "-b:a", &kbps]),
        "m4a" => cmd.args(["-vn", "-c:a", "aac", "-b:a", &kbps]),
        "wav" => cmd.args(["-vn", "-c:a", "pcm_s16le"]),
        "flac" => cmd.args(["-vn", "-c:a", "flac"]),
        "mp4" => cmd.args(["-c:v", "libx264", "-crf", &crf, "-preset", "medium", "-c:a", "aac", "-movflags", "+faststart"]),
        "webm" => cmd.args(["-c:v", "libvpx-vp9", "-crf", &crf, "-b:v", "0", "-c:a", "libopus"]),
        "gif" => cmd.args(["-vf", "fps=15,scale=480:-1:flags=lanczos", "-loop", "0"]),
        _ => return Err("Zielformat für Audio/Video nicht verfügbar".into()),
    };
    cmd.arg(output);
    hide_console(&mut cmd);

    let out = cmd.output().map_err(|e| format!("ffmpeg startet nicht: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(output);
        let msg = String::from_utf8_lossy(&out.stderr);
        Err(msg.lines().last().unwrap_or("ffmpeg-Fehler").chars().take(120).collect())
    }
}

fn ffmpeg() -> Option<PathBuf> {
    let mut probe = Command::new("ffmpeg");
    probe.arg("-version");
    hide_console(&mut probe);
    if probe.output().is_ok_and(|o| o.status.success()) {
        return Some(PathBuf::from("ffmpeg"));
    }
    // winget installiert nach %LOCALAPPDATA%\Microsoft\WinGet\Links
    let links = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Microsoft\\WinGet\\Links\\ffmpeg.exe");
    links.is_file().then_some(links)
}

#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

fn extension(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn kind_of(ext: &str) -> &'static str {
    if IMAGE_IN.contains(&ext) {
        "image"
    } else if AUDIO_IN.contains(&ext) {
        "audio"
    } else if VIDEO_IN.contains(&ext) {
        "video"
    } else if crate::documents::DOC_IN.contains(&ext) {
        "document"
    } else if crate::documents::TABLE_IN.contains(&ext) {
        "table"
    } else {
        "other"
    }
}

/// "Foto.png" → "Foto.webp", oder "Foto (1).webp" falls belegt.
fn free_path(input: &Path, ext: &str) -> PathBuf {
    let dir = input.parent().unwrap_or(Path::new("."));
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Datei".into());
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

#[doc(hidden)]
pub fn convert_for_test(input: &str, target: &str) -> Result<String, String> {
    convert_one(Path::new(input), target, 85, None).map(|p| p.to_string_lossy().into_owned())
}
