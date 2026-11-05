//! Screenshot capture (fullscreen + region selection) using Windows GDI.
//!
//! Region selection works like the Snipping Tool: the screen is dimmed by a
//! translucent overlay, the user drags a rectangle, and after the overlay is
//! destroyed the selected region is copied from the desktop.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use image::{RgbaImage, ImageBuffer};
use image::codecs::png::PngEncoder;
use serde::Serialize;
use windows::Win32::Foundation::{HWND, RECT, POINT, LPARAM, WPARAM, LRESULT, HINSTANCE, COLORREF};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BitBlt, GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    SRCCOPY, BeginPaint, EndPaint, PAINTSTRUCT, RedrawWindow, RDW_INVALIDATE, RDW_UPDATENOW,
    RDW_ALLCHILDREN, CreatePen, CreateSolidBrush, Rectangle, MoveToEx, LineTo, PS_SOLID,
    HGDIOBJ, HBRUSH, SetTextColor, SetBkMode, ExtTextOutW, TRANSPARENT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage,
    RegisterClassW, UnregisterClassW, LoadCursorW, IDC_CROSS, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_PAINT, WM_KEYDOWN, WS_EX_TOPMOST, WS_EX_LAYERED,
    WS_POPUP, WS_VISIBLE, SetLayeredWindowAttributes, LWA_ALPHA, DestroyWindow,
    WNDCLASSW, GetDesktopWindow, GetSystemMetrics,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    CS_HREDRAW, CS_VREDRAW,
};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::core::{HSTRING, PCWSTR};

const TEXT_SCREENSHOT: &str = "Screenshot fehlgeschlagen";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    pub path: Option<String>,
    pub cancelled: bool,
    /// Thumbnail data URL so the UI can show the captured image instantly.
    pub thumbnail: Option<String>,
}

/// Creates a COLORREF from (r, g, b).
fn color_ref(r: u8, g: u8, b: u8) -> COLORREF {
    COLORREF((b as u32) << 16 | (g as u32) << 8 | r as u32)
}

fn temp_png() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("notch-screenshot-{}-{}.png", std::process::id(), nanos))
}

/// Removes our own screenshot/OCR leftovers older than 30 minutes from the
/// temp directory. Caps the clutter (and the exposure of captured screen
/// content sitting in %TEMP% forever).
fn sweep_temp() {
    let Ok(dir) = std::env::temp_dir().read_dir() else { return };
    let cutoff = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(30 * 60))
        .unwrap_or(0);
    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".png")
            || !(name.starts_with("notch-screenshot-") || name.starts_with("notch-ocr-"))
        {
            continue;
        }
        let age = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        if age.map(|a| a < cutoff).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// True while a region selection overlay is on screen (single selection at a time).
static REGION_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Saves an RgbaImage as PNG to the given path.
fn save_png(img: &RgbaImage, path: &PathBuf) -> Result<(), String> {
    let mut buf = Vec::new();
    let encoder = PngEncoder::new(&mut buf);
    img.write_with_encoder(encoder).map_err(|_| TEXT_SCREENSHOT.to_string())?;
    std::fs::write(path, &buf).map_err(|_| TEXT_SCREENSHOT.to_string())?;
    Ok(())
}

