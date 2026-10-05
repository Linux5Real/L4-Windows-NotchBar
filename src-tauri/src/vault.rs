//! Vault: passwords and 2FA codes, local only.
//!
//! - The file (`vault.bin` in the app data folder) is encrypted with Windows DPAPI,
//!   bound to the signed-in Windows user. It is decrypted per call and dropped again;
//!   no plaintext stays in memory between calls.
//! - The 4-digit PIN is stored inside the encrypted file and checked here, never in
//!   the WebView. Wrong attempts lock the vault with a growing delay that survives
//!   restarts. A 4-digit PIN is a gate, not the key: as a key it would fall in
//!   milliseconds, DPAPI protects the file.
//! - Secrets rarely reach the WebView: copying happens here, 2FA seeds never leave
//!   Rust (only the 6-digit codes do). Only "show password" returns a password.
//! - Copies are marked so clipboard histories (ours, Win+V, cloud) skip them, and
//!   passwords/codes are cleared from the clipboard after 30 s.
//! - Optional Windows Hello (setting, off by default): the secrets are additionally
//!   sealed with AES-256-GCM. The key is SHA-256 of a Windows Hello signature over a
//!   random challenge (RSA PKCS#1 v1.5 is deterministic, so the same key comes back
//!   every time). The private key lives in the TPM and signs only after Hello
//!   (face, finger, Windows PIN), so even code running as the user can't read the
//!   secrets without that confirmation. Names and usernames stay readable for the list.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use windows::core::w;
use windows::Win32::Foundation::{LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

/// App-specific DPAPI entropy: other programs of the same user can't decrypt the
/// file by calling DPAPI blindly.
const ENTROPY: &[u8] = b"L4-Notchbar vault v1";
/// Unlocked stays unlocked this long after the last action (the UI also locks on leave).
const UNLOCK_IDLE: Duration = Duration::from_secs(120);
/// Passwords and codes leave the clipboard after this.
const CLEAR_AFTER: Duration = Duration::from_secs(30);
const FREE_ATTEMPTS: u32 = 5;
const FIRST_LOCK_SECS: u64 = 30;
const MAX_LOCK_SECS: u64 = 15 * 60;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Password,
    Totp,
}

#[derive(Serialize, Deserialize, Clone)]
struct Item {
    id: String,
    kind: Kind,
    name: String,
    /// Username/e-mail (passwords) or account label (2FA).
    username: String,
    /// Password, or the base32 seed for 2FA.
    secret: String,
    #[serde(default)]
    otp: Otp,
    created: u64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
struct Otp {
    algorithm: String,
    digits: u32,
    period: u64,
}

impl Default for Otp {
    fn default() -> Self {
        Self { algorithm: "SHA1".into(), digits: 6, period: 30 }
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Hello {
    /// Base64 random challenge that Windows Hello signs.
    challenge: String,
    /// Base64 nonce + AES-GCM ciphertext of {id: secret}.
    sealed: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Data {
    pin: Option<String>,
    pin_passwords: bool,
    pin_totp: bool,
    fails: u32,
    /// Unix seconds; until then no PIN is accepted.
    locked_until: u64,
    items: Vec<Item>,
    #[serde(default)]
    hello: Option<Hello>,
    /// Hello key while the secrets are opened (never written).
    #[serde(skip)]
    key: Option<[u8; 32]>,
}

impl Default for Data {
    fn default() -> Self {
        Self { pin: None, pin_passwords: true, pin_totp: true, fails: 0, locked_until: 0, items: Vec::new(), hello: None, key: None }
    }
}

/// A scanned QR code waits here until the user has typed a name.
struct Pending {
    secret: String,
    otp: Otp,
}

#[derive(Default)]
pub struct VaultState {
    /// Serializes every read-modify-write of the file.
    lock: Mutex<()>,
    unlocked_until: Mutex<Option<Instant>>,
    pending: Mutex<Option<Pending>>,
    /// Windows Hello key, only while unlocked.
    hello_key: Mutex<Option<[u8; 32]>>,
}

// ---------- File + DPAPI ----------

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault.bin"))
}

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
}

fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    unsafe {
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        bytes
    }
}

fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    let entropy = blob(ENTROPY);
    unsafe { CryptProtectData(&blob(plain), w!("L4-Notchbar"), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        .map_err(|e| e.message())?;
    Ok(take(out))
}

fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    let entropy = blob(ENTROPY);
    unsafe { CryptUnprotectData(&blob(cipher), None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        .map_err(|_| "unreadable".to_string())?;
    Ok(take(out))
}

fn load(app: &AppHandle) -> Result<Data, String> {
    let path = path(app)?;
    let Ok(cipher) = std::fs::read(&path) else { return Ok(Data::default()) };
    let plain = unprotect(&cipher)?;
    serde_json::from_slice(&plain).map_err(|_| "unreadable".to_string())
}

/// Like `load`, but with the secrets: with Windows Hello on this needs the key
/// from an unlock ("locked" otherwise). Every command that reads or writes a
/// secret uses this, so `save` can reseal everything.
fn load_full(app: &AppHandle, state: &VaultState) -> Result<Data, String> {
    let mut data = load(app)?;
    let Some(hello) = &data.hello else { return Ok(data) };
    if !is_unlocked(state) {
        return Err("locked".into());
    }
    let key = state.hello_key.lock().unwrap().ok_or("locked")?;
    let secrets = open_sealed(&key, &hello.sealed)?;
    for item in &mut data.items {
        if let Some(secret) = secrets.get(&item.id) {
            item.secret = secret.clone();
        }
    }
    data.key = Some(key);
    Ok(data)
}

/// Atomic: temp file, then rename, so a crash never leaves half a vault.
/// With Windows Hello the secrets are resealed (if opened) and never written in the clear.
fn save(app: &AppHandle, data: &Data) -> Result<(), String> {
    let path = path(app)?;
    let mut out = data.clone();
    if let (Some(hello), Some(key)) = (out.hello.as_mut(), data.key) {
        let secrets: HashMap<&str, &str> = data.items.iter().map(|i| (i.id.as_str(), i.secret.as_str())).collect();
        hello.sealed = seal(&key, &serde_json::to_vec(&secrets).map_err(|e| e.to_string())?)?;
    }
    if out.hello.is_some() {
        for item in &mut out.items {
            item.secret.clear();
        }
    }
    let plain = serde_json::to_vec(&out).map_err(|e| e.to_string())?;
    let cipher = protect(&plain)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, cipher).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------- Unlock ----------

fn is_unlocked(state: &VaultState) -> bool {
    let mut until = state.unlocked_until.lock().unwrap();
    match *until {
        Some(t) if Instant::now() < t => {
            // Sliding: every action keeps it open a bit longer.
            *until = Some(Instant::now() + UNLOCK_IDLE);
            true
        }
        _ => {
            *until = None;
            *state.hello_key.lock().unwrap() = None;
            false
        }
    }
}

/// Errors "locked" when the setting asks for a PIN and the vault isn't unlocked.
fn require(state: &VaultState, needs_pin: bool) -> Result<(), String> {
    if needs_pin && !is_unlocked(state) {
        return Err("locked".into());
    }
    Ok(())
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn valid_pin(pin: &str) -> bool {
    pin.len() == 4 && pin.bytes().all(|b| b.is_ascii_digit())
}

// ---------- Commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    id: String,
    kind: Kind,
    name: String,
    username: String,
    period: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    has_pin: bool,
    unlocked: bool,
    pin_passwords: bool,
    pin_totp: bool,
    /// Seconds until a PIN is accepted again (0 = now).
    locked_for: u64,
    /// The file exists but can't be decrypted (other Windows user, damaged).
    unreadable: bool,
    /// Windows Hello unlocks instead of the PIN.
    hello: bool,
    items: Vec<ItemInfo>,
}

#[tauri::command]
pub fn vault_status(app: AppHandle, state: State<'_, VaultState>) -> Status {
    let _guard = state.lock.lock().unwrap();
    let unlocked = is_unlocked(&state);
    match load(&app) {
        Ok(data) => Status {
            has_pin: data.pin.is_some(),
            unlocked,
            pin_passwords: data.pin_passwords,
            pin_totp: data.pin_totp,
            locked_for: data.locked_until.saturating_sub(now_secs()),
            unreadable: false,
            hello: data.hello.is_some(),
            items: data
                .items
                .iter()
                .map(|i| ItemInfo { id: i.id.clone(), kind: i.kind, name: i.name.clone(), username: i.username.clone(), period: i.otp.period })
                .collect(),
        },
        Err(_) => Status { has_pin: false, unlocked: false, pin_passwords: true, pin_totp: true, locked_for: 0, unreadable: true, hello: false, items: Vec::new() },
    }
}

/// First PIN. Only allowed while none exists.
#[tauri::command]
pub fn vault_setup(pin: String, app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    if !valid_pin(&pin) {
        return Err("pin-format".into());
    }
    let mut data = load(&app)?;
    if data.pin.is_some() {
        return Err("pin-exists".into());
    }
    data.pin = Some(pin);
    save(&app, &data)?;
    *state.unlocked_until.lock().unwrap() = Some(Instant::now() + UNLOCK_IDLE);
    Ok(())
}

/// Errors: "wrong:<attempts left>" or "lockout:<seconds>".
#[tauri::command]
pub fn vault_unlock(pin: String, app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    let mut data = load(&app)?;
    if data.hello.is_some() {
        return Err("hello".into());
    }
    let now = now_secs();
    if data.locked_until > now {
        return Err(format!("lockout:{}", data.locked_until - now));
    }
    let Some(stored) = data.pin.as_deref() else { return Err("no-pin".into()) };
    if constant_eq(stored, &pin) {
        if data.fails != 0 {
            data.fails = 0;
            save(&app, &data)?;
        }
        *state.unlocked_until.lock().unwrap() = Some(Instant::now() + UNLOCK_IDLE);
        return Ok(());
    }
    data.fails += 1;
    let result = if data.fails >= FREE_ATTEMPTS {
        // 30 s, 60 s, 120 s â€¦ up to 15 min.
        let secs = (FIRST_LOCK_SECS << (data.fails - FREE_ATTEMPTS).min(10)).min(MAX_LOCK_SECS);
        data.locked_until = now + secs;
        Err(format!("lockout:{secs}"))
    } else {
        Err(format!("wrong:{}", FREE_ATTEMPTS - data.fails))
    };
    save(&app, &data)?;
    result
}

#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>) {
    *state.unlocked_until.lock().unwrap() = None;
    *state.pending.lock().unwrap() = None;
    *state.hello_key.lock().unwrap() = None;
}

/// New (id = None) or edited password. Editing needs the PIN when passwords are protected.
#[tauri::command]
pub fn vault_save_password(
    id: Option<String>,
    name: String,
    username: String,
    password: String,
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    let mut data = load_full(&app, &state)?;
    if data.pin.is_none() {
        return Err("no-pin".into());
    }
    let name = name.trim().to_string();
    if name.is_empty() || password.is_empty() {
        return Err("missing".into());
    }
    let username = username.trim().to_string();
    match id {
        Some(id) => {
            require(&state, data.pin_passwords)?;
            let item = data.items.iter_mut().find(|i| i.id == id && i.kind == Kind::Password).ok_or("not-found")?;
            item.name = name;
            item.username = username;
            item.secret = password;
        }
        None => data.items.push(Item {
            id: new_id(),
            kind: Kind::Password,
            name,
            username,
            secret: password,
            otp: Otp::default(),
            created: now_secs(),
        }),
    }
    save(&app, &data)
}

/// New 2FA entry. `secret` = typed base32 key or otpauth:// link; None = the scanned QR code.
#[tauri::command]
pub fn vault_add_totp(
    name: String,
    account: String,
    secret: Option<String>,
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("missing".into());
    }
    let mut data = load_full(&app, &state)?;
    let (secret, otp, label_account) = match secret {
        Some(text) => parse_input(&text)?,
        None => {
            let pending = state.pending.lock().unwrap().take().ok_or("no-scan")?;
            (pending.secret, pending.otp, String::new())
        }
    };
    if data.pin.is_none() {
        return Err("no-pin".into());
    }
    let account = if account.trim().is_empty() { label_account } else { account.trim().to_string() };
    data.items.push(Item { id: new_id(), kind: Kind::Totp, name, username: account, secret, otp, created: now_secs() });
    save(&app, &data)
}

/// Always needs the PIN, so nobody can wipe entries in passing.
#[tauri::command]
pub fn vault_delete(id: String, app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    require(&state, true)?;
    let mut data = load_full(&app, &state)?;
    data.items.retain(|i| i.id != id);
    save(&app, &data)
}

/// Shows a password once (the UI hides it again after a few seconds).
#[tauri::command]
pub fn vault_reveal(id: String, app: AppHandle, state: State<'_, VaultState>) -> Result<String, String> {
    let _guard = state.lock.lock().unwrap();
    let data = load_full(&app, &state)?;
    require(&state, data.pin_passwords)?;
    let item = data.items.into_iter().find(|i| i.id == id && i.kind == Kind::Password).ok_or("not-found")?;
    Ok(item.secret)
}

/// field: "username" | "password" | "code". Copied without entering any clipboard history.
#[tauri::command]
pub fn vault_copy(id: String, field: String, app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    let data = if field == "username" { load(&app)? } else { load_full(&app, &state)? };
    let item = data.items.iter().find(|i| i.id == id).ok_or("not-found")?;
    let (text, clear) = match (field.as_str(), item.kind) {
        ("username", _) => (item.username.clone(), false),
        ("password", Kind::Password) => {
            require(&state, data.pin_passwords)?;
            (item.secret.clone(), true)
        }
        ("code", Kind::Totp) => {
            require(&state, data.pin_totp)?;
            (totp(item, now_secs())?, true)
        }
        _ => return Err("field".into()),
    };
    if text.is_empty() {
        return Err("empty".into());
    }
    copy_private(&text, clear)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    id: String,
    code: String,
    /// Seconds left of the current code.
    remaining: u64,
    period: u64,
}

#[tauri::command]
pub fn vault_codes(app: AppHandle, state: State<'_, VaultState>) -> Result<Vec<Code>, String> {
    let _guard = state.lock.lock().unwrap();
    let data = load_full(&app, &state)?;
    require(&state, data.pin_totp)?;
    let now = now_secs();
    data.items
        .iter()
        .filter(|i| i.kind == Kind::Totp)
        .map(|i| {
            let period = i.otp.period.max(1);
            Ok(Code { id: i.id.clone(), code: totp(i, now)?, remaining: period - now % period, period })
        })
        .collect()
}

/// Turning a PIN requirement off needs the PIN; turning it on doesn't.
#[tauri::command]
pub fn vault_options(pin_passwords: bool, pin_totp: bool, app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    let mut data = load(&app)?;
    let weakens = (!pin_passwords && data.pin_passwords) || (!pin_totp && data.pin_totp);
    require(&state, weakens)?;
    data.pin_passwords = pin_passwords;
    data.pin_totp = pin_totp;
    save(&app, &data)
}

#[tauri::command]
pub fn vault_change_pin(pin: String, app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    if !valid_pin(&pin) {
        return Err("pin-format".into());
    }
    require(&state, true)?;
    let mut data = load(&app)?;
    data.pin = Some(pin);
    save(&app, &data)
}

/// Forgot the PIN: deletes everything. There is no other way back in.
#[tauri::command]
pub fn vault_reset(app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap();
    *state.unlocked_until.lock().unwrap() = None;
    *state.pending.lock().unwrap() = None;
    *state.hello_key.lock().unwrap() = None;
    thread::spawn(hello::delete);
    let path = path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Scan {
    issuer: String,
    account: String,
}

/// Reads a QR code from the clipboard (screenshot or copied image file).
/// Errors: "no-image", "no-qr", "not-otp".
#[tauri::command]
pub async fn vault_scan(state: State<'_, VaultState>) -> Result<Scan, String> {
    let text = tauri::async_runtime::spawn_blocking(scan_clipboard).await.map_err(|e| e.to_string())??;
    let (secret, otp, issuer, account) = parse_otpauth(&text).ok_or("not-otp")?;
    *state.pending.lock().unwrap() = Some(Pending { secret, otp });
    Ok(Scan { issuer, account })
}

// ---------- Windows Hello ----------

#[tauri::command]
pub async fn vault_hello_supported() -> bool {
    tauri::async_runtime::spawn_blocking(hello::supported).await.unwrap_or(false)
}

/// Shows the Windows Hello prompt; on success the vault is unlocked with the key.
/// Errors: "hello-cancel", "hello-missing" (credential gone), "hello-failed".
#[tauri::command]
pub async fn vault_hello_unlock(app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    let challenge = {
        let _guard = state.lock.lock().unwrap();
        let hello = load(&app)?.hello.ok_or("no-hello")?;
        b64(&hello.challenge)?
    };
    let key = tauri::async_runtime::spawn_blocking(move || hello::derive_key(false, &challenge))
        .await
        .map_err(|e| e.to_string())??;
    let _guard = state.lock.lock().unwrap();
    let hello = load(&app)?.hello.ok_or("no-hello")?;
    // GCM authenticates: a wrong key can't open the seal.
    open_sealed(&key, &hello.sealed).map_err(|_| "hello-failed".to_string())?;
    *state.hello_key.lock().unwrap() = Some(key);
    *state.unlocked_until.lock().unwrap() = Some(Instant::now() + UNLOCK_IDLE);
    Ok(())
}

/// Turns Windows Hello on. Needs the PIN unlock first; creates the TPM key (prompt).
#[tauri::command]
pub async fn vault_hello_enable(app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    {
        let _guard = state.lock.lock().unwrap();
        let data = load(&app)?;
        if data.hello.is_some() {
            return Ok(());
        }
        if data.pin.is_none() {
            return Err("no-pin".into());
        }
        require(&state, true)?;
    }
    let challenge = Aes256Gcm::generate_key(&mut OsRng).to_vec();
    let sign = challenge.clone();
    let key = tauri::async_runtime::spawn_blocking(move || hello::derive_key(true, &sign))
        .await
        .map_err(|e| e.to_string())??;
    let _guard = state.lock.lock().unwrap();
    let mut data = load(&app)?;
    data.hello = Some(Hello { challenge: base64::engine::general_purpose::STANDARD.encode(&challenge), sealed: String::new() });
    data.key = Some(key);
    save(&app, &data)?;
    *state.hello_key.lock().unwrap() = Some(key);
    *state.unlocked_until.lock().unwrap() = Some(Instant::now() + UNLOCK_IDLE);
    Ok(())
}

/// Turns Windows Hello off: needs a Hello unlock; the secrets go back under DPAPI only.
#[tauri::command]
pub async fn vault_hello_disable(app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    {
        let _guard = state.lock.lock().unwrap();
        let mut data = load_full(&app, &state)?;
        if data.hello.is_none() {
            return Ok(());
        }
        data.hello = None;
        data.key = None;
        save(&app, &data)?;
        *state.hello_key.lock().unwrap() = None;
    }
    let _ = tauri::async_runtime::spawn_blocking(hello::delete).await;
    Ok(())
}

fn b64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| "unreadable".to_string())
}

fn seal(key: &[u8; 32], plain: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut out = nonce.to_vec();
    out.extend(cipher.encrypt(&nonce, plain).map_err(|_| "seal".to_string())?);
    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}

fn open_sealed(key: &[u8; 32], sealed: &str) -> Result<HashMap<String, String>, String> {
    if sealed.is_empty() {
        return Ok(HashMap::new());
    }
    let bytes = b64(sealed)?;
    if bytes.len() < 12 {
        return Err("unreadable".into());
    }
    let (nonce, body) = bytes.split_at(12);
    let plain = Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(nonce), body)
        .map_err(|_| "unreadable".to_string())?;
    serde_json::from_slice(&plain).map_err(|_| "unreadable".to_string())
}

mod hello {
    use sha2::{Digest, Sha256};
    use windows::core::HSTRING;
    use windows::Security::Credentials::{KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus};
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    const NAME: &str = "L4-Notchbar Vault";

    fn init() {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    }

    pub fn supported() -> bool {
        init();
        KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()).unwrap_or(false)
    }

    fn status(s: KeyCredentialStatus) -> Result<(), String> {
        match s {
            KeyCredentialStatus::Success => Ok(()),
            KeyCredentialStatus::UserCanceled => Err("hello-cancel".into()),
            KeyCredentialStatus::NotFound => Err("hello-missing".into()),
            _ => Err("hello-failed".into()),
        }
    }

    /// Signs the challenge with the Hello key (prompt) → SHA-256 = AES key.
    /// `create`: make a new key first (turning Hello on).
    pub fn derive_key(create: bool, challenge: &[u8]) -> Result<[u8; 32], String> {
        init();
        let fail = |_: windows::core::Error| "hello-failed".to_string();
        let name = HSTRING::from(NAME);
        let result = if create {
            KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::ReplaceExisting).and_then(|op| op.join())
        } else {
            KeyCredentialManager::OpenAsync(&name).and_then(|op| op.join())
        }
        .map_err(fail)?;
        status(result.Status().map_err(fail)?)?;
        let credential = result.Credential().map_err(fail)?;
        let data = CryptographicBuffer::CreateFromByteArray(challenge).map_err(fail)?;
        let signed = credential.RequestSignAsync(&data).and_then(|op| op.join()).map_err(fail)?;
        status(signed.Status().map_err(fail)?)?;
        let mut bytes = windows::core::Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(&signed.Result().map_err(fail)?, &mut bytes).map_err(fail)?;
        Ok(Sha256::digest(bytes.as_slice()).into())
    }

    pub fn delete() {
        init();
        let _ = KeyCredentialManager::DeleteAsync(&HSTRING::from(NAME)).and_then(|op| op.join());
    }
}

fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:x}")
}

// ---------- TOTP (RFC 6238) ----------

macro_rules! hmac {
    ($hash:ty, $key:expr, $msg:expr) => {{
        let mut mac = <Hmac<$hash> as Mac>::new_from_slice($key).expect("HMAC takes any key length");
        mac.update($msg);
        mac.finalize().into_bytes().to_vec()
    }};
}


fn totp(item: &Item, now: u64) -> Result<String, String> {
    let key = base32(&item.secret).ok_or("secret")?;
    let counter = (now / item.otp.period.max(1)).to_be_bytes();
    let hash = match item.otp.algorithm.as_str() {
        "SHA256" => hmac!(sha2::Sha256, &key, &counter),
        "SHA512" => hmac!(sha2::Sha512, &key, &counter),
        _ => hmac!(sha1::Sha1, &key, &counter),
    };
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let bin = u32::from_be_bytes([hash[offset] & 0x7f, hash[offset + 1], hash[offset + 2], hash[offset + 3]]);
    let digits = item.otp.digits.clamp(6, 8);
    Ok(format!("{:0width$}", bin % 10u32.pow(digits), width = digits as usize))
}

/// RFC 4648 base32, case-insensitive, ignores spaces, dashes and padding.
fn base32(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in input.chars().filter(|c| !matches!(c, ' ' | '-' | '=')) {
        let v = match c.to_ascii_uppercase() {
            c @ 'A'..='Z' => c as u32 - 'A' as u32,
            c @ '2'..='7' => c as u32 - '2' as u32 + 26,
            _ => return None,
        };
        buffer = (buffer << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Normalized base32 seed: uppercase without spaces. At least 80 bits (RFC 4226 minimum is 128,
/// but some services use 80).
fn normalize_secret(raw: &str) -> Option<String> {
    let secret: String = raw.chars().filter(|c| !matches!(c, ' ' | '-' | '=')).map(|c| c.to_ascii_uppercase()).collect();
    (base32(&secret)?.len() >= 10).then_some(secret)
}

/// Typed input: a base32 key or a full otpauth:// link.
fn parse_input(text: &str) -> Result<(String, Otp, String), String> {
    let text = text.trim();
    if text.starts_with("otpauth://") {
        let (secret, otp, _, account) = parse_otpauth(text).ok_or("not-otp")?;
        return Ok((secret, otp, account));
    }
    Ok((normalize_secret(text).ok_or("secret")?, Otp::default(), String::new()))
}

/// otpauth://totp/Issuer:account?secret=â€¦&issuer=â€¦&algorithm=SHA1&digits=6&period=30
fn parse_otpauth(url: &str) -> Option<(String, Otp, String, String)> {
    let rest = url.trim().strip_prefix("otpauth://")?;
    let (kind, rest) = rest.split_once('/')?;
    if !kind.eq_ignore_ascii_case("totp") {
        return None;
    }
    let (label, query) = rest.split_once('?').unwrap_or((rest, ""));
    let label = percent_decode(label);
    let (label_issuer, account) = match label.split_once(':') {
        Some((i, a)) => (i.trim().to_string(), a.trim().to_string()),
        None => (String::new(), label.trim().to_string()),
    };
    let mut otp = Otp::default();
    let (mut secret, mut issuer) = (None, None);
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = percent_decode(v);
        match k.to_ascii_lowercase().as_str() {
            "secret" => secret = normalize_secret(&v),
            "issuer" => issuer = Some(v.trim().to_string()),
            "algorithm" => otp.algorithm = v.to_ascii_uppercase(),
            "digits" => otp.digits = v.parse().ok().filter(|d| (6..=8).contains(d))?,
            "period" => otp.period = v.parse().ok().filter(|p| (1..=300).contains(p))?,
            _ => {}
        }
    }
    if !matches!(otp.algorithm.as_str(), "SHA1" | "SHA256" | "SHA512") {
        return None;
    }
    Some((secret?, otp, issuer.filter(|i| !i.is_empty()).unwrap_or(label_issuer), account))
}

fn percent_decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- QR from the clipboard ----------

fn scan_clipboard() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|_| "no-image")?;
    let (w, h, luma) = if let Ok(img) = clipboard.get_image() {
        let luma: Vec<u8> = img
            .bytes
            .chunks_exact(4)
            .map(|p| ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8)
            .collect();
        (img.width, img.height, luma)
    } else if let Some(file) = clipboard.get().file_list().ok().and_then(|f| f.into_iter().next()) {
        let img = image::open(file).map_err(|_| "no-image")?.to_luma8();
        (img.width() as usize, img.height() as usize, img.into_raw())
    } else {
        return Err("no-image".into());
    };
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| luma[y * w + x]);
    prepared
        .detect_grids()
        .into_iter()
        .find_map(|grid| grid.decode().ok().map(|(_, text)| text))
        .ok_or_else(|| "no-qr".into())
}

// ---------- Private clipboard ----------

/// Writes text and marks it so clipboard histories skip it (KeePass/1Password convention).
fn copy_private(text: &str, clear: bool) -> Result<(), String> {
    unsafe {
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        if !opened {
            return Err("clipboard".into());
        }
        let result = (|| -> windows::core::Result<()> {
            EmptyClipboard()?;
            let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            set_data(13 /* CF_UNICODETEXT */, bytes_of(&wide))?;
            let zero = 0u32.to_ne_bytes();
            set_data(RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")), &zero)?;
            set_data(RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")), &zero)?;
            set_data(RegisterClipboardFormatW(w!("CanUploadToCloudClipboard")), &zero)?;
            Ok(())
        })();
        let _ = CloseClipboard();
        result.map_err(|e| e.message())?;
    }
    if clear {
        let seq = unsafe { GetClipboardSequenceNumber() };
        thread::spawn(move || {
            thread::sleep(CLEAR_AFTER);
            // Only if nothing new was copied in between.
            if unsafe { GetClipboardSequenceNumber() } == seq && unsafe { OpenClipboard(None) }.is_ok() {
                unsafe {
                    let _ = EmptyClipboard();
                    let _ = CloseClipboard();
                }
            }
        });
    }
    Ok(())
}

fn bytes_of(wide: &[u16]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2) }
}

