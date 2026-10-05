//! Klick-Durchlass für das transparente Notch-Fenster.
//!
//! Tauri kann nur das ganze Fenster klick-durchlässig machen. Deshalb pollt ein
//! Thread die globale Mausposition und schaltet `set_ignore_cursor_events` um,
//! je nachdem ob die Maus über der Trefferzone liegt, die das Frontend meldet.
//! Gleichzeitig ersetzt das `notch://hover`-Event pointerenter/-leave, denn ein
//! durchlässiges WebView bekommt keine Mausereignisse mehr.
//!
//! Fokus-Modus (`passthrough`): Das Fenster bleibt immer durchlässig, auch über der
//! Notch — Klicks landen in der App darunter (z. B. Browser-Tabs). Drei schnelle Klicks
//! auf die Notch melden `notch://focus-exit`; dafür wird nur die Maustaste beobachtet.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

/// Trefferzone in CSS-Pixeln, relativ zur linken oberen Fensterecke.
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

    /// Größere Zone, solange die Maustaste gedrückt ist: Dateien lassen sich so leichter
    /// auf die kleine geschlossene Notch ziehen (Quick Drop).
    fn grown(&self) -> HitRect {
        HitRect { x: self.x - DROP_MARGIN, y: self.y, w: self.w + DROP_MARGIN * 2.0, h: self.h + DROP_MARGIN }
    }
}

/// Zusätzlicher Rand der Drop-Zone in CSS-px.
const DROP_MARGIN: f64 = 48.0;

#[derive(Default)]
pub struct HitState {
    rect: Mutex<HitRect>,
    /// Solange true (z. B. beim Tippen), bleibt das Fenster klickbar.
    pinned: Mutex<bool>,
    /// Gesetzt nach show(): Klick-Durchlass beim nächsten Poll neu anwenden.
    refresh: AtomicBool,
    /// Fokus-Modus: immer durchlässig, kein Hover.
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

/// ~60 Hz reicht: Hover-Verzögerungen liegen ohnehin bei 180–220 ms.
const POLL: Duration = Duration::from_millis(16);
/// Fokus-Modus verlassen: so viele Klicks auf die Notch, je höchstens `CLICK_GAP` auseinander.
const EXIT_CLICKS: u32 = 3;
const CLICK_GAP: Duration = Duration::from_millis(450);

pub fn spawn(app: AppHandle, window: WebviewWindow) {
    thread::spawn(move || {
        // `None` erzwingt beim ersten Durchlauf einen definierten Zustand.
        let mut last_inside: Option<bool> = None;
        let mut last_ignore: Option<bool> = None;
        let mut was_down = false;
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
                // Klicks nur zählen (Flanke der Maustaste), nie abfangen.
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
            was_down = dragging;

            let inside = if dragging { rect.grown() } else { rect }.contains(x, y);
            let ignore = !inside && !*state.pinned.lock().unwrap();

            // Nur bei Änderung aufrufen: jeder Aufruf geht über den Event-Loop.
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
