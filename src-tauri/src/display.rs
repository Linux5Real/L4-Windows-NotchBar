//! Display: which monitor the notch sits on and whether it hides during fullscreen.
//!
//! A thread checks the foreground window every 400 ms. If it covers the notch's whole
//! monitor (game, video, presentation, borderless too), the window is hidden, otherwise
//! shown again. In "always" mode only "always on top" is reapplied in case another
//! app put itself above.
//!
//! Gaming mode "in fullscreen": the notch stays visible instead; Rust emits
//! `notch://fullscreen` and the frontend shows FPS and load.
//! `offset` moves the notch sideways (dragging), clamped to the monitor.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowRect, IsZoomed};

use crate::hit_test::HitState;

const POLL: Duration = Duration::from_millis(400);

#[derive(Default)]
pub struct DisplayState(Mutex<Config>);

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// true = hide during fullscreen.
    hide_fullscreen: bool,
    /// Monitor name ("\\.\DISPLAY2"); None = primary monitor.
    monitor: Option<String>,
    /// Horizontal offset from the center in CSS px.
    #[serde(default)]
    offset: f64,
    /// Gaming mode "in fullscreen": don't hide, just report.
    #[serde(default)]
    gaming: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    name: String,
    primary: bool,
    width: u32,
    height: u32,
}

#[tauri::command]
pub fn display_monitors(window: WebviewWindow) -> Vec<MonitorInfo> {
    let primary = window.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let name = m.name().cloned().unwrap_or_default();
            let scale = m.scale_factor();
            MonitorInfo {
                primary: primary.as_deref() == Some(name.as_str()),
                width: (m.size().width as f64 / scale) as u32,
                height: (m.size().height as f64 / scale) as u32,
                name,
            }
        })
        .collect()
}

#[tauri::command]
pub fn display_apply(config: Config, window: WebviewWindow, state: State<'_, DisplayState>) {
    let moved = {
        let cur = state.0.lock().unwrap();
        cur.monitor != config.monitor || cur.offset != config.offset
    };
    *state.0.lock().unwrap() = config;
    if moved {
        let _ = place(&window, &state);
    }
}

/// Centered and flush at the top of the chosen monitor (primary otherwise).
pub fn place(window: &WebviewWindow, state: &DisplayState) -> tauri::Result<()> {
    let (wanted, offset) = {
        let c = state.0.lock().unwrap();
        (c.monitor.clone(), c.offset)
    };
    let monitors = window.available_monitors()?;
    let monitor = wanted
        .and_then(|name| monitors.into_iter().find(|m| m.name() == Some(&name)))
        .or(window.primary_monitor()?);
    let Some(monitor) = monitor else { return Ok(()) };
    // Set twice: when moving to a monitor with different scaling, the window size
    // only updates after the first move.
    for _ in 0..2 {
        let size = window.outer_size()?;
        let free = (monitor.size().width as i32 - size.width as i32).max(0);
        let shift = ((offset * monitor.scale_factor()) as i32).clamp(-free / 2, free / 2);
        let x = monitor.position().x + free / 2 + shift;
        window.set_position(PhysicalPosition::new(x, monitor.position().y))?;
    }
    Ok(())
}

pub fn spawn(app: AppHandle, window: WebviewWindow) {
    thread::spawn(move || {
        let Ok(own) = window.hwnd() else { return };
        let mut hidden = false;
        let mut last_fullscreen = false;
        let mut last_foreground = HWND::default();
        loop {
            thread::sleep(POLL);
            let state = app.state::<DisplayState>();
            let (hide_fullscreen, gaming) = {
                let c = state.0.lock().unwrap();
                (c.hide_fullscreen, c.gaming)
            };
            let foreground = unsafe { GetForegroundWindow() };
            let fullscreen = foreground != own && covers_monitor(foreground, own);
            if fullscreen != last_fullscreen {
                last_fullscreen = fullscreen;
                let _ = app.emit("notch://fullscreen", fullscreen);
            }
            let hide = hide_fullscreen && !gaming && fullscreen;

            if hide != hidden {
                hidden = hide;
                if hidden {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_always_on_top(true);
                    // Let the click-through state be set again after show() (the poll caches the old one).
                    app.state::<HitState>().refresh();
                }
            }
            // New foreground window: reapply "on top" in case it covered us.
            if !hidden && foreground != last_foreground {
                let _ = window.set_always_on_top(true);
            }
            last_foreground = foreground;
        }
    });
}

/// Does `hwnd` cover the whole monitor the notch (`own`) is on?
fn covers_monitor(hwnd: HWND, own: HWND) -> bool {
    // Maximized windows aren't fullscreen, but with an auto-hiding taskbar they
    // cover the whole monitor too.
    if hwnd.is_invalid() || is_desktop(hwnd) || unsafe { IsZoomed(hwnd) }.as_bool() {
        return false;
    }
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor != MonitorFromWindow(own, MONITOR_DEFAULTTONEAREST) {
            return false;
        }
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let mut rect = RECT::default();
        if !GetMonitorInfoW(monitor, &mut info).as_bool() || GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let m = info.rcMonitor;
        rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
    }
}

/// Desktop and taskbar never count as fullscreen.
fn is_desktop(hwnd: HWND) -> bool {
    unsafe {
        if hwnd == GetDesktopWindow() || hwnd == GetShellWindow() {
            return true;
        }
        let mut buf = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut buf).max(0) as usize;
        let class = String::from_utf16_lossy(&buf[..len]);
        matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
    }
}