unsafe fn set_data(format: u32, data: &[u8]) -> windows::core::Result<()> {
    let global = GlobalAlloc(GMEM_MOVEABLE, data.len().max(1))?;
    let ptr = GlobalLock(global) as *mut u8;
    if !ptr.is_null() {
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        let _ = GlobalUnlock(global);
    }
    // On success the clipboard owns the memory.
    SetClipboardData(format, Some(HANDLE(global.0)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(secret: &str, algorithm: &str, digits: u32) -> Item {
        Item {
            id: "t".into(),
            kind: Kind::Totp,
            name: "t".into(),
            username: String::new(),
            secret: secret.into(),
            otp: Otp { algorithm: algorithm.into(), digits, period: 30 },
            created: 0,
        }
    }

    /// RFC 6238 appendix B test vectors.
    #[test]
    fn rfc6238() {
        let sha1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
        assert_eq!(totp(&item(sha1, "SHA1", 8), 59).unwrap(), "94287082");
        assert_eq!(totp(&item(sha1, "SHA1", 8), 1111111109).unwrap(), "07081804");
        assert_eq!(totp(&item(sha1, "SHA1", 8), 20000000000).unwrap(), "65353130");
        let sha256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
        assert_eq!(totp(&item(sha256, "SHA256", 8), 59).unwrap(), "46119246");
        let sha512 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";
        assert_eq!(totp(&item(sha512, "SHA512", 8), 59).unwrap(), "90693936");
    }

    #[test]
    fn hello_seal() {
        let key = [7u8; 32];
        let sealed = seal(&key, br#"{"a":"secret"}"#).unwrap();
        assert_eq!(open_sealed(&key, &sealed).unwrap()["a"], "secret");
        assert!(open_sealed(&[8u8; 32], &sealed).is_err());
        assert!(open_sealed(&key, "").unwrap().is_empty());
    }

    #[test]
    fn otpauth() {
        let (secret, otp, issuer, account) =
            parse_otpauth("otpauth://totp/ACME%20Co:john.doe%40email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&digits=6&period=30").unwrap();
        assert_eq!(secret, "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ");
        assert_eq!(otp, Otp::default());
        assert_eq!(issuer, "ACME Co");
        assert_eq!(account, "john.doe@email.com");
        assert!(parse_otpauth("otpauth://hotp/x?secret=HXDMVJECJJWSRB3H").is_none());
        assert!(parse_input("jbsw y3dp ehpk 3pxp").is_ok());
        assert!(parse_input("not a key!").is_err());
    }
}
