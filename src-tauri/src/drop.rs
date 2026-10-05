//! Quick Drop: echte Dateipfade für Drag & Drop aus dem Explorer.
//!
//! Tauris eigener Drop-Handler hängt sich beim Start an die WebView2-Kindfenster. Je nach
//! WebView2-Version liegt das Fenster unter der Maus aber in einem anderen Prozess — dann
//! antwortet WebView2 selbst, und weil Tauri externe Drops abschaltet, kommt nur das rote
//! Verbotszeichen. Deshalb hier der offizielle WebView2-Weg: Das Frontend nimmt den Drop
//! als normales HTML5-Drop an und reicht die `File`-Objekte per
//! `chrome.webview.postMessageWithAdditionalObjects` durch; hier werden daraus Pfade.

use tauri::{Emitter, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2};
use webview2_com::WebMessageReceivedEventHandler;
use windows::core::{Interface, PWSTR};

/// Nachricht, die das Frontend mit den Dateien schickt (siehe `src/platform/drop.ts`).
const MESSAGE: &str = "notch-drop";

pub fn install(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let target = target.clone();
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut text = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut text).is_err() || text.is_null() {
                return Ok(());
            }
            let is_drop = text.to_string().is_ok_and(|t| t == MESSAGE);
            windows::Win32::System::Com::CoTaskMemFree(Some(text.0 as _));
            if !is_drop {
                return Ok(());
            }
            let paths = paths(&args);
            if !paths.is_empty() {
                let _ = target.emit("notch://drop", paths);
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_WebMessageReceived(&handler, &mut token);
    });
}

unsafe fn paths(args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(args) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else { return out };
    let Ok(objects) = args.AdditionalObjects() else { return out };
    let mut count = 0u32;
    if objects.Count(&mut count).is_err() {
        return out;
    }
    for i in 0..count {
        let Some(file) = objects.GetValueAtIndex(i).ok().and_then(|o| o.cast::<ICoreWebView2File>().ok()) else { continue };
        let mut path = PWSTR::null();
        if file.Path(&mut path).is_ok() && !path.is_null() {
            if let Ok(p) = path.to_string() {
                out.push(p);
            }
            windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as _));
        }
    }
    out
}