/// Base64 data URL of a thumbnail for the preview, if the file is small enough.
/// Reads raw bytes instead of image::open to avoid format detection issues.
fn thumbnail_data_url(path: &PathBuf) -> Option<String> {
    use std::io::Cursor;
    use base64::Engine;
    if std::fs::metadata(path).ok()?.len() > 40 * 1024 * 1024 {
        return None;
    }
    // Load with explicit PNG format (our screenshots are always PNG).
    let img = image::ImageReader::with_format(
        std::io::BufReader::new(std::fs::File::open(path).ok()?),
        image::ImageFormat::Png,
    )
    .decode()
    .ok()?
    .to_rgba8();
    let scale = (480f32 / img.width().max(img.height()) as f32).min(1.0);
    let (w, h) = (((img.width() as f32 * scale) as u32).max(1), ((img.height() as f32 * scale) as u32).max(1));
    let small = image::imageops::thumbnail(&img, w, h);
    let mut png = Vec::new();
    small.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

/// Copies the given screen region (screen coordinates) into an RgbaImage.
/// Keeps the screen HDC alive until GetDIBits is done — releasing it early
/// made GetDIBits fail and the capture silently vanished.
unsafe fn capture_region_image(left: i32, top: i32, width: i32, height: i32) -> Result<RgbaImage, String> {
    if width <= 0 || height <= 0 {
        return Err("Invalid region".into());
    }
    let hwnd_desktop = GetDesktopWindow();
    let hdc_screen = GetDC(Some(hwnd_desktop));
    if hdc_screen.0.is_null() {
        return Err("GetDC failed".into());
    }

    let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
    if hdc_mem.0.is_null() {
        let _ = ReleaseDC(Some(hwnd_desktop), hdc_screen);
        return Err("CreateCompatibleDC failed".into());
    }

    let hbitmap = CreateCompatibleBitmap(hdc_screen, width, height);
    if hbitmap.0.is_null() {
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(Some(hwnd_desktop), hdc_screen);
        return Err("CreateCompatibleBitmap failed".into());
    }

    let old_bitmap = SelectObject(hdc_mem, HGDIOBJ(hbitmap.0));
    let ok = BitBlt(hdc_mem, 0, 0, width, height, Some(hdc_screen), left, top, SRCCOPY);

    // HBITMAP → raw pixels via GetDIBits (top-down BGRA) while the bitmap is
    // still selected into hdc_mem and hdc_screen is still valid.
    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let lines = if ok.is_ok() {
        GetDIBits(
            hdc_mem,
            hbitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        )
    } else {
        0
    };

    SelectObject(hdc_mem, old_bitmap);
    let _ = DeleteDC(hdc_mem);
    let _ = ReleaseDC(Some(hwnd_desktop), hdc_screen);
    let _ = DeleteObject(HGDIOBJ(hbitmap.0));

    if ok.is_err() {
        return Err("BitBlt failed".into());
    }
    if lines == 0 {
        return Err("GetDIBits failed".into());
    }

    // BGRA → RGBA
    let mut rgba = Vec::with_capacity(pixels.len());
    for chunk in pixels.chunks_exact(4) {
        rgba.push(chunk[2]);
        rgba.push(chunk[1]);
        rgba.push(chunk[0]);
        rgba.push(chunk[3]);
    }

    ImageBuffer::<image::Rgba<u8>, _>::from_raw(width as u32, height as u32, rgba)
        .ok_or_else(|| TEXT_SCREENSHOT.to_string())
}

/// Captures the entire virtual screen (all monitors).
fn capture_fullscreen() -> Result<PathBuf, String> {
    unsafe {
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let img = capture_region_image(left, top, width, height)?;
        let path = temp_png();
        save_png(&img, &path)?;
        Ok(path)
    }
}

/// Region selection overlay state (single selection at a time).
struct SelectionState {
    start: Option<POINT>,
    end: Option<POINT>,
    selecting: bool,
    /// Client-coordinate rectangle of the selection.
    result: Option<RECT>,
    hint: &'static str,
}

static mut SELECTION_STATE: Option<SelectionState> = None;

extern "system" fn selection_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        let state = match (*std::ptr::addr_of_mut!(SELECTION_STATE)).as_mut() {
            Some(s) => s,
            None => return DefWindowProcW(hwnd, msg, wparam, lparam),
        };

        match msg {
            WM_LBUTTONDOWN => {
                let x = (lparam.0 & 0xFFFF) as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as i32;
                state.selecting = true;
                state.start = Some(POINT { x, y });
                state.end = Some(POINT { x, y });
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                if state.selecting {
                    let x = (lparam.0 & 0xFFFF) as i32;
                    let y = ((lparam.0 >> 16) & 0xFFFF) as i32;
                    state.end = Some(POINT { x, y });
                    let _ = RedrawWindow(Some(hwnd), None, None, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
                }
                LRESULT(0)
            }
            WM_LBUTTONUP => {
                if state.selecting {
                    state.selecting = false;
                    let x = (lparam.0 & 0xFFFF) as i32;
                    let y = ((lparam.0 >> 16) & 0xFFFF) as i32;
                    state.end = Some(POINT { x, y });

                    if let (Some(start), Some(end)) = (state.start, state.end) {
                        let left = start.x.min(end.x);
                        let top = start.y.min(end.y);
                        let right = start.x.max(end.x);
                        let bottom = start.y.max(end.y);
                        // Minimum 5×5 px so a click doesn't create an empty result.
                        if right - left >= 5 && bottom - top >= 5 {
                            state.result = Some(RECT { left, top, right, bottom });
                        }
                    }
                    PostQuitMessage(0);
                }
                LRESULT(0)
            }
            WM_KEYDOWN => {
                if wparam.0 == VK_ESCAPE.0 as usize {
                    state.result = None;
                    PostQuitMessage(0);
                }
                LRESULT(0)
            }
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);

                // Dim the whole screen.
                let black = CreateSolidBrush(color_ref(0, 0, 0));
                let old_brush = SelectObject(hdc, HGDIOBJ(black.0));
                let _ = Rectangle(hdc, 0, 0, GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
                SelectObject(hdc, old_brush);
                let _ = DeleteObject(HGDIOBJ(black.0));

                // Hint text (white, top-left).
                let hint = state.hint;
                let _ = SetTextColor(hdc, color_ref(255, 255, 255));
                let _ = SetBkMode(hdc, TRANSPARENT);
                let mut hint_buf: Vec<u16> = hint.encode_utf16().collect();
                hint_buf.push(0);
                let _ = ExtTextOutW(hdc, 24, 24, windows::Win32::Graphics::Gdi::ETO_OPTIONS(0), None, PCWSTR(hint_buf.as_ptr()), hint_buf.len() as u32 - 1, None);

                // Red selection rectangle.
                if let (Some(start), Some(end)) = (state.start, state.end) {
                    let left = start.x.min(end.x);
                    let top = start.y.min(end.y);
                    let right = start.x.max(end.x);
                    let bottom = start.y.max(end.y);
                    let pen = CreatePen(PS_SOLID, 2, color_ref(255, 0, 0));
                    let old_pen = SelectObject(hdc, HGDIOBJ(pen.0));
                    let _ = MoveToEx(hdc, left, top, None);
                    let _ = LineTo(hdc, right, top);
                    let _ = LineTo(hdc, right, bottom);
                    let _ = LineTo(hdc, left, bottom);
                    let _ = LineTo(hdc, left, top);
                    SelectObject(hdc, old_pen);
                    let _ = DeleteObject(HGDIOBJ(pen.0));
                }

                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

/// Runs the region-selection overlay. Returns the selected rectangle in
/// screen coordinates, or None if the user cancelled.
fn run_region_selection() -> Result<Option<RECT>, String> {
    unsafe {
        let hinstance = GetModuleHandleW(None).map_err(|_| "GetModuleHandleW failed".to_string())?;
        let hinstance: HINSTANCE = hinstance.into();
        let class_name = HSTRING::from("NotchRegionSelection");

        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let offset_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let offset_y = GetSystemMetrics(SM_YVIRTUALSCREEN);

        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(selection_wndproc),
            hInstance: hinstance,
            hCursor: LoadCursorW(None, IDC_CROSS).map_err(|_| "LoadCursorW failed".to_string())?,
            hbrBackground: HBRUSH(std::ptr::null_mut()),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };

        if RegisterClassW(&wc) == 0 {
            // Already registered from a previous run → unregister and retry once.
            let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), Some(hinstance));
            if RegisterClassW(&wc) == 0 {
                return Err("RegisterClassW failed".to_string());
            }
        }

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_LAYERED,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(std::ptr::null()),
            WS_POPUP | WS_VISIBLE,
            offset_x,
            offset_y,
            width,
            height,
            None,
            None,
            Some(hinstance),
            None,
        )
        .map_err(|_| "CreateWindowExW failed".to_string())?;

        // ~47% black overlay; the desktop shows through.
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 120, LWA_ALPHA)
            .map_err(|_| "SetLayeredWindowAttributes failed".to_string())?;

        SELECTION_STATE = Some(SelectionState {
            start: None,
            end: None,
            selecting: false,
            result: None,
            hint: "Drag to select area — Esc to cancel",
        });

        let mut msg = std::mem::zeroed();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }

        let result = (*std::ptr::addr_of_mut!(SELECTION_STATE)).take().and_then(|s| s.result);
        DestroyWindow(hwnd).ok();
        let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), Some(hinstance));

        // Convert client coords → screen coords.
        Ok(result.map(|r| RECT {
            left: r.left + offset_x,
            top: r.top + offset_y,
            right: r.right + offset_x,
            bottom: r.bottom + offset_y,
        }))
    }
}

