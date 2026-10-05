//! FPS for gaming mode: counts present calls of the foreground process via ETW
//! (like PresentMon, heavily simplified).
//!
//! - Sources: Microsoft-Windows-DXGI (Present_Start, D3D10–12), Microsoft-Windows-D3D9 and
//!   Microsoft-Windows-DxgKrnl (present/history/blit in the kernel). Every API goes through
//!   DxgKrnl, so OpenGL (e.g. Minecraft Java) and Vulkan count too.
//! - One frame can fire several of these events depending on the API, so each event
//!   kind is counted separately and the highest count wins, never the sum.
//! - Real-time ETW needs admin rights or membership in "Performance Log Users".
//!   `fps_unlock` runs the app elevated once (UAC prompt shows "L4-Notchbar") and adds
//!   the account to that group. Windows only applies group changes to new sign-ins,
//!   so until then `gaming_fps` returns "relogin"; without membership "no-admin".
//!   (Per-GUID ETW rights via EventAccessControl don't help: creating a real-time
//!   session still requires the group, tested on Windows 11.) Errors retry every few seconds.
//! - The session only runs while polled (`IDLE`). It would survive a crash otherwise,
//!   so a leftover session with the same name is stopped on start.

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
/// Fixed session GUID.
const SESSION_GUID: GUID = GUID::from_u128(0x6f3e2a41_8c5d_4b7e_9a12_4c4e6f746368);
const DXGI: GUID = GUID::from_u128(0xca11c036_0102_4a2d_a6ad_f03cfed5d3c9);
const D3D9: GUID = GUID::from_u128(0x783aca0a_790e_4d7f_8451_aa850511c6b9);
const DXGKRNL: GUID = GUID::from_u128(0x802ec45a_1e99_4b83_9920_87c98277ba9d);
/// DXGI: Present_Start, PresentMultiplaneOverlay_Start. D3D9: Present_Start.
const DXGI_PRESENT: [u16; 2] = [42, 55];
const D3D9_PRESENT: u16 = 1;
/// DxgKrnl (Keyword "Present"): Blit_Info, PresentHistory_Start, Present_Info,
/// PresentHistoryDetailed_Start. All logged on the presenting process's thread.
const KMT_PRESENT: [u16; 4] = [166, 171, 184, 215];
const KMT_KEYWORD_PRESENT: u64 = 0x800_0000;
/// Stop the session after this long without a poll.
const IDLE: Duration = Duration::from_secs(10);
const TRACE_LEVEL_INFORMATION: u8 = 4;
/// Retry errors ("no-admin", "failed") after this long, e.g. after unlocking.
const RETRY: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Counter {
    /// Presents per (process, event kind) since the last poll.
    counts: HashMap<(u32, u16), u32>,
    since: Option<Instant>,
    wanted_at: Option<Instant>,
    running: bool,
    error: Option<&'static str>,
    error_at: Option<Instant>,
    /// Smoothed FPS of the last polled process.
    last: Option<(u32, f64)>,
}

fn counter() -> &'static Mutex<Counter> {
    static C: OnceLock<Mutex<Counter>> = OnceLock::new();
    C.get_or_init(Default::default)
}

#[derive(Serialize)]
pub struct Fps {
    fps: Option<f64>,
    /// "no-admin" | "relogin" | "failed"
    error: Option<&'static str>,
}

