//! Lower WebView2 memory while the notch sits closed.
//!
//! WebView2's own knob for this: `MemoryUsageTargetLevel = Low` lets the renderer trim
//! caches and page out what it doesn't need. The frontend switches it on after the notch
//! has been closed for a while and back to normal as soon as the cursor touches it
//! (peek), so the hover delay covers paging memory back in before it opens.

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use windows::core::Interface;

#[tauri::command]
pub fn memory_low(low: bool, window: WebviewWindow) {
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        // Older WebView2 runtimes (< 1.0.2210) don't have it; then nothing changes.
        let Ok(core) = core.cast::<ICoreWebView2_19>() else { return };
        let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        let _ = core.SetMemoryUsageTargetLevel(level);
    });
}
