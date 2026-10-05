//! Dots like on iPhone: is anything using the mic or camera, or recording the screen?
//!
//! Windows tracks this itself (Settings → Privacy → "Recent activity") under
//! `HKCU\…\CapabilityAccessManager\ConsentStore\<capability>`: one key per app with
//! `LastUsedTimeStart`/`LastUsedTimeStop`. Stop = 0 means "in use". Desktop apps
//! sit one level deeper under `NonPackaged`.
//!
//! Screen recording: `graphicsCaptureProgrammatic` (Windows.Graphics.Capture: Discord,
//! Teams, Snipping Tool, OBS depending on source). Older capture paths (DXGI
//! duplication) don't show up there.

use serde::Serialize;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ};

const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

#[derive(Serialize)]
pub struct Privacy {
    mic: bool,
    camera: bool,
    screen: bool,
}

#[tauri::command]
pub fn privacy_state() -> Privacy {
    let own = std::env::current_exe().ok().map(|p| p.to_string_lossy().replace('\\', "#").to_lowercase());
    let busy = |cap: &str| in_use(&format!(r"{BASE}\{cap}"), own.as_deref());
    Privacy { mic: busy("microphone"), camera: busy("webcam"), screen: busy("graphicsCaptureProgrammatic") }
}

/// Is any app under `path` (or `path\NonPackaged`) active right now?
fn in_use(path: &str, own: Option<&str>) -> bool {
    let Some(key) = open(HKEY_CURRENT_USER, path) else { return false };
    let mut active = false;
    for name in subkeys(key) {
        let Some(sub) = open(key, &name) else { continue };
        if name == "NonPackaged" {
            // Never count our own exe (the equalizer uses loopback, not the mic, but just in case).
            active |= subkeys(sub).iter().filter(|n| Some(n.to_lowercase().as_str()) != own).any(|n| open(sub, n).is_some_and(|k| running_close(k)));
        } else {
            active |= running(sub);
        }
        close(sub);
        if active {
            break;
        }
    }
    close(key);
    active
}

/// Start set and Stop = 0 → in use.
fn running(key: HKEY) -> bool {
    let start = qword(key, "LastUsedTimeStart");
    let stop = qword(key, "LastUsedTimeStop");
    start.is_some_and(|s| s > 0) && stop == Some(0)
}

fn running_close(key: HKEY) -> bool {
    let r = running(key);
    close(key);
    r
}

fn close(key: HKEY) {
    unsafe {
        let _ = RegCloseKey(key);
    }
}

fn open(parent: HKEY, path: &str) -> Option<HKEY> {
    let mut key = HKEY::default();
    let ok = unsafe { RegOpenKeyExW(parent, &HSTRING::from(path), Some(0), KEY_READ, &mut key) } == ERROR_SUCCESS;
    ok.then_some(key)
}

fn subkeys(key: HKEY) -> Vec<String> {
    let mut out = Vec::new();
    for i in 0.. {
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let status = unsafe { RegEnumKeyExW(key, i, Some(windows::core::PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) };
        if status != ERROR_SUCCESS {
            break;
        }
        out.push(String::from_utf16_lossy(&buf[..len as usize]));
    }
    out
}

fn qword(key: HKEY, name: &str) -> Option<u64> {
    let mut value = 0u64;
    let mut size = 8u32;
    let name = HSTRING::from(name);
    let status = unsafe { RegQueryValueExW(key, PCWSTR(name.as_ptr()), None, None, Some(&mut value as *mut u64 as *mut u8), Some(&mut size)) };
    (status == ERROR_SUCCESS).then_some(value)
}