#[tauri::command]
pub fn gaming_fps() -> Fps {
    let mut c = counter().lock().unwrap();
    c.wanted_at = Some(Instant::now());
    if c.error.is_some() && c.error_at.is_none_or(|t| t.elapsed() > RETRY) {
        c.error = None;
    }
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
    // Smooth a little so the number doesn't flicker; a new process starts fresh.
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

/// Buffer for EVENT_TRACE_PROPERTIES + session name (must follow directly).
struct Props {
    buf: Vec<u8>,
}

impl Props {
    fn new() -> Self {
        // Room for any session name (incl. the probe); ControlTrace writes it back.
        let name_len = 1024 * 2;
        let size = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() + name_len;
        let mut buf = vec![0u8; size];
        let p = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
        unsafe {
            (*p).Wnode.BufferSize = size as u32;
            (*p).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
            (*p).Wnode.ClientContext = 1; // QPC
            (*p).Wnode.Guid = SESSION_GUID;
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
    c.error_at = Some(Instant::now());
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
        return fail(match status {
            ERROR_ACCESS_DENIED if unlock::pending_relogin() => "relogin",
            ERROR_ACCESS_DENIED => "no-admin",
            _ => "failed",
        });
    }

    // DxgKrnl is very chatty, so only the Present keyword. DXGI/D3D9 are quiet (0 = all).
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

    // Watchdog: stop the session when nobody polls, so ProcessTrace returns.
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
    // Kind = event ID; DXGI/D3D9 get their own ranges so they don't clash with DxgKrnl IDs.
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

/// One-time unlock: runs the app itself elevated (`--fps-unlock <SID>`) so the UAC
/// prompt shows "L4-Notchbar" instead of PowerShell. The SID comes from this
/// non-elevated process: with a standard account, a different admin account signs in
/// at the UAC prompt, but this account is the one to unlock.
///
/// Result: "ok" (FPS work now, e.g. the app runs elevated), "relogin" (after signing
/// out and back in), "cancelled", "failed".
#[tauri::command]
pub async fn fps_unlock() -> &'static str {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(sid) = unlock::current_user_sid() else { return "failed" };
        match unlock::run_elevated(&sid) {
            Err(result) => result,
            Ok(0) => {
                // Forget the error so the next poll restarts the session.
                let mut c = counter().lock().unwrap();
                c.error = None;
                drop(c);
                if unlock::can_trace() { "ok" } else { "relogin" }
            }
            Ok(_) => "failed",
        }
    })
    .await
    .unwrap_or("failed")
}

/// Runs in the elevated process (see main.rs). Returns the exit code: 0 ok, 2 failed.
pub fn elevated_unlock(sid: &str) -> i32 {
    unlock::grant(sid)
}

