//! Click-through for the transparent notch window.
//!
//! Tauri can only make the whole window click-through, so a thread polls the
//! global cursor position and toggles `set_ignore_cursor_events` depending on
//! whether the cursor is over the hit zone reported by the frontend.
//! The `notch://hover` event replaces pointerenter/leave, because a click-through
//! WebView no longer gets mouse events.
//!
//! Focus mode (`passthrough`): the window stays click-through even over the notch,
//! so clicks reach the app below (e.g. browser tabs). Three quick clicks on the notch
//! emit `notch://focus-exit`; only the mouse button is watched for that.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

/// Hit zone in CSS px, relative to the window's top-left corner.
#[derive(Clone, Copy, Default, Deserialize)]
pub struct HitRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl HitRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }

    /// Larger zone while something is dragged towards the notch, so files are easier
    /// to drop onto the small closed notch (quick drop).
    fn grown(&self) -> HitRect {
        HitRect { x: self.x - DROP_MARGIN, y: self.y, w: self.w + DROP_MARGIN * 2.0, h: self.h + DROP_MARGIN }
    }
}

/// Extra margin of the drop zone in CSS px.
const DROP_MARGIN: f64 = 48.0;
/// Movement (CSS px) after the press before it counts as a drag.
const DRAG_START: f64 = 6.0;

#[derive(Default)]
pub struct HitState {
    rect: Mutex<HitRect>,
    /// While true (e.g. typing), the window stays clickable.
    pinned: Mutex<bool>,
    /// Set after show(): reapply click-through on the next poll.
    refresh: AtomicBool,
    /// Focus mode: always click-through, no hover.
    passthrough: AtomicBool,
}

impl HitState {
    pub fn refresh(&self) {
        self.refresh.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn set_hit_rect(rect: HitRect, state: State<'_, HitState>) {
    *state.rect.lock().unwrap() = rect;
}

#[tauri::command]
pub fn set_passthrough(on: bool, state: State<'_, HitState>) {
    state.passthrough.store(on, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_pinned(pinned: bool, state: State<'_, HitState>) {
    *state.pinned.lock().unwrap() = pinned;
}

/// ~60 Hz is plenty: hover delays are 180–220 ms anyway.
const POLL: Duration = Duration::from_millis(16);
/// Leaving focus mode: this many clicks on the notch, each at most `CLICK_GAP` apart.
const EXIT_CLICKS: u32 = 3;
const CLICK_GAP: Duration = Duration::from_millis(450);

pub fn spawn(app: AppHandle, window: WebviewWindow) {
    thread::spawn(move || {
        // `None` forces a defined state on the first pass.
        let mut last_inside: Option<bool> = None;
        let mut last_ignore: Option<bool> = None;
        let mut was_down = false;
        // Where the current press started; None = button up or the press began near the notch.
        let mut drag_from: Option<(f64, f64)> = None;
        let mut drag_active = false;
        let (mut clicks, mut last_click) = (0u32, Instant::now());

        loop {
            thread::sleep(POLL);
            let state = app.state::<HitState>();
            if state.refresh.swap(false, Ordering::Relaxed) {
                last_ignore = None;
            }
            let (Ok(cursor), Ok(origin), Ok(scale)) =
                (window.cursor_position(), window.outer_position(), window.scale_factor())
            else {
                continue;
            };

            let x = (cursor.x - origin.x as f64) / scale;
            let y = (cursor.y - origin.y as f64) / scale;
            let rect = *state.rect.lock().unwrap();
            let dragging = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
            let passthrough = state.passthrough.load(Ordering::Relaxed);

            if passthrough {
                // Only count clicks (button edges), never swallow them.
                if dragging && !was_down && rect.contains(x, y) {
                    clicks = if last_click.elapsed() <= CLICK_GAP { clicks + 1 } else { 1 };
                    last_click = Instant::now();
                    if clicks >= EXIT_CLICKS {
                        clicks = 0;
                        let _ = window.emit("notch://focus-exit", ());
                    }
                }
                was_down = dragging;
                if last_ignore != Some(true) {
                    let _ = window.set_ignore_cursor_events(true);
                    last_ignore = Some(true);
                }
                if last_inside != Some(false) {
                    let _ = window.emit("notch://hover", false);
                    last_inside = Some(false);
                }
                continue;
            }
            // Grow the zone only for a real drag that started away from the notch (a file
            // from Explorer). A plain click right below the notch must reach the app
            // underneath; growing on every press swallowed those clicks (issue #7).
            if dragging && !was_down {
                drag_from = (!rect.grown().contains(x, y)).then_some((x, y));
                drag_active = false;
            } else if !dragging {
                drag_from = None;
                drag_active = false;
            }
            if let Some((fx, fy)) = drag_from {
                drag_active |= (x - fx).hypot(y - fy) > DRAG_START;
            }
            was_down = dragging;

            let inside = if drag_active { rect.grown() } else { rect }.contains(x, y);
            let ignore = !inside && !*state.pinned.lock().unwrap();

            // Only call on change: every call goes through the event loop.
            if last_ignore != Some(ignore) {
                let _ = window.set_ignore_cursor_events(ignore);
                last_ignore = Some(ignore);
            }
            if last_inside != Some(inside) {
                let _ = window.emit("notch://hover", inside);
                last_inside = Some(inside);
            }
        }
    });
}