#[tauri::command]
pub async fn screenshot_fullscreen() -> Result<ScreenshotResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        sweep_temp();
        capture_fullscreen()
    })
        .await
        .map_err(|_| TEXT_SCREENSHOT.to_string())?
        .map(|p| ScreenshotResult {
            thumbnail: thumbnail_data_url(&p),
            path: Some(p.to_string_lossy().to_string()),
            cancelled: false,
        })
}

#[tauri::command]
pub async fn screenshot_region() -> Result<ScreenshotResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if REGION_ACTIVE.swap(true, Ordering::SeqCst) {
            return Err(TEXT_SCREENSHOT.to_string());
        }
        sweep_temp();
        let result = run_region_selection().and_then(|rect| {
            match rect {
                Some(r) => {
                    let img = unsafe { capture_region_image(r.left, r.top, r.right - r.left, r.bottom - r.top) }?;
                    let path = temp_png();
                    save_png(&img, &path)?;
                    Ok(ScreenshotResult {
                        thumbnail: thumbnail_data_url(&path),
                        path: Some(path.to_string_lossy().to_string()),
                        cancelled: false,
                    })
                }
                None => Ok(ScreenshotResult { path: None, cancelled: true, thumbnail: None }),
            }
        });
        REGION_ACTIVE.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_or_else(
        |_| Err::<ScreenshotResult, String>(TEXT_SCREENSHOT.to_string()),
        |r| r,
    )
}