mod unlock {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::{w, PCWSTR, PWSTR};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree, ERROR_CANCELLED, ERROR_SUCCESS};
    use windows::Win32::NetworkManagement::NetManagement::{
        NetApiBufferFree, NetLocalGroupAddMembers, NetLocalGroupGetMembers, LOCALGROUP_MEMBERS_INFO_0, MAX_PREFERRED_LENGTH,
    };
    use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
    use windows::Win32::Security::{
        CheckTokenMembership, GetTokenInformation, LookupAccountSidW, TokenUser, PSID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Diagnostics::Etw::{StartTraceW, CONTROLTRACE_HANDLE};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    use super::{stop_session, wide, Props};

    /// Performance Log Users (well-known SID, the name is localized).
    const LOG_USERS: windows::core::PCWSTR = w!("S-1-5-32-559");

    /// Already a member of the group (ERROR_MEMBER_IN_ALIAS).
    const MEMBER_IN_ALIAS: u32 = 1378;

    pub fn current_user_sid() -> Option<String> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
            let mut len = 0;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            let ok = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len);
            let _ = CloseHandle(token);
            ok.ok()?;
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            sid_string(user.User.Sid)
        }
    }

    unsafe fn sid_string(sid: PSID) -> Option<String> {
        let mut text = PWSTR::null();
        unsafe { ConvertSidToStringSidW(sid, &mut text) }.ok()?;
        let s = unsafe { text.to_string() }.ok();
        let _ = unsafe { LocalFree(Some(HLOCAL(text.0.cast()))) };
        s
    }

    /// Localized name of "Performance Log Users", null-terminated.
    fn log_users_name() -> Option<[u16; 256]> {
        unsafe {
            let mut group_sid = PSID::default();
            ConvertStringSidToSidW(LOG_USERS, &mut group_sid).ok()?;
            let mut name = [0u16; 256];
            let mut domain = [0u16; 256];
            let (mut name_len, mut domain_len) = (name.len() as u32, domain.len() as u32);
            let mut kind = SID_NAME_USE::default();
            let found = LookupAccountSidW(
                PCWSTR::null(),
                group_sid,
                Some(PWSTR(name.as_mut_ptr())),
                &mut name_len,
                Some(PWSTR(domain.as_mut_ptr())),
                &mut domain_len,
                &mut kind,
            );
            let _ = LocalFree(Some(HLOCAL(group_sid.0)));
            found.ok().map(|_| name)
        }
    }

    /// Unlocked, but not active yet: the account is in the group, this sign-in's
    /// token isn't (Windows applies group changes only to new sign-ins).
    pub fn pending_relogin() -> bool {
        unsafe {
            let mut group_sid = PSID::default();
            if ConvertStringSidToSidW(LOG_USERS, &mut group_sid).is_err() {
                return false;
            }
            let mut in_token = BOOL::default();
            let active = CheckTokenMembership(None, group_sid, &mut in_token).is_ok() && in_token.as_bool();
            let _ = LocalFree(Some(HLOCAL(group_sid.0)));
            !active && is_listed_member()
        }
    }

    /// Is the current account listed in the group (as stored, not as in the token)?
    fn is_listed_member() -> bool {
        let (Some(me), Some(group)) = (current_user_sid(), log_users_name()) else { return false };
        unsafe {
            let mut buf: *mut u8 = std::ptr::null_mut();
            let (mut read, mut total) = (0u32, 0u32);
            let status = NetLocalGroupGetMembers(PCWSTR::null(), PCWSTR(group.as_ptr()), 0, &mut buf, MAX_PREFERRED_LENGTH, &mut read, &mut total, None);
            if status != 0 || buf.is_null() {
                return false;
            }
            let members = std::slice::from_raw_parts(buf as *const LOCALGROUP_MEMBERS_INFO_0, read as usize);
            let found = members.iter().any(|m| sid_string(m.lgrmi0_sid).is_some_and(|s| s == me));
            let _ = NetApiBufferFree(Some(buf.cast()));
            found
        }
    }

    /// Starts this exe elevated with `--fps-unlock <SID>` and waits for it to exit.
    pub fn run_elevated(sid: &str) -> Result<u32, &'static str> {
        let exe = std::env::current_exe().map_err(|_| "failed")?;
        let exe: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
        let params = wide(&format!("--fps-unlock {sid}"));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(exe.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe {
            if let Err(e) = ShellExecuteExW(&mut info) {
                return Err(if e.code() == ERROR_CANCELLED.to_hresult() { "cancelled" } else { "failed" });
            }
            if info.hProcess.is_invalid() {
                return Err("failed");
            }
            WaitForSingleObject(info.hProcess, INFINITE);
            let mut code = 1;
            let _ = GetExitCodeProcess(info.hProcess, &mut code);
            let _ = CloseHandle(info.hProcess);
            Ok(code)
        }
    }

    /// In the elevated process: add the account to "Performance Log Users".
    pub fn grant(sid: &str) -> i32 {
        let Some(group) = log_users_name() else { return 2 };
        unsafe {
            let mut psid = PSID::default();
            if ConvertStringSidToSidW(PCWSTR(wide(sid).as_ptr()), &mut psid).is_err() {
                return 2;
            }
            let entry = LOCALGROUP_MEMBERS_INFO_0 { lgrmi0_sid: psid };
            let status = NetLocalGroupAddMembers(PCWSTR::null(), PCWSTR(group.as_ptr()), 0, &entry as *const _ as *const u8, 1);
            let _ = LocalFree(Some(HLOCAL(psid.0)));
            if status == 0 || status == MEMBER_IN_ALIAS { 0 } else { 2 }
        }
    }

    /// Can this (non-elevated) process start a session now? Start one briefly and stop it.
    pub fn can_trace() -> bool {
        let name = wide("NotchFpsProbe");
        let mut props = Props::new();
        let mut handle = CONTROLTRACE_HANDLE::default();
        let ok = unsafe { StartTraceW(&mut handle, PCWSTR(name.as_ptr()), props.ptr()) } == ERROR_SUCCESS;
        if ok {
            stop_session(&name);
        }
        ok
    }
}
