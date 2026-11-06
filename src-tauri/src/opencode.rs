//! Direct connection to a local OpenCode server.
//!
//! OpenCode's free models only answer requests that come from OpenCode itself.
//! OpenChamber solves this by launching `opencode serve` with a random
//! `OPENCODE_PASSWORD` and talking to OpenCode's native `/api/...` endpoints
//! over HTTP Basic auth (see `packages/web/server/lib/opencode/lifecycle.js`
//! and `auth-state-runtime.js` in the OpenChamber repository).
//!
//! We do the same, but with our own child process, so Notch talks directly to
//! OpenCode and does not depend on OpenChamber running. The password is random
//! per run and only leaves this process in the loopback Authorization header.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

/// Free model that works without an account in the current OpenCode builds.
pub const DEFAULT_MODEL: &str = "opencode/deepseek-v4.1-flash-free";

/// Ask has one unified agent: it answers, reads, and — when asked — creates
/// files, runs commands, and uses the network. Permissions are set to `allow`
/// so nothing prompts for confirmation.
const STUDIO_AGENT: &str = "studio";

const SERVER_START_TIMEOUT: Duration = Duration::from_secs(20);
const REPLY_TIMEOUT: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(350);

#[derive(Default)]
pub struct OpenCodeState {
    server: Mutex<Option<OpenCodeServer>>,
    session: Mutex<Option<SessionInfo>>,
    /// True while a caller is spawning the server; other callers wait instead of double-spawn.
    starting: Mutex<bool>,
}

struct OpenCodeServer {
    child: Child,
    base_url: String,
    password: String,
}

impl Drop for OpenCodeServer {
    fn drop(&mut self) {
        // Closing stdin ends the --stdio lease; kill() is the hard backstop.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone)]
struct Connection {
    base_url: String,
    password: String,
}

impl Connection {
    fn auth_header(&self) -> String {
        let credentials = BASE64.encode(format!("opencode:{}", self.password));
        format!("Basic {credentials}")
    }
}

#[derive(Clone)]
struct SessionInfo {
    base_url: String,
    id: String,
    model: String,
    agent: String,
}

impl OpenCodeServer {
    fn connection(&self) -> Connection {
        Connection { base_url: self.base_url.clone(), password: self.password.clone() }
    }
}

/// One selectable model from OpenCode's own catalog. `name` is already cleaned
/// for the UI; `id` keeps the real `provider/model` identifier (OpenCode's free
/// identifiers end in `-free`, but that suffix is not shown).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub context: u64,
}

#[tauri::command]
pub async fn opencode_models(state: State<'_, OpenCodeState>) -> Result<Vec<ModelInfo>, String> {
    list_models(state.inner()).await
}

async fn list_models(state: &OpenCodeState) -> Result<Vec<ModelInfo>, String> {
    let conn = ensure_server(state).await?;
    let client = api_client()?;
    let res = client
        .get(format!("{}/api/model", conn.base_url))
        .header("Authorization", conn.auth_header())
        .send()
        .await
        .map_err(|e| format!("Keine Verbindung zu OpenCode: {}", short(&e.to_string())))?;
    if !res.status().is_success() {
        return Err(api_error(res).await);
    }
    let v: Value = res
        .json()
        .await
        .map_err(|e| format!("OpenCode-Antwort: {}", short(&e.to_string())))?;
    let list = v["data"].as_array().cloned().unwrap_or_default();

    let mut models = Vec::new();
    for model in list {
        if model["enabled"].as_bool() == Some(false) {
            continue;
        }
        if model["status"].as_str() == Some("deprecated") {
            continue;
        }
        let Some(model_id) = model["modelID"].as_str().or_else(|| model["id"].as_str()) else {
            continue;
        };
        let provider = model["providerID"].as_str().unwrap_or("opencode");
        let raw_name = model["name"].as_str().unwrap_or(model_id);
        models.push(ModelInfo {
            id: format!("{provider}/{model_id}"),
            provider: provider.to_string(),
            name: display_name(raw_name),
            context: model["limit"]["context"].as_u64().unwrap_or(0),
        });
    }

    // OpenCode's free models are the `opencode` provider; keep them first
    // without labeling them. The sort is stable, so the API's release order
    // stays inside each provider group.
    models.sort_by_key(|m| m.provider != "opencode");
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

/// "Flint 40B Free" -> "Flint 40B"; the raw identifier still has `-free`.
fn display_name(raw: &str) -> String {
    let mut name = raw
        .replace("-free", "")
        .replace("-Free", "")
        .replace("-FREE", "");
    name = name
        .split_whitespace()
        .filter(|word| !word.eq_ignore_ascii_case("free"))
        .collect::<Vec<_>>()
        .join(" ");
    for empty in ["( )", "(  )", "()", "[ ]", "[]"] {
        name = name.replace(empty, "");
    }
    let name = name
        .trim_matches(|c: char| c.is_whitespace() || "()[]{}·-–—:".contains(c))
        .trim();
    if name.is_empty() {
        raw.to_string()
    } else {
        name.to_string()
    }
}

/// Stops the server and forgets the session. Used when the chat is cleared and
/// when the app exits.
pub async fn reset(state: &OpenCodeState) {
    let session = state.session.lock().unwrap().take();
    let server = state.server.lock().unwrap().take();

    if let (Some(session), Some(server)) = (session, server) {
        // Best effort: remove the Notch session from OpenCode's history.
        if let Ok(client) = api_client() {
            let _ = client
                .delete(format!("{}/api/session/{}", server.base_url, session.id))
                .header("Authorization", server.connection().auth_header())
                .send()
                .await;
        }
        // `server` drops here, which stops the child process.
    }
}

/// Synchronous cleanup for the app-exit handler.
pub fn shutdown(state: &OpenCodeState) {
    let _ = state.session.lock().unwrap().take();
    let server = state.server.lock().unwrap().take();
    drop(server);
}

/// Chat only reads; Studio works in the workspace and may write and run commands.
fn agent_for_mode(mode: &str) -> &'static str {
    if mode == "studio" {
        STUDIO_AGENT
    } else {
        "chat"
    }
}

fn session_title(agent: &str) -> &'static str {
    if agent == STUDIO_AGENT {
        "Notch Studio"
    } else {
        "Notch Chat"
    }
}

/// Streams one reply from a Notch-owned OpenCode server.
/// The bool tells the frontend: false = append the chunk, true = replace the
/// whole content (OpenCode rewrote the message, e.g. on its own retry).
pub async fn stream_chat(
    model: &str,
    mode: &str,
    prompt: &str,
    on_delta: &mut impl FnMut(&str, bool),
    cancelled: impl Fn() -> bool,
    state: &OpenCodeState,
    on_reasoning: &mut impl FnMut(&str, bool),
) -> Result<(), String> {
    let model = if model.trim().is_empty() { DEFAULT_MODEL } else { model.trim() };
    let agent = agent_for_mode(mode);
    let conn = ensure_server(state).await?;
    let client = api_client()?;
    let session = ensure_session(&client, state, &conn, model, agent).await?;

    let started = send_prompt(&client, &conn, &session.id, prompt).await?;
    wait_for_reply(&client, &conn, &session.id, started, on_delta, cancelled, on_reasoning).await
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("OpenCode-Client: {}", short(&e.to_string())))
}

async fn ensure_server(state: &OpenCodeState) -> Result<Connection, String> {
    loop {
        let existing = state.server.lock().unwrap().take();
        if let Some(server) = existing {
            let conn = server.connection();
            if ping(&conn).await {
                *state.server.lock().unwrap() = Some(server);
                return Ok(conn);
            }
            // The process died or no longer answers. Drop kills it.
            *state.session.lock().unwrap() = None;
        }
        let we_start = {
            let mut starting = state.starting.lock().unwrap();
            if *starting {
                false
            } else {
                *starting = true;
                true
            }
        };
        if !we_start {
            // Another caller is spawning the server; wait and re-check.
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        let result = start_server().await;
        *state.starting.lock().unwrap() = false;
        let server = result?;
        let conn = server.connection();
        *state.server.lock().unwrap() = Some(server);
        return Ok(conn);
    }
}

async fn start_server() -> Result<OpenCodeServer, String> {
    let binary = find_binary()?;
    let workdir = workspace_dir()?;
    let port = free_port()?;
    let password = random_password()?;

    let log_path = workdir.join("opencode.log");
    let log = std::fs::File::create(&log_path)
        .map_err(|e| format!("OpenCode-Log: {}", short(&e.to_string())))?;
    let stderr = log.try_clone().map_err(|e| format!("OpenCode-Log: {}", short(&e.to_string())))?;

    let mut cmd = Command::new(&binary);
    cmd.arg("serve")
        .arg("--stdio")
        .arg("--hostname")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&workdir)
        .env("OPENCODE_PASSWORD", &password)
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("OpenCode startet nicht: {}", short(&e.to_string())))?;
    let mut server = OpenCodeServer {
        child,
        base_url: format!("http://127.0.0.1:{port}"),
        password,
    };

    if let Err(e) = wait_until_ready(&mut server, &log_path).await {
        return Err(e);
    }
    Ok(server)
}

async fn wait_until_ready(server: &mut OpenCodeServer, log_path: &Path) -> Result<(), String> {
    let deadline = Instant::now() + SERVER_START_TIMEOUT;
    loop {
        if let Some(status) = server
            .child
            .try_wait()
            .map_err(|e| format!("OpenCode startet nicht: {}", short(&e.to_string())))?
        {
            return Err(format!(
                "OpenCode startet nicht: Prozess beendet ({status}). {}",
                log_tail(log_path)
            ));
        }
        if ping(&server.connection()).await {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "OpenCode startet nicht: Zeitüberschreitung nach {} s. {}",
                SERVER_START_TIMEOUT.as_secs(),
                log_tail(log_path)
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn ping(conn: &Connection) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(2)).build() else {
        return false;
    };
    client
        .get(format!("{}/api/info", conn.base_url))
        .header("Authorization", conn.auth_header())
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn ensure_session(
    client: &reqwest::Client,
    state: &OpenCodeState,
    conn: &Connection,
    model: &str,
    agent: &str,
) -> Result<SessionInfo, String> {
    let existing = state.session.lock().unwrap().clone();
    if let Some(mut session) = existing {
        if session.base_url == conn.base_url {
            let mut alive = true;

            // Reuse the conversation and switch only what changed.
            if session.model != model {
                let res = client
                    .post(format!("{}/api/session/{}/model", conn.base_url, session.id))
                    .header("Authorization", conn.auth_header())
                    .json(&json!({ "model": model_payload(model) }))
                    .send()
                    .await
                    .map_err(|e| format!("Keine Verbindung zu OpenCode: {}", short(&e.to_string())))?;
                if res.status().is_success() {
                    session.model = model.to_string();
                } else if res.status().as_u16() == 404 {
                    alive = false;
                } else {
                    return Err(api_error(res).await);
                }
            }

            if alive && session.agent != agent {
                let res = client
                    .post(format!("{}/api/session/{}/agent", conn.base_url, session.id))
                    .header("Authorization", conn.auth_header())
                    .json(&json!({ "agent": agent }))
                    .send()
                    .await
                    .map_err(|e| format!("Keine Verbindung zu OpenCode: {}", short(&e.to_string())))?;
                if res.status().is_success() {
                    session.agent = agent.to_string();
                } else if res.status().as_u16() == 404 {
                    alive = false;
                } else {
                    return Err(api_error(res).await);
                }
            }

            if alive {
                *state.session.lock().unwrap() = Some(session.clone());
                return Ok(session);
            }
            // Session vanished; fall through and create a new one.
        }
    }

    let session = create_session(client, conn, model, agent).await?;
    *state.session.lock().unwrap() = Some(session.clone());
    Ok(session)
}

async fn create_session(
    client: &reqwest::Client,
    conn: &Connection,
    model: &str,
    agent: &str,
) -> Result<SessionInfo, String> {
    let workdir = workspace_dir()?;
    let res = client
        .post(format!("{}/api/session", conn.base_url))
        .header("Authorization", conn.auth_header())
        .json(&json!({
            "title": session_title(agent),
            "agent": agent,
            "model": model_payload(model),
            "location": { "directory": workdir.to_string_lossy() }
        }))
        .send()
        .await
        .map_err(|e| format!("Keine Verbindung zu OpenCode: {}", short(&e.to_string())))?;
    if !res.status().is_success() {
        return Err(api_error(res).await);
    }
    let v: Value = res
        .json()
        .await
        .map_err(|e| format!("OpenCode-Antwort: {}", short(&e.to_string())))?;
    let id = v["data"]["id"]
        .as_str()
        .ok_or_else(|| "OpenCode lieferte keine Sitzung".to_string())?
        .to_string();

    Ok(SessionInfo {
        base_url: conn.base_url.clone(),
        id,
        model: model.to_string(),
        agent: agent.to_string(),
    })
}

async fn send_prompt(
    client: &reqwest::Client,
    conn: &Connection,
    session_id: &str,
    prompt: &str,
) -> Result<i64, String> {
    let res = client
        .post(format!("{}/api/session/{session_id}/prompt", conn.base_url))
        .header("Authorization", conn.auth_header())
        .json(&json!({ "text": prompt }))
        .send()
        .await
        .map_err(|e| format!("Keine Verbindung zu OpenCode: {}", short(&e.to_string())))?;
    if !res.status().is_success() {
        return Err(api_error(res).await);
    }
    let v: Value = res
        .json()
        .await
        .map_err(|e| format!("OpenCode-Antwort: {}", short(&e.to_string())))?;
    let created = v["data"]["time"]["created"].as_i64().unwrap_or(0);
    if created > 0 {
        return Ok(created);
    }
    // Fallback for unusual responses: accept assistants created around now.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(now.saturating_sub(1000))
}

async fn wait_for_reply(
    client: &reqwest::Client,
    conn: &Connection,
    session_id: &str,
    since: i64,
    on_delta: &mut impl FnMut(&str, bool),
    cancelled: impl Fn() -> bool,
    on_reasoning: &mut impl FnMut(&str, bool),
) -> Result<(), String> {
    let deadline = Instant::now() + REPLY_TIMEOUT;
    let mut last_text = String::new();
    let mut last_reasoning = String::new();
    // A closed keep-alive connection, a server restart or a session reset must
    // not end a turn whose answer already streamed. Retry the poll briefly.
    let mut connection_errors = 0u32;

    loop {
        if cancelled() {
            let _ = client
                .post(format!("{}/api/session/{session_id}/interrupt", conn.base_url))
                .header("Authorization", conn.auth_header())
                .json(&json!({}))
                .send()
                .await;
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Zeitüberschreitung – OpenCode antwortet nicht.".into());
        }

        let res = match client
            .get(format!(
                "{}/api/session/{session_id}/message?limit=100&order=desc",
                conn.base_url
            ))
            .header("Authorization", conn.auth_header())
            .send()
            .await
        {
            Ok(res) => {
                connection_errors = 0;
                res
            }
            Err(e) => {
                connection_errors += 1;
                if connection_errors < 6 {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                }
                if !last_text.is_empty() {
                    // The reply is already visible; the session ended or the
                    // server restarted before the idle marker. Keep the answer.
                    return Ok(());
                }
                return Err(format!("Keine Verbindung zu OpenCode: {}", short(&e.to_string())));
            }
        };
        if !res.status().is_success() {
            // 404 = the session was reset while polling. An answer that already
            // streamed stays; the next turn starts a fresh session.
            if res.status().as_u16() == 404 && !last_text.is_empty() {
                return Ok(());
            }
            return Err(api_error(res).await);
        }
        let v: Value = res
            .json()
            .await
            .map_err(|e| format!("OpenCode-Antwort: {}", short(&e.to_string())))?;
        let messages = v["data"].as_array().cloned().unwrap_or_default();

        // The API returns newest first. One turn can contain several assistant
        // messages (tool call, tool result, final answer); collect all text in
        // chronological order and stop only at the turn's `idle` marker.
        let mut turn: Vec<&Value> = messages
            .iter()
            .filter(|m| m["time"]["created"].as_i64().unwrap_or(0) >= since)
            .collect();
        turn.reverse();

        let mut text = String::new();
        let mut reasoning = String::new();
        for &message in &turn {
            if message["type"].as_str() != Some("assistant") {
                continue;
            }
            let part = assistant_text(message);
            if !part.is_empty() {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(&part);
            }
            let rpart = assistant_reasoning(message);
            if !rpart.is_empty() {
                if !reasoning.is_empty() {
                    reasoning.push_str("\n\n");
                }
                reasoning.push_str(&rpart);
            }
        }

        if !reasoning.is_empty() && reasoning != last_reasoning {
            if reasoning.starts_with(&last_reasoning) {
                on_reasoning(&reasoning[last_reasoning.len()..], false);
            } else {
                on_reasoning(&reasoning, true);
            }
            last_reasoning = reasoning;
        }

        if !text.is_empty() && text != last_text {
            if text.starts_with(&last_text) {
                on_delta(&text[last_text.len()..], false);
            } else {
                // OpenCode replaced the message (retry); emit the new text.
                on_delta(&text, true);
            }
            last_text = text;
        }

        if let Some(idle) = turn.iter().copied().find(|m| m["type"].as_str() == Some("idle")) {
            if cancelled() {
                return Ok(());
            }
            match idle["outcome"].as_str() {
                Some("failed") => {
                    let message = idle["error"]["message"]
                        .as_str()
                        .unwrap_or("Anfrage fehlgeschlagen");
                    return Err(format!("OpenCode: {}", short(message)));
                }
                Some("interrupted") => {
                    return Err("OpenCode: Antwort unterbrochen – bitte erneut senden.".into());
                }
                _ => return Ok(()),
            }
        }

        if let Some(error) = turn.iter().copied().find_map(|message| {
            if message["type"].as_str() != Some("assistant") {
                return None;
            }
            message.get("error").filter(|e| !e.is_null())
        }) {
            if cancelled() {
                return Ok(());
            }
            if error["type"].as_str() == Some("aborted") {
                return Err("OpenCode: Antwort unterbrochen – bitte erneut senden.".into());
            }
            let message = error["message"].as_str().unwrap_or("Anfrage fehlgeschlagen");
            return Err(format!("OpenCode: {}", short(message)));
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn assistant_text(message: &Value) -> String {
    message["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"].as_str() == Some("text"))
                .filter_map(|p| p["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn assistant_reasoning(message: &Value) -> String {
    message["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"].as_str() == Some("reasoning"))
                .filter_map(|p| p["text"].as_str().or_else(|| p["reasoning"].as_str()))
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn model_payload(model: &str) -> Value {
    let (provider, id) = match model.split_once('/') {
        Some((provider, id)) if !provider.is_empty() && !id.is_empty() => (provider, id),
        _ => ("opencode", model),
    };
    json!({ "providerID": provider, "id": id })
}

async fn api_error(res: reqwest::Response) -> String {
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v["error"]["message"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(200).collect());

    match status {
        401 | 403 => format!("OpenCode hat die Verbindung abgelehnt ({status}). {}", short(&detail)),
        404 => format!("OpenCode-Sitzung nicht gefunden (404). {}", short(&detail)),
        429 => "OpenCode-Limit erreicht (429) – kurz warten.".into(),
        _ => format!("OpenCode-Fehler {status}: {}", short(&detail)),
    }
}

const CHAT_AGENT_MD: &str = r#"---
description: Chat in the notch. Can read files when asked, but never changes files or runs commands.
mode: primary
steps: 6
permission:
  read: allow
  glob: allow
  grep: allow
  list: allow
  edit: deny
  shell: deny
  task: deny
  webfetch: deny
  websearch: deny
  lsp: deny
  skill: deny
  question: deny
  external_directory: deny
---
You are Ask Chat, the conversation mode of a small notch at the top of the screen.
When asked who you are, say you are Ask Chat, the assistant inside Notch — not the underlying model name.
Answer in the user's language. In Arabic, use clear, natural Arabic: write "نوتش" for Notch, never "الشق"; translate ordinary English words and keep only names, code, commands, paths, and established technical terms in English. Never mix scripts or leave English verbs in Arabic prose.
You cannot change files or run commands. Do not inspect files unless the user asks about them.
Keep chat answers compact: a short intro and at most 3–5 bullets; do not use Markdown headings (#, ##) in chat replies. Use bold for key names, inline code for paths and commands, and lists only when they help.
"#;

/// Builds the Studio agent file with the given permission level (allow/ask/deny).
fn studio_agent_md(permission: &str) -> String {
    let (read, glob, grep, list) = match permission {
        "deny" => ("deny", "deny", "deny", "deny"),
        _ => ("allow", "allow", "allow", "allow"),
    };
    let action = match permission {
        "ask" => "ask",
        "deny" => "deny",
        _ => "allow",
    };
    let question = if permission == "allow" { "deny" } else { "allow" };
    format!(
        r#"---
description: Notch Ask — answers questions and, when asked, creates files and runs commands anywhere.
mode: primary
steps: 50
permission:
  read: {read}
  glob: {glob}
  grep: {grep}
  list: {list}
  edit: {action}
  shell: {action}
  external_directory: {action}
  webfetch: {action}
  websearch: {action}
  question: {question}
  task: deny
  lsp: deny
  skill: deny
---
You are Ask Studio, the assistant inside a small notch at the top of the screen.
When asked who you are, say you are Ask Studio, the assistant inside Notch — not the underlying model name.
Answer questions directly and compactly. When the user asks you to do something (create/edit files, run commands, fetch), do it without asking for confirmation, then verify when useful and report the full path used.
The Notch Studio folder is your default workspace, but you may create, edit, and run commands anywhere the user explicitly asks, including the Desktop or another folder.
Always use the exact location the user names. Never silently put a requested file in the workspace instead of the requested folder. If no location is named, use the current working directory.
Only touch the paths needed for the task; do not scan or change unrelated files.
Answer in the user's language. In Arabic, use clear, natural Arabic: write "نوتش" for Notch, never "الشق"; translate ordinary English words and keep only names, code, commands, paths, and established technical terms in English. Never mix scripts or leave English verbs in Arabic prose.
Keep answers compact: a short intro and at most 3–5 bullets; do not use Markdown headings (#, ##) in replies. Use bold for key names, inline code for paths and commands, and lists only when they help.
"#,
        read = read,
        glob = glob,
        grep = grep,
        list = list,
        action = action,
        question = question,
    )
}

const README_MD: &str = r#"# Notch Studio

This folder is the default workspace for Ask Studio in L4 NotchBar.
Studio can create and edit files here and run commands. If you name another location, such as the Desktop, Studio uses that path.
Chat mode only answers; it does not change files or run commands.
"#;

#[tauri::command]
pub fn opencode_workspace() -> Result<String, String> {
    Ok(workspace_dir()?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn opencode_open_workspace() -> Result<(), String> {
    let dir = workspace_dir()?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Arbeitsordner öffnen: {}", short(&e.to_string())))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Arbeitsordner öffnen: {}", short(&e.to_string())))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Arbeitsordner öffnen: {}", short(&e.to_string())))?;
    }
    Ok(())
}

fn permission_file(dir: &Path) -> PathBuf {
    dir.join("permission.txt")
}

fn read_permission(dir: &Path) -> String {
    std::fs::read_to_string(permission_file(dir))
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_else(|_| "allow".to_string())
}

fn write_permission(dir: &Path, level: &str) -> Result<(), String> {
    let level = match level {
        "allow" | "ask" | "deny" => level,
        _ => "allow",
    };
    std::fs::write(permission_file(dir), level)
        .map_err(|e| format!("OpenCode-Berechtigung: {}", short(&e.to_string())))?;
    // Regenerate agent files with the new permission.
    ensure_workspace_files(dir)?;
    Ok(())
}

#[tauri::command]
pub async fn opencode_set_permission(
    level: String,
    state: State<'_, OpenCodeState>,
) -> Result<(), String> {
    let dir = workspace_dir()?;
    let next = match level.as_str() {
        "allow" | "ask" | "deny" => level.as_str(),
        _ => "allow",
    };
    // The Ask view syncs the stored permission on every mount. Resetting an
    // unchanged permission used to kill the server during an active reply.
    if read_permission(&dir) == next {
        return Ok(());
    }
    write_permission(&dir, next)?;
    // Reset session so the new agent/permission takes effect.
    reset(state.inner()).await;
    Ok(())
}

fn workspace_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Kein Benutzerordner gefunden".to_string())?;

    // Keep Studio files next to normal documents, not in a temp folder that
    // Windows may clear. If there is no Documents folder, use home.
    let documents = home.join("Documents");
    let base = if documents.is_dir() { documents } else { home };
    let dir = base.join("Notch Studio");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("OpenCode-Arbeitsordner: {}", short(&e.to_string())))?;
    ensure_workspace_files(&dir)?;
    Ok(dir)
}

/// Writes the two Ask agents into the workspace. OpenCode reads them as project
/// agents, so the notch needs no separate project or global config.
fn ensure_workspace_files(dir: &Path) -> Result<(), String> {
    let agents = dir.join(".opencode").join("agents");
    std::fs::create_dir_all(&agents)
        .map_err(|e| format!("OpenCode-Agenten: {}", short(&e.to_string())))?;
    let permission = read_permission(&dir);
    std::fs::write(agents.join("chat.md"), CHAT_AGENT_MD)
        .map_err(|e| format!("OpenCode-Agenten: {}", short(&e.to_string())))?;
    std::fs::write(agents.join("studio.md"), studio_agent_md(&permission))
        .map_err(|e| format!("OpenCode-Agenten: {}", short(&e.to_string())))?;
    let readme = dir.join("README.md");
    if !readme.exists() {
        let _ = std::fs::write(readme, README_MD);
    }
    Ok(())
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Kein freier OpenCode-Port: {}", short(&e.to_string())))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Kein freier OpenCode-Port: {}", short(&e.to_string())))?
        .port();
    drop(listener);
    Ok(port)
}

fn random_password() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Zufall: {}", short(&e.to_string())))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn find_binary() -> Result<PathBuf, String> {
    let exe = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    let mut candidates = Vec::new();

    if let Some(path) = std::env::var_os("OPENCODE_BIN") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(home).join(".opencode").join("bin").join(exe));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        candidates.push(
            local
                .join("Programs")
                .join("@openchamberelectron")
                .join("resources")
                .join("opencode-cli")
                .join(exe),
        );
        candidates.push(local.join("Programs").join("opencode").join(exe));
        candidates.push(local.join("opencode").join(exe));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(exe));
        }
    }

    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            "OpenCode ist nicht installiert. Installiere OpenCode von https://opencode.ai oder öffne OpenChamber einmal.".to_string()
        })
}

fn log_tail(path: &Path) -> String {
    let Ok(bytes) = std::fs::read(path) else { return String::new() };
    let start = bytes.len().saturating_sub(600);
    let text = String::from_utf8_lossy(&bytes[start..]);
    let text = text.trim();
    if text.is_empty() {
        String::new()
    } else {
        format!("Letzte Meldung: {}", short(text))
    }
}

fn short(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() > 160 {
        format!("{}…", s.chars().take(160).collect::<String>())
    } else {
        s.to_string()
    }
}
