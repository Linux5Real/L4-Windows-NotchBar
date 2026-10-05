//! Systemwerte für das Hardware-Tool: CPU, RAM, GPU (Auslastung + Grafikspeicher), Ping.
//! Wird nur abgefragt, solange das Tool offen ist (Frontend pollt ~1×/s).
//!
//! - GPU-Auslastung: Leistungsindikator "GPU Engine(*engtype_3D)" — derselbe Wert wie im
//!   Task-Manager, herstellerunabhängig (NVIDIA, AMD, Intel).
//! - Grafikspeicher: "GPU Adapter Memory(*)\Dedicated Usage" + Gesamtgröße aus DXGI.
//! - Ping: ICMP-Echo an 1.1.1.1 in einem eigenen Thread (alle 2 s, nur während abgefragt wird).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::System;
use tauri::State;
use windows::core::w;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
use windows::Win32::NetworkManagement::IpHelper::{IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
    PDH_HCOUNTER, PDH_HQUERY,
};

/// 1.1.1.1 in Netzwerk-Byte-Reihenfolge.
const PING_TARGET: u32 = u32::from_le_bytes([1, 1, 1, 1]);
const PING_EVERY: Duration = Duration::from_secs(2);
/// Kein Abruf mehr seit so lange → Ping-Thread pausiert.
const PING_IDLE: Duration = Duration::from_secs(5);
/// "Kein Ping" (Zeitüberschreitung / offline).
const NO_PING: u64 = u64::MAX;

pub struct SystemState(Mutex<Probe>);

struct Probe {
    sys: System,
    gpu: Option<Gpu>,
    gpu_name: Option<String>,
    gpu_total: u64,
    ping: Arc<Ping>,
}

struct Ping {
    ms: AtomicU64,
    /// Letzter Abruf (ms seit Start), steuert, ob der Thread pingt.
    wanted_at: Mutex<Instant>,
}

/// PDH-Abfrage für GPU-Auslastung und Grafikspeicher.
struct Gpu {
    query: PDH_HQUERY,
    util: PDH_HCOUNTER,
    mem: PDH_HCOUNTER,
}

// PDH-Handles sind Zeiger; Zugriff nur unter dem Mutex.
unsafe impl Send for Gpu {}

impl Default for SystemState {
    fn default() -> Self {
        let (gpu_name, gpu_total) = adapter().unzip();
        let ping = Arc::new(Ping { ms: AtomicU64::new(NO_PING), wanted_at: Mutex::new(Instant::now() - PING_IDLE) });
        spawn_ping(ping.clone());
        Self(Mutex::new(Probe { sys: System::new(), gpu: Gpu::open(), gpu_name, gpu_total: gpu_total.flatten().unwrap_or(0), ping }))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    cpu: f32,
    cpu_name: String,
    mem_used: u64,
    mem_total: u64,
    /// None, wenn die GPU-Indikatoren fehlen.
    gpu: Option<f64>,
    gpu_name: Option<String>,
    gpu_mem_used: u64,
    gpu_mem_total: u64,
    /// Millisekunden; None = keine Antwort.
    ping: Option<u64>,
}

#[tauri::command]
pub fn system_stats(state: State<'_, SystemState>) -> Stats {
    let mut p = state.0.lock().unwrap();
    p.sys.refresh_cpu_usage();
    p.sys.refresh_memory();
    if p.sys.cpus().is_empty() || p.sys.cpus()[0].brand().is_empty() {
        p.sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    }
    *p.ping.wanted_at.lock().unwrap() = Instant::now();

    let (gpu, gpu_mem_used) = p.gpu.as_ref().map(Gpu::read).unwrap_or((None, 0));
    let ping = p.ping.ms.load(Ordering::Relaxed);
    Stats {
        cpu: p.sys.global_cpu_usage(),
        cpu_name: p.sys.cpus().first().map(|c| clean_name(c.brand())).unwrap_or_default(),
        mem_used: p.sys.used_memory(),
        mem_total: p.sys.total_memory(),
        gpu,
        gpu_name: p.gpu_name.clone(),
        gpu_mem_used,
        gpu_mem_total: p.gpu_total,
        ping: (ping != NO_PING).then_some(ping),
    }
}

impl Gpu {
    fn open() -> Option<Self> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(None, 0, &mut query) != 0 {
                return None;
            }
            let mut util = PDH_HCOUNTER::default();
            let mut mem = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(query, w!("\\GPU Engine(*engtype_3D)\\Utilization Percentage"), 0, &mut util) != 0 {
                return None;
            }
            let _ = PdhAddEnglishCounterW(query, w!("\\GPU Adapter Memory(*)\\Dedicated Usage"), 0, &mut mem);
            // Auslastung ist eine Rate → braucht zwei Messungen; die erste hier.
            PdhCollectQueryData(query);
            Some(Self { query, util, mem })
        }
    }

    /// (Auslastung %, belegter Grafikspeicher in Bytes)
    fn read(&self) -> (Option<f64>, u64) {
        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return (None, 0);
            }
        }
        // Pro Prozess eine Instanz → aufsummieren (wie der Task-Manager), gedeckelt bei 100.
        let util = sum_counter(self.util).map(|v| v.min(100.0));
        let mem = sum_counter(self.mem).unwrap_or(0.0) as u64;
        (util, mem)
    }
}

