//! API keys in Windows Credential Manager.
//!
//! The frontend can only set, delete and check whether a key exists. Only Rust can
//! read them (for HTTP calls), so no secret ever reaches the WebView.
//! Visible under Control Panel → Credential Manager → "Notch/…".

use windows::core::{HSTRING, PWSTR};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

/// Allowed names, so the frontend can't create arbitrary entries.
const ALLOWED: &[&str] = &["t212.key", "t212.secret", "ai.anthropic", "ai.openai", "ai.openrouter", "ai.custom", "discord.secret", "discord.token"];

fn target(name: &str) -> Result<HSTRING, String> {
    if !ALLOWED.contains(&name) {
        return Err(format!("Unbekannter Schlüssel: {name}"));
    }
    Ok(HSTRING::from(format!("Notch/{name}")))
}

pub fn read(name: &str) -> Option<String> {
    let target = target(name).ok()?;
    unsafe {
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        CredReadW(&target, CRED_TYPE_GENERIC, None, &mut cred).ok()?;
        let blob = std::slice::from_raw_parts((*cred).CredentialBlob, (*cred).CredentialBlobSize as usize);
        let value = String::from_utf8(blob.to_vec()).ok();
        CredFree(cred as *const _);
        value
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    // Check the name against the allowlist.
    target(&name)?;
    let value = value.trim();
    if value.is_empty() {
        return secret_delete(name);
    }
    let mut blob = value.as_bytes().to_vec();
    let mut target_w: Vec<u16> = format!("Notch/{name}").encode_utf16().chain(Some(0)).collect();
    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target_w.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    unsafe { CredWriteW(&cred, 0) }.map_err(|e| e.message())
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    let target = target(&name)?;
    // Not existing isn't an error.
    let _ = unsafe { CredDeleteW(&target, CRED_TYPE_GENERIC, None) };
    Ok(())
}

#[tauri::command]
pub fn secret_has(name: String) -> bool {
    read(&name).is_some()
}
