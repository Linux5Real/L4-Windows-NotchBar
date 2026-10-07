//! Volume per app (like the Windows volume mixer) and "open the playing app".
//!
//! - Mixer: WASAPI audio sessions of the default output device, grouped by program
//!   (Chrome plays from several processes but is one row, like in Windows).
//!   Setting a level changes every session of that program.
//! - The media session (GSMTC) only knows an app ID ("Spotify.exe", "Chrome",
//!   "SpotifyAB.SpotifyMusic_…!Spotify"). It is matched to a program by name; the
//!   matching row is marked `media`, so the player can show its volume.
//! - Open: the program's window comes to the front (for browsers the window whose
//!   title has the track); packaged apps without a window are activated by their app
//!   ID, desktop apps without one (closed to the tray) are started again.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use tauri::State;
use windows::core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, TRUE};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Media::Audio::{
    eConsole, eRender, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
    MMDeviceEnumerator,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, FILE_FLAGS_AND_ATTRIBUTES};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_MENU};
use windows::Win32::UI::Shell::{
    ApplicationActivationManager, IApplicationActivationManager, SHGetFileInfoW, ACTIVATEOPTIONS, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, GetForegroundWindow, GetIconInfo, GetWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, ICONINFO, SW_RESTORE,
};

use crate::media::MediaState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVolume {
    /// Lowercase exe file name; identifies the row when setting the volume.
    id: String,
    name: String,
    /// PNG data URL of the program icon.
    icon: Option<String>,
    level: f32,
    muted: bool,
    /// This program is the source of what is playing.
    media: bool,
}

/// Icon and display name per exe path; reading them is the slow part.
#[derive(Default)]
pub struct MixerState(Mutex<HashMap<String, (String, Option<String>)>>);

struct Entry {
    exe_path: String,
    volume: ISimpleAudioVolume,
}

fn sessions() -> windows::core::Result<Vec<Entry>> {
    unsafe {
        // Own thread per call (spawn_blocking) → MTA; "already initialized" is fine.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let manager: IAudioSessionManager2 = devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)?;
        let list = manager.GetSessionEnumerator()?;
        let own = GetCurrentProcessId();
        let mut out = Vec::new();
        for i in 0..list.GetCount()? {
            let Ok(control) = list.GetSession(i) else { continue };
            let Ok(control) = control.cast::<IAudioSessionControl2>() else { continue };
            // S_OK = the "System sounds" session (S_FALSE otherwise); Windows lists it apart.
            if control.IsSystemSoundsSession() == windows::Win32::Foundation::S_OK {
                continue;
            }
            if control.GetState().is_ok_and(|s| s == AudioSessionStateExpired) {
                continue;
            }
            let Ok(pid) = control.GetProcessId() else { continue };
            if pid == 0 || pid == own {
                continue;
            }
            let Some(exe_path) = process_path(pid) else { continue };
            let Ok(volume) = control.cast::<ISimpleAudioVolume>() else { continue };
            out.push(Entry { exe_path, volume });
        }
        Ok(out)
    }
}

fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_lowercase()
}

/// Letters and digits only, lowercase: "AppleMusic.exe" and "AppleInc.AppleMusicWin_…" compare.
fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase()
}

/// Does the media app ID belong to this exe? Firefox reports a fixed hash instead of a name.
fn matches(app_id: &str, exe: &str) -> bool {
    let stem = squash(exe.strip_suffix(".exe").unwrap_or(exe));
    let id = squash(app_id.strip_suffix(".exe").unwrap_or(app_id));
    if stem.is_empty() || id.is_empty() {
        return false;
    }
    if id == "308046b0af4a39cb" {
        return stem == "firefox";
    }
    id == stem || (stem.len() >= 4 && id.contains(&stem))
}

