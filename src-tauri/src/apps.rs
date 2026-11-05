//! Launch installed applications and open media via URI schemes (Ask integration).
//!
//! - `apps_list`: cached scan of Start Menu shortcuts (the same apps the user sees in
//!   the Start menu). Used to give the assistant the app names it may open.
//! - `app_launch`: fuzzy-match an app by name and launch it via ShellExecuteW
//!   (handles .lnk shortcuts and URI handlers; no registry parsing needed).
//! - `music_play`: open Spotify's search (current session's app if Spotify, otherwise
//!   Spotify if installed); otherwise YouTube Music search in the browser.
//!
//! ShellExecuteW (not CreateProcess) is used because .lnk files and scheme handlers
//! (spotify:search:…) are resolved by the shell. The verb is always "open".

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use windows::core::{PCWSTR, w};
use windows::Win32::Foundation::{HWND};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const TEXT_LAUNCH: &str = "App konnte nicht geöffnet werden";
/// Re-scan the Start Menu at most every 5 minutes.
const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
/// Never send more than this many names to the model.
const MAX_LIST: usize = 120;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownApp {
    /// Name as the user sees it in the Start menu (file stem).
    pub name: String,
    path: PathBuf,
}

#[derive(Default)]
pub struct AppsState(Mutex<Option<(Instant, Vec<KnownApp>)>>);

impl AppsState {
    fn cached(&self) -> Option<(Instant, Vec<KnownApp>)> {
        self.0.lock().unwrap().clone()
    }

    fn store(&self, apps: Vec<KnownApp>) {
        *self.0.lock().unwrap() = Some((Instant::now(), apps));
    }
}

/// Installed apps, cached. Returns at most MAX_LIST names.
#[tauri::command]
pub fn apps_list(state: State<'_, AppsState>) -> Vec<String> {
    list_apps(&state).into_iter().take(MAX_LIST).map(|a| a.name).collect()
}

/// Launch an app by name (fuzzy, case-insensitive).
#[tauri::command]
pub fn app_launch(state: State<'_, AppsState>, name: String) -> Result<String, String> {
    let query = name.trim();
    if query.is_empty() {
        return Err("App-Name fehlt".into());
    }
    let apps = list_apps(&state);
    let Some(app) = find_app(query, &apps) else {
        return Err(format!("App nicht gefunden: {query}"));
    };
    shell_open(&app.path.to_string_lossy())?;
    Ok(app.name)
}

/// Open the given song/artist in the music app that makes sense:
/// the currently playing session if it is Spotify, otherwise Spotify if installed,
/// otherwise YouTube Music search in the browser.
#[tauri::command]
pub fn music_play(app: AppHandle, state: State<'_, AppsState>, query: String) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("Wonach soll gesucht werden?".into());
    }
    let encoded = urlencode(q);

    // Spotify as the shown source → open its search, the user picks the track.
    if let Some((app_id, _)) = app.state::<crate::media::MediaState>().shown() {
        let id = app_id.to_lowercase();
        if id.contains("spotify") {
            shell_open(&format!("spotify:search:{encoded}"))?;
            return Ok("Spotify-Suche".to_string());
        }
        // Another source is up (e.g. YouTube in the browser) → search there.
        shell_open(&format!("https://music.youtube.com/search?query={encoded}"))?;
        return Ok("YouTube Music-Suche".to_string());
    }
    // Spotify installed → the search URI works even while it is closed.
    if list_apps(&state).iter().any(|a| a.name.eq_ignore_ascii_case("spotify")) {
        shell_open(&format!("spotify:search:{encoded}"))?;
        return Ok("Spotify-Suche".to_string());
    }
    // No Spotify: open YouTube Music search in the browser.
    shell_open(&format!("https://music.youtube.com/search?query={encoded}"))?;
    Ok("YouTube Music-Suche".to_string())
}

fn list_apps(state: &AppsState) -> Vec<KnownApp> {
    if let Some((at, apps)) = state.cached() {
        if at.elapsed() < CACHE_TTL {
            return apps;
        }
    }
    let apps = scan_start_menu();
    state.store(apps.clone());
    apps
}

/// Walks the two Start Menu Programs roots (user + all users) recursively.
fn scan_start_menu() -> Vec<KnownApp> {
    let mut out: Vec<KnownApp> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for env in ["APPDATA", "PROGRAMDATA"] {
        let Some(base) = std::env::var_os(env).map(PathBuf::from) else { continue };
        let programs = base.join("Microsoft").join("Windows").join("Start Menu").join("Programs");
        collect_lnk(&programs, &mut out, &mut seen, 0);
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    out
}

/// `seen` avoids duplicates and near-duplicates from nested Start menu folders.
fn collect_lnk(dir: &std::path::Path, out: &mut Vec<KnownApp>, seen: &mut std::collections::HashSet<String>, depth: u8) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_lnk(&path, out, seen, depth + 1);
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else { continue };
        if !ext.eq_ignore_ascii_case("lnk") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let name = stem.trim();
        if name.is_empty() {
            continue;
        }
        // Skip the usual Start menu noise (uninstallers, help, docs).
        let lower = name.to_lowercase();
        if ["uninstall", "deinstall", "hilfe", "help", "readme", "documentation", "manual", "support", "website"]
            .iter()
            .any(|junk| lower.contains(junk))
        {
            continue;
        }
        if seen.insert(lower) {
            out.push(KnownApp { name: name.to_string(), path });
        }
    }
}

fn normalize(s: &str) -> String {
    s.trim().to_lowercase().trim_end_matches(".exe").to_string()
}

/// Best score wins. 0 exact, 1 prefix, 2 whole-word contains, 3 substring.
fn score(query: &str, name: &str) -> Option<u8> {
    if name == query {
        return Some(0);
    }
    if name.starts_with(query) {
        return Some(1);
    }
    if name
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| word.starts_with(query))
    {
        return Some(2);
    }
    if name.contains(query) {
        return Some(3);
    }
    None
}

fn find_app(query: &str, apps: &[KnownApp]) -> Option<KnownApp> {
    let q = normalize(query);
    let mut best: Option<(u8, usize, &KnownApp)> = None;
    for app in apps {
        let Some(s) = score(&q, &normalize(&app.name)) else { continue };
        let rank = (s, app.name.len(), app);
        if best.map(|(bs, bl, _)| s < bs || (s == bs && app.name.len() < bl)).unwrap_or(true) {
            best = Some(rank);
        }
    }
    best.map(|(_, _, app)| app.clone())
}

/// Percent-encode a query component (everything but unreserved characters).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(*byte as char),
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// ShellExecuteW the verb "open" on a path or URI. Works for .lnk and scheme handlers.
fn shell_open(target: &str) -> Result<(), String> {
    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            Option::<HWND>::None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    let code = result.0 as isize;
    if code <= 32 {
        return Err(format!("{TEXT_LAUNCH} (Fehler {code})"));
    }
    Ok(())
}