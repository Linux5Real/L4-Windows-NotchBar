//! Ask: AI chat with streaming.
//!
//! Providers:
//! - `openrouter`, `openai`, `custom`: OpenAI-compatible `/chat/completions` (SSE).
//!   Effort as `reasoning_effort` (OpenRouter: `reasoning.effort`).
//! - `anthropic`: Claude Messages API (SSE), effort as `output_config.effort`.
//! - `opencode`: a Notch-owned `opencode serve` child process (see `opencode.rs`),
//!   so the free OpenCode models work without an API key or a proxy plugin.
//!
//! The key comes from Credential Manager (`ai.<provider>`) and only leaves Rust in the
//! Authorization header. Chunks go to the frontend as `ai://delta`; `ai_cancel` stops
//! a running stream.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::secrets;

const SYSTEM_PROMPT: &str = "Du bist Ask, ein schneller Assistent in einer kleinen Notch am oberen Bildschirmrand. \
Antworte knapp und direkt in der Sprache der Frage. In Arabic, use clear, natural Arabic: write \"نوتش\" for Notch, never \"الشق\"; translate ordinary English words and keep only names, code, paths, and established technical terms in English. \
Nutze Markdown sparsam: **fett** für Namen, `Code` für Pfade und Befehle, Listen nur wenn nötig. Keine Markdown-Überschriften in kurzen Antworten.";

/// Claude models where the server falls back to a suitable model on refusal
/// (`fallbacks: "default"`).
const CLAUDE_FALLBACK_MODELS: &[&str] = &["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5-5"];

#[derive(Clone, Deserialize)]
pub struct Msg {
    role: String,
    content: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfig {
    pub provider: String,
    pub base_url: Option<String>,
    pub model: String,
    /// low | medium | high | xhigh
    pub effort: Option<String>,
    /// OpenCode only: `chat` (read-only) or `studio` (files and commands).
    pub mode: Option<String>,
}

#[derive(Default)]
pub struct AiState {
    cancelled: Mutex<HashSet<String>>,
}

#[derive(Clone, Serialize)]
struct Delta<'a> {
    id: &'a str,
    text: &'a str,
    /// true = replace the whole content (OpenCode rewrote the message); false = append.
    replace: bool,
}

#[tauri::command]
pub async fn ai_chat(
    id: String,
    config: ChatConfig,
    messages: Vec<Msg>,
    app: AppHandle,
    state: State<'_, AiState>,
    opencode: State<'_, crate::opencode::OpenCodeState>,
) -> Result<(), String> {
    // OpenCode is a local child process with its own random password; it needs
    // no key from Credential Manager. All other providers do.
    if config.provider == "opencode" {
        let prompt = messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.trim())
            .unwrap_or_default();
        if prompt.is_empty() {
            return Err("Leere Nachricht".into());
        }
        let result = crate::opencode::stream_chat(
            &config.model,
            config.mode.as_deref().unwrap_or("chat"),
            prompt,
            &mut |text: &str, replace: bool| {
                let _ = app.emit("ai://delta", Delta { id: &id, text, replace });
            },
            || state.cancelled.lock().unwrap().contains(&id),
            opencode.inner(),
            &mut |text: &str, replace: bool| {
                let _ = app.emit("ai://reasoning", Delta { id: &id, text, replace });
            },
        )
        .await;
        state.cancelled.lock().unwrap().remove(&id);
        return result;
    }

    let key = secrets::read(&format!("ai.{}", config.provider)).ok_or("no-key")?;
    let result = stream_chat(&config, &key, &messages, |text| {
        let _ = app.emit("ai://delta", Delta { id: &id, text, replace: false });
    }, || state.cancelled.lock().unwrap().contains(&id))
    .await;
    state.cancelled.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn ai_cancel(id: String, state: State<'_, AiState>) {
    state.cancelled.lock().unwrap().insert(id);
}

/// Ends the Notch session and stops the OpenCode child process. Called when the
/// Ask chat is cleared.
#[tauri::command]
pub async fn ai_reset(opencode: State<'_, crate::opencode::OpenCodeState>) -> Result<(), String> {
    crate::opencode::reset(opencode.inner()).await;
    Ok(())
}

/// Core without Tauri, so backend tests can use it too.
pub async fn stream_chat(
    config: &ChatConfig,
    key: &str,
    messages: &[Msg],
    mut on_delta: impl FnMut(&str),
    cancelled: impl Fn() -> bool,
) -> Result<(), String> {
    let model = config.model.trim();
    if model.is_empty() {
        return Err("Kein Modell eingetragen".into());
    }
    let effort = config.effort.as_deref().filter(|e| !e.is_empty());
    let anthropic = config.provider == "anthropic";

    let url = match config.provider.as_str() {
        "anthropic" => "https://api.anthropic.com/v1/messages".to_string(),
        "openai" => "https://api.openai.com/v1/chat/completions".to_string(),
        "openrouter" => "https://openrouter.ai/api/v1/chat/completions".to_string(),
        "custom" => {
            let base = config.base_url.as_deref().unwrap_or("").trim().trim_end_matches('/');
            // https everywhere, except plain http for loopback endpoints.
            let ok = reqwest::Url::parse(base).map(|u| {
                (u.scheme() == "https")
                    || (u.scheme() == "http"
                        && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "::1")))
            });
            if !matches!(ok, Ok(true)) {
                return Err("Base-URL muss mit https:// beginnen".into());
            }
            format!("{base}/chat/completions")
        }
        other => return Err(format!("Unbekannter Anbieter: {other}")),
    };

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // Reasoning models can think for a while before the first token.
        .read_timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let request = if anthropic {
        let mut body = json!({
            "model": model,
            "max_tokens": 64000,
            "stream": true,
            "system": SYSTEM_PROMPT,
            "messages": messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
        });
        if let Some(e) = effort {
            body["output_config"] = json!({ "effort": e });
        }
        let mut req = client.post(&url).header("x-api-key", key).header("anthropic-version", "2023-06-01");
        if CLAUDE_FALLBACK_MODELS.contains(&model) {
            body["fallbacks"] = json!("default");
            req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        req.json(&body)
    } else {
        let mut all = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
        all.extend(messages.iter().map(|m| json!({ "role": m.role, "content": m.content })));
        let mut body = json!({ "model": model, "stream": true, "messages": all });
        if let Some(e) = effort {
            match config.provider.as_str() {
                "openrouter" => body["reasoning"] = json!({ "effort": e }),
                _ => body["reasoning_effort"] = json!(e),
            }
        }
        let mut req = client.post(&url);
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
        if config.provider == "openrouter" {
            req = req.header("X-Title", "Notch");
        }
        req.json(&body)
    };

    let mut res = request.send().await.map_err(|e| format!("Keine Verbindung: {}", short(&e.to_string())))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        return Err(http_error(status, &text));
    }

    // Read SSE line by line. Multi-byte UTF-8 chars must survive chunk
    // boundaries: keep raw bytes and decode complete lines only (a 0x0A byte
    // never occurs inside a multi-byte sequence).
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        if cancelled() {
            return Ok(());
        }
        // Cap the wait so the Stop button reacts even when the provider is silent.
        let chunk = match tokio::time::timeout(Duration::from_millis(250), res.chunk()).await {
            Ok(chunk) => chunk.map_err(|e| format!("Verbindung abgebrochen: {}", short(&e.to_string())))?,
            Err(_) => continue,
        };
        let Some(chunk) = chunk else {
            return Ok(());
        };
        buffer.extend_from_slice(&chunk);
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = event.get("error") {
                return Err(err["message"].as_str().unwrap_or("Fehler vom Anbieter").to_string());
            }
            let text = if anthropic {
                (event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta")
                    .then(|| event["delta"]["text"].as_str())
                    .flatten()
            } else {
                event["choices"][0]["delta"]["content"].as_str()
            };
            if let Some(t) = text.filter(|t| !t.is_empty()) {
                on_delta(t);
            }
        }
    }
}

fn http_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["message"].as_str()).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(140).collect());
    match status {
        401 | 403 => format!("Schlüssel abgelehnt ({status}) – {}", short(&detail)),
        404 => format!("Nicht gefunden (404) – Base-URL oder Modell prüfen. {}", short(&detail)),
        429 => "Limit erreicht (429) – kurz warten".into(),
        _ => format!("Fehler {status}: {}", short(&detail)),
    }
}

fn short(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() > 160 { format!("{}…", s.chars().take(160).collect::<String>()) } else { s.to_string() }
}