#[tauri::command]
pub async fn mixer_list(media: State<'_, MediaState>, cache: State<'_, MixerState>) -> Result<Vec<AppVolume>, String> {
    let playing = media.shown().map(|(id, _)| id).unwrap_or_default();
    let known: HashMap<String, (String, Option<String>)> = cache.0.lock().unwrap().clone();
    let (rows, fresh) = tauri::async_runtime::spawn_blocking(move || -> windows::core::Result<_> {
        let mut rows: Vec<AppVolume> = Vec::new();
        let mut fresh = HashMap::new();
        for e in sessions()? {
            let id = file_name(&e.exe_path);
            let (level, muted) = unsafe { (e.volume.GetMasterVolume().unwrap_or(1.0), e.volume.GetMute().is_ok_and(|m| m.as_bool())) };
            // Several sessions of one program: one row, the loudest unmuted level wins.
            if let Some(row) = rows.iter_mut().find(|r| r.id == id) {
                row.level = row.level.max(level);
                row.muted &= muted;
                continue;
            }
            let (name, icon) = known.get(&e.exe_path).cloned().unwrap_or_else(|| {
                let info = (display_name(&e.exe_path), icon_png(&e.exe_path));
                fresh.insert(e.exe_path.clone(), info.clone());
                info
            });
            rows.push(AppVolume { media: !playing.is_empty() && matches(&playing, &id), id, name, icon, level, muted });
        }
        Ok((rows, fresh))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.message())?;
    cache.0.lock().unwrap().extend(fresh);
    Ok(rows)
}

/// Sets level (0..1) and/or mute for every session of the program `id`.
#[tauri::command]
pub async fn mixer_set(id: String, level: Option<f32>, muted: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> windows::core::Result<()> {
        for e in sessions()?.into_iter().filter(|e| file_name(&e.exe_path) == id) {
            unsafe {
                if let Some(l) = level {
                    e.volume.SetMasterVolume(l.clamp(0.0, 1.0), std::ptr::null())?;
                    if l > 0.0 && muted.is_none() {
                        let _ = e.volume.SetMute(false, std::ptr::null());
                    }
                }
                if let Some(m) = muted {
                    e.volume.SetMute(m, std::ptr::null())?;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.message())
}

/// "Google Chrome" from the exe's version info, otherwise the file name ("Spotify").
fn display_name(path: &str) -> String {
    description(path).filter(|d| !d.trim().is_empty()).unwrap_or_else(|| {
        let stem = file_name(path);
        let stem = stem.strip_suffix(".exe").unwrap_or(&stem);
        let mut c = stem.chars();
        c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
    })
}

fn description(path: &str) -> Option<String> {
    unsafe {
        let path = HSTRING::from(path);
        let size = GetFileVersionInfoSizeW(&path, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&path, None, size, data.as_mut_ptr().cast()).ok()?;
        // First language/codepage pair.
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        if !VerQueryValueW(data.as_ptr().cast(), &HSTRING::from(r"\VarFileInfo\Translation"), &mut ptr, &mut len).as_bool() || len < 4 {
            return None;
        }
        let pair = *(ptr as *const [u16; 2]);
        let key = format!(r"\StringFileInfo\{:04x}{:04x}\FileDescription", pair[0], pair[1]);
        if !VerQueryValueW(data.as_ptr().cast(), &HSTRING::from(key), &mut ptr, &mut len).as_bool() || len == 0 {
            return None;
        }
        let text = std::slice::from_raw_parts(ptr as *const u16, len as usize);
        Some(String::from_utf16_lossy(text).trim_end_matches('\0').to_string())
    }
}

/// The exe's 32 px icon as a PNG data URL.
fn icon_png(path: &str) -> Option<String> {
    unsafe {
        let mut info = SHFILEINFOW::default();
        let ok = SHGetFileInfoW(
            &HSTRING::from(path),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if ok == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let png = icon_to_png(info.hIcon);
        let _ = DestroyIcon(info.hIcon);
        let png = png?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
    }
}

unsafe fn icon_to_png(icon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    let mut ii = ICONINFO::default();
    GetIconInfo(icon, &mut ii).ok()?;
    let result = (|| {
        let mut bm = BITMAP::default();
        if GetObjectW(ii.hbmColor.into(), std::mem::size_of::<BITMAP>() as i32, Some((&mut bm as *mut BITMAP).cast())) == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(None);
        let lines = GetDIBits(dc, ii.hbmColor, 0, h as u32, Some(px.as_mut_ptr().cast()), &mut bmi, DIB_RGB_COLORS);
        let _ = DeleteDC(dc);
        if lines == 0 {
            return None;
        }
        // BGRA → RGBA; old icons without alpha are fully opaque.
        let no_alpha = px.chunks(4).all(|p| p[3] == 0);
        for p in px.chunks_mut(4) {
            p.swap(0, 2);
            if no_alpha {
                p[3] = 255;
            }
        }
        let img = image::RgbaImage::from_raw(w as u32, h as u32, px)?;
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
        Some(png)
    })();
    if !ii.hbmColor.is_invalid() {
        let _ = DeleteObject(ii.hbmColor.into());
    }
    if !ii.hbmMask.is_invalid() {
        let _ = DeleteObject(ii.hbmMask.into());
    }
    result
}

// ── Open the playing app ─────────────────────────────────────────────────────

/// Brings the app of the shown media session to the front.
#[tauri::command]
pub async fn media_open_source(media: State<'_, MediaState>) -> Result<bool, String> {
    let Some((app_id, title)) = media.shown() else { return Ok(false) };
    tauri::async_runtime::spawn_blocking(move || open_source(&app_id, &title)).await.map_err(|e| e.to_string())
}

fn open_source(app_id: &str, title: &str) -> bool {
    // A window of the program wins: it keeps the exact window (and browser tab).
    if let Some(hwnd) = find_window(app_id, title) {
        return bring_to_front(hwnd);
    }
    // Packaged apps (Store Spotify, Apple Music): Windows activates them by ID.
    if app_id.contains('!') {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if let Ok(manager) = CoCreateInstance::<_, IApplicationActivationManager>(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) {
                return manager.ActivateApplication(&HSTRING::from(app_id), PCWSTR::null(), ACTIVATEOPTIONS(0)).is_ok();
            }
        }
    }
    // Running without a window (Spotify closed to the tray): starting the exe again
    // makes single-instance apps show their window. Browsers never get here, they
    // always play inside a window.
    running_exe(app_id).is_some_and(|exe| std::process::Command::new(exe).spawn().is_ok())
}

fn running_exe(app_id: &str) -> Option<std::path::PathBuf> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
    sys.processes().values().filter_map(|p| p.exe()).find(|exe| matches(app_id, &file_name(&exe.to_string_lossy()))).map(|p| p.to_path_buf())
}

struct Search<'a> {
    app_id: &'a str,
    title: String,
    /// (window, its title contains the track)
    found: Vec<(HWND, bool)>,
}

/// Visible top-level window of the program, the one showing the track first
/// (a browser's window title is its active tab). Z-order otherwise: last used first.
fn find_window(app_id: &str, title: &str) -> Option<HWND> {
    let mut search = Search { app_id, title: title.to_lowercase(), found: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut search as *mut Search as isize));
    }
    search.found.iter().find(|(_, t)| *t).or(search.found.first()).map(|(h, _)| *h)
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let search = &mut *(lparam.0 as *mut Search);
    if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
        return TRUE;
    }
    let len = GetWindowTextLengthW(hwnd);
    if len == 0 {
        return TRUE;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let Some(path) = process_path(pid) else { return TRUE };
    if !matches(search.app_id, &file_name(&path)) {
        return TRUE;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = GetWindowTextW(hwnd, &mut buf);
    let text = String::from_utf16_lossy(&buf[..n as usize]).to_lowercase();
    search.found.push((hwnd, !search.title.is_empty() && text.contains(&search.title)));
    TRUE
}

fn bring_to_front(hwnd: HWND) -> bool {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd).as_bool() && GetForegroundWindow() == hwnd {
            return true;
        }
        // Windows only lets the foreground app hand over focus. A tapped Alt counts as
        // user input and unlocks it (the usual way, e.g. used by PowerToys Run).
        let alt = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_MENU, dwFlags: flags, ..Default::default() } },
        };
        SendInput(&[alt(Default::default()), alt(KEYEVENTF_KEYUP)], std::mem::size_of::<INPUT>() as i32);
        SetForegroundWindow(hwnd).as_bool()
    }
}