fn sum_counter(counter: PDH_HCOUNTER) -> Option<f64> {
    unsafe {
        let (mut size, mut count) = (0u32, 0u32);
        PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if size == 0 {
            return None;
        }
        // Puffer als u64 ausgerichtet; enthält Items + die Instanznamen dahinter.
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
            return None;
        }
        let slice = std::slice::from_raw_parts(items, count as usize);
        Some(slice.iter().filter(|i| i.FmtValue.CStatus == 0).map(|i| i.FmtValue.Anonymous.doubleValue).sum())
    }
}

/// Name und Grafikspeicher der stärksten echten GPU (meiste dedizierte VRAM).
fn adapter() -> Option<(String, Option<u64>)> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut best: Option<(String, u64)> = None;
        for i in 0.. {
            let Ok(adapter) = factory.EnumAdapters1(i) else { break };
            let Ok(desc) = adapter.GetDesc1() else { continue };
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let vram = desc.DedicatedVideoMemory as u64;
            if best.as_ref().is_none_or(|(_, b)| vram > *b) {
                let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
                best = Some((clean_name(&String::from_utf16_lossy(&desc.Description[..len])), vram));
            }
        }
        best.map(|(name, vram)| (name, Some(vram)))
    }
}

/// "NVIDIA GeForce RTX 4070 Ti" → "GeForce RTX 4070 Ti"; "(R)", "(TM)", "CPU @ …" raus.
fn clean_name(name: &str) -> String {
    let mut s = name.replace("(R)", "").replace("(TM)", "").replace("(tm)", "");
    if let Some(i) = s.find(" @ ") {
        s.truncate(i);
    }
    for prefix in ["NVIDIA ", "AMD ", "Intel "] {
        if s.starts_with(prefix) && s.len() > prefix.len() + 6 {
            s = s[prefix.len()..].to_string();
        }
    }
    s.replace(" CPU", "").replace("  ", " ").replace(" Processor", "").trim().to_string()
}

fn spawn_ping(ping: Arc<Ping>) {
    thread::spawn(move || {
        let Ok(handle) = (unsafe { IcmpCreateFile() }) else { return };
        let payload = [0u8; 32];
        let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 8];
        loop {
            if ping.wanted_at.lock().unwrap().elapsed() > PING_IDLE {
                thread::sleep(Duration::from_millis(500));
                continue;
            }
            let n = unsafe {
                IcmpSendEcho(handle, PING_TARGET, payload.as_ptr().cast(), payload.len() as u16, None, reply.as_mut_ptr().cast(), reply.len() as u32, 1000)
            };
            let ms = if n > 0 {
                let r = unsafe { &*(reply.as_ptr() as *const ICMP_ECHO_REPLY) };
                if r.Status == 0 { r.RoundTripTime as u64 } else { NO_PING }
            } else {
                NO_PING
            };
            ping.ms.store(ms, Ordering::Relaxed);
            thread::sleep(PING_EVERY);
        }
        #[allow(unreachable_code)]
        unsafe {
            let _ = IcmpCloseHandle(handle);
        }
    });
}
