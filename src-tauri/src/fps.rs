//! FPS für den Gaming-Modus: zählt Present-Aufrufe des Vordergrundprozesses per ETW
//! (wie PresentMon, nur stark vereinfacht).
//!
//! - Quellen: Microsoft-Windows-DXGI (Present_Start, D3D10–12), Microsoft-Windows-D3D9 und
//!   Microsoft-Windows-DxgKrnl (Present/PresentHistory/Blit im Kernel). Über DxgKrnl laufen
//!   alle APIs — damit zählen auch OpenGL (z. B. Minecraft Java) und Vulkan.
//! - Ein Frame löst je nach API mehrere dieser Events aus. Deshalb wird pro Event-Art
//!   getrennt gezählt und die größte Zahl genommen — nie die Summe.
//! - Echtzeit-ETW braucht Administratorrechte oder die Gruppe "Leistungsprotokollbenutzer".
//!   Ohne beides liefert `gaming_fps` den Fehler "no-admin"; `fps_unlock` nimmt das Konto
//!   einmalig in die Gruppe auf (eine UAC-Abfrage, danach nie wieder).
//! - Die Sitzung läuft nur, solange abgefragt wird (`IDLE`), und überlebt sonst einen
//!   Absturz — deshalb wird eine alte Sitzung gleichen Namens beim Start beendet.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::core::{GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, WIN32_ERROR};
use windows::Win32::System::Diagnostics::Etw::{
    CloseTrace, ControlTraceW, EnableTraceEx2, OpenTraceW, ProcessTrace, StartTraceW, CONTROLTRACE_HANDLE, EVENT_CONTROL_CODE_ENABLE_PROVIDER,
    EVENT_RECORD, EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES, EVENT_TRACE_REAL_TIME_MODE, PROCESSTRACE_HANDLE,
    PROCESS_TRACE_MODE_EVENT_RECORD, PROCESS_TRACE_MODE_REAL_TIME, WNODE_FLAG_TRACED_GUID,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

const SESSION: &str = "NotchFps";
const DXGI: GUID = GUID::from_u128(0xca11c036_0102_4a2d_a6ad_f03cfed5d3c9);
const D3D9: GUID = GUID::from_u128(0x783aca0a_790e_4d7f_8451_aa850511c6b9);
const DXGKRNL: GUID = GUID::from_u128(0x802ec45a_1e99_4b83_9920_87c98277ba9d);
/// DXGI: Present_Start, PresentMultiplaneOverlay_Start. D3D9: Present_Start.
const DXGI_PRESENT: [u16; 2] = [42, 55];
const D3D9_PRESENT: u16 = 1;
/// DxgKrnl (Keyword "Present"): Blit_Info, PresentHistory_Start, Present_Info,
/// PresentHistoryDetailed_Start. Alle im Thread des präsentierenden Prozesses geloggt.
const KMT_PRESENT: [u16; 4] = [166, 171, 184, 215];
const KMT_KEYWORD_PRESENT: u64 = 0x800_0000;
/// Kein Abruf mehr seit so lange → Sitzung beenden.
const IDLE: Duration = Duration::from_secs(10);
const TRACE_LEVEL_INFORMATION: u8 = 4;

#[derive(Default)]
struct Counter {
    /// Presents je (Prozess, Event-Art) seit dem letzten Abruf.
    counts: HashMap<(u32, u16), u32>,
    since: Option<Instant>,
    wanted_at: Option<Instant>,
    running: bool,
    error: Option<&'static str>,
    /// Geglättete FPS des zuletzt abgefragten Prozesses.
    last: Option<(u32, f64)>,
}

fn counter() -> &'static Mutex<Counter> {
    static C: OnceLock<Mutex<Counter>> = OnceLock::new();
    C.get_or_init(Default::default)
}

#[derive(Serialize)]
pub struct Fps {
    fps: Option<f64>,
    /// "no-admin" | "failed"
    error: Option<&'static str>,
}

#[tauri::command]
pub fn gaming_fps() -> Fps {
    let mut c = counter().lock().unwrap();
    c.wanted_at = Some(Instant::now());
    if !c.running && c.error.is_none() {
        c.running = true;
        c.since = Some(Instant::now());
        thread::spawn(run);
        return Fps { fps: None, error: None };
    }
    if let Some(error) = c.error {
        return Fps { fps: None, error: Some(error) };
    }

    let pid = foreground_pid();
    let elapsed = c.since.map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0);
    if elapsed < 0.25 {
        return Fps { fps: c.last.filter(|(p, _)| *p == pid).map(|(_, f)| f), error: None };
    }
    let frames = c.counts.iter().filter(|((p, _), _)| *p == pid).map(|(_, n)| *n).max().unwrap_or(0) as f64;
    c.counts.clear();
    c.since = Some(Instant::now());
    let now = frames / elapsed;
    // Leicht glätten, damit die Zahl nicht flackert; Prozesswechsel = neu anfangen.
    let fps = match c.last {
        Some((p, prev)) if p == pid && now > 0.0 => prev * 0.4 + now * 0.6,
        _ => now,
    };
    c.last = Some((pid, fps));
    Fps { fps: (fps > 0.0).then_some(fps), error: None }
}

fn foreground_pid() -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid)) };
    pid
}

/// Puffer für EVENT_TRACE_PROPERTIES + Sitzungsname (muss direkt dahinter liegen).
struct Props {
    buf: Vec<u8>,
}

impl Props {
    fn new() -> Self {
        let name_len = (SESSION.len() + 1) * 2;
        let size = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() + name_len;
        let mut buf = vec![0u8; size];
        let p = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
        unsafe {
            (*p).Wnode.BufferSize = size as u32;
            (*p).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
            (*p).Wnode.ClientContext = 1; // QPC
            (*p).LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
            (*p).LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
        }
        Self { buf }
    }

    fn ptr(&mut self) -> *mut EVENT_TRACE_PROPERTIES {
        self.buf.as_mut_ptr() as *mut _
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn stop_session(name: &[u16]) {
    let mut props = Props::new();
    unsafe {
        let _ = ControlTraceW(CONTROLTRACE_HANDLE::default(), PCWSTR(name.as_ptr()), props.ptr(), EVENT_TRACE_CONTROL_STOP);
    }
}

fn fail(error: &'static str) {
    let mut c = counter().lock().unwrap();
    c.running = false;
    c.error = Some(error);
}

fn run() {
    let name = wide(SESSION);
    let mut handle = CONTROLTRACE_HANDLE::default();
    let mut props = Props::new();
    let mut status = unsafe { StartTraceW(&mut handle, PCWSTR(name.as_ptr()), props.ptr()) };
    if status == ERROR_ALREADY_EXISTS {
        stop_session(&name);
        props = Props::new();
        status = unsafe { StartTraceW(&mut handle, PCWSTR(name.as_ptr()), props.ptr()) };
    }
    if status != ERROR_SUCCESS {
        return fail(if status == ERROR_ACCESS_DENIED { "no-admin" } else { "failed" });
    }

    // DxgKrnl ist sehr gesprächig → nur das Present-Keyword. DXGI/D3D9 sind ruhig (0 = alle).
    for (provider, keyword) in [(DXGI, 0), (D3D9, 0), (DXGKRNL, KMT_KEYWORD_PRESENT)] {
        let status = unsafe { EnableTraceEx2(handle, &provider, EVENT_CONTROL_CODE_ENABLE_PROVIDER.0, TRACE_LEVEL_INFORMATION, keyword, 0, 0, None) };
        if WIN32_ERROR(status.0) != ERROR_SUCCESS {
            stop_session(&name);
            return fail("failed");
        }
    }

    let mut logger = wide(SESSION);
    let mut logfile = EVENT_TRACE_LOGFILEW::default();
    logfile.LoggerName = PWSTR(logger.as_mut_ptr());
    logfile.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
    logfile.Anonymous2.EventRecordCallback = Some(on_event);
    let trace: PROCESSTRACE_HANDLE = unsafe { OpenTraceW(&mut logfile) };
    if trace.Value == u64::MAX {
        stop_session(&name);
        return fail("failed");
    }

    // Wächter: ohne Abruf Sitzung beenden → ProcessTrace kehrt zurück.
    let watch_name = name.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let idle = counter().lock().unwrap().wanted_at.is_none_or(|t| t.elapsed() > IDLE);
        if idle {
            stop_session(&watch_name);
            break;
        }
    });

    unsafe {
        let _ = ProcessTrace(&[trace], None, None);
        let _ = CloseTrace(trace);
    }
    let mut c = counter().lock().unwrap();
    c.running = false;
    c.counts.clear();
    c.last = None;
}

unsafe extern "system" fn on_event(record: *mut EVENT_RECORD) {
    let Some(r) = (unsafe { record.as_ref() }) else { return };
    let h = &r.EventHeader;
    let id = h.EventDescriptor.Id;
    // Art = Event-ID, DXGI/D3D9 bekommen eigene Bereiche, damit sie nicht mit DxgKrnl-IDs kollidieren.
    let kind = if h.ProviderId == DXGI && DXGI_PRESENT.contains(&id) {
        1000 + id
    } else if h.ProviderId == D3D9 && id == D3D9_PRESENT {
        2000 + id
    } else if h.ProviderId == DXGKRNL && KMT_PRESENT.contains(&id) {
        id
    } else {
        return;
    };
    if let Ok(mut c) = counter().lock() {
        *c.counts.entry((h.ProcessId, kind)).or_insert(0) += 1;
    }
}

/// Einmalig freischalten: das eigene Konto in die Gruppe "Leistungsprotokollbenutzer"
/// (S-1-5-32-559) aufnehmen. Danach darf die Notch die ETW-Sitzung ohne Adminrechte
/// starten — der offizielle Weg (so beschreibt es auch PresentMon). Kostet eine
/// UAC-Abfrage; wirksam nach dem nächsten Anmelden.
///
/// Ergebnis: "relogin" (aufgenommen bzw. schon drin), "cancelled" (UAC abgelehnt), "failed".
#[tauri::command]
pub async fn fps_unlock() -> &'static str {
    use base64::Engine;
    // Die SID ermittelt der nicht erhöhte Prozess: bei einem Standardkonto meldet sich in der
    // UAC-Abfrage ein anderes (Admin-)Konto an, aufgenommen werden soll aber dieses hier.
    const OUTER: &str = r#"
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$inner = "try { Add-LocalGroupMember -SID 'S-1-5-32-559' -Member '$sid' -ErrorAction Stop } catch { if (`$_.CategoryInfo.Reason -ne 'MemberExistsException') { exit 2 } }; exit 0"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
try { $p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList "-NoProfile -EncodedCommand $enc"; exit $p.ExitCode } catch { exit 1 }
"#;
    let utf16: Vec<u8> = OUTER.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded]);
        crate::convert::hide_console(&mut cmd);
        match cmd.status().ok().and_then(|s| s.code()) {
            Some(0) => "relogin",
            Some(1) => "cancelled",
            _ => "failed",
        }
    })
    .await
    .unwrap_or("failed")
}
