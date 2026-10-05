//! AI usage: plan limits of locally signed-in AI tools (like OmniNotch).
//! Only reads what the tools already stored on this PC. Tokens are never written
//! back or shared.
//!
//! - Claude (Claude Code): `api.anthropic.com/api/oauth/usage` with the OAuth token from
//!   `~/.claude/.credentials.json`. Strictly rate-limited → 5 min cache, pause after 429
//!   (Retry-After, at least 10 min). The last good result is kept on disk so a restart
//!   doesn't query right away and never shows an empty error.
//! - ChatGPT (Codex CLI): live `chatgpt.com/backend-api/wham/usage` with `~/.codex/auth.json`,
//!   fallback: last `rate_limits` entry in `~/.codex/sessions/**.jsonl`.
//! - Gemini (Gemini CLI): Code Assist quota (`retrieveUserQuota`) with the Google login
//!   from `~/.gemini/oauth_creds.json`. Expired tokens are only refreshed in memory.
//! - Cursor: monthly requests via `cursor.com/api/usage` with the Cursor app's login.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

/// Minimum interval between real queries per provider.
fn cache_for(id: &str) -> Duration {
    match id {
        "claude" => Duration::from_secs(5 * 60),
        _ => Duration::from_secs(2 * 60),
    }
}
const BACKOFF_429: Duration = Duration::from_secs(10 * 60);

/// Public OAuth client data of the Gemini CLI (it's in the CLI's open-source code;
/// "installed app" clients have no real secret).
const GEMINI_CLIENT_ID: &str = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_CLIENT_SECRET: &str = "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";

#[derive(Default)]
pub struct UsageState {
    /// Last result per provider + earliest time (Unix ms) of the next real query.
    cache: Mutex<HashMap<String, (u64, Provider)>>,
    loaded: Mutex<bool>,
    /// Refreshed Gemini token (valid ~1 h).
    gemini_token: Mutex<Option<(String, u64)>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    id: String,
    plan: Option<String>,
    windows: Vec<Window>,
    /// Error code for the frontend (translated there): not-found, not-signed-in, expired,
    /// rate-limited, offline, failed. With `windows` present, the data is stale.
    error: Option<String>,
    /// Unix ms when the data was produced.
    updated_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// session | weekly | weekly-opus | weekly-sonnet | daily | monthly | model:<Name>
    kind: String,
    used_percent: f64,
    /// Unix ms; None if unknown.
    resets_at: Option<u64>,
    /// Window length in seconds (for the "on track" marker).
    window_secs: Option<u64>,
}

#[tauri::command]
pub async fn usage_fetch(providers: Vec<String>, app: AppHandle, state: State<'_, UsageState>) -> Result<Vec<Provider>, String> {
    load_disk_cache(&app, &state);
    let mut out = Vec::new();
    for id in providers {
        if !matches!(id.as_str(), "claude" | "codex" | "gemini" | "cursor") {
            continue;
        }
        let cached = state.cache.lock().unwrap().get(&id).cloned();
        if let Some((next_at, p)) = &cached {
            if now_ms() < *next_at {
                out.push(p.clone());
                continue;
            }
        }
        let result = match id.as_str() {
            "claude" => fetch_claude().await,
            "codex" => fetch_codex().await,
            "gemini" => fetch_gemini(&state).await,
            _ => fetch_cursor().await,
        };
        let (provider, wait) = match (result, cached) {
            (Ok(p), _) => (p, cache_for(&id)),
            // Error → keep the last good result, just note the error.
            (Err(e), Some((_, mut old))) if !old.windows.is_empty() => {
                let wait = e.wait.unwrap_or(cache_for(&id));
                old.error = Some(e.code);
                (old, wait)
            }
            (Err(e), _) => (
                Provider { id: id.clone(), plan: None, windows: vec![], error: Some(e.code.clone()), updated_at: now_ms() },
                e.wait.unwrap_or(cache_for(&id)),
            ),
        };
        state.cache.lock().unwrap().insert(id, (now_ms() + wait.as_millis() as u64, provider.clone()));
        out.push(provider);
    }
    save_disk_cache(&app, &state);
    Ok(out)
}

struct Fail {
    code: String,
    /// Earliest time to ask again (after 429).
    wait: Option<Duration>,
}

impl Fail {
    fn new(code: &str) -> Self {
        Self { code: code.into(), wait: None }
    }
}

impl From<&str> for Fail {
    fn from(code: &str) -> Self {
        Fail::new(code)
    }
}

fn client() -> Result<reqwest::Client, Fail> {
    reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|_| Fail::new("failed"))
}

/// Maps HTTP status to error codes; 429 uses Retry-After (at least BACKOFF_429).
fn check(res: &reqwest::Response) -> Result<(), Fail> {
    match res.status().as_u16() {
        200 => Ok(()),
        401 | 403 => Err(Fail::new("expired")),
        429 => {
            let retry = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(BACKOFF_429)
                .max(BACKOFF_429);
            Err(Fail { code: "rate-limited".into(), wait: Some(retry) })
        }
        _ => Err(Fail::new("failed")),
    }
}

// ---------- Claude ----------

async fn fetch_claude() -> Result<Provider, Fail> {
    let creds = read_json(&home().join(".claude").join(".credentials.json")).ok_or("not-found")?;
    let oauth = &creds["claudeAiOauth"];
    let token = oauth["accessToken"].as_str().ok_or("not-signed-in")?;
    if oauth["expiresAt"].as_u64().is_some_and(|exp| exp < now_ms()) {
        return Err("expired".into());
    }
    let plan = oauth["subscriptionType"].as_str().map(capitalize);

    let res = client()?
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|_| Fail::new("offline"))?;
    check(&res)?;
    let body: Value = res.json().await.map_err(|_| Fail::new("failed"))?;

    let windows = [("five_hour", "session", 5 * 3600), ("seven_day", "weekly", 7 * 86_400), ("seven_day_opus", "weekly-opus", 7 * 86_400), ("seven_day_sonnet", "weekly-sonnet", 7 * 86_400)]
        .iter()
        .filter_map(|(field, kind, secs)| {
            let w = body.get(*field)?;
            Some(Window {
                kind: kind.to_string(),
                used_percent: w.get("utilization")?.as_f64()?,
                resets_at: w.get("resets_at").and_then(Value::as_str).and_then(parse_iso_ms),
                window_secs: Some(*secs),
            })
        })
        .collect();
    Ok(Provider { id: "claude".into(), plan, windows, error: None, updated_at: now_ms() })
}

// ---------- ChatGPT (Codex) ----------

async fn fetch_codex() -> Result<Provider, Fail> {
    match fetch_codex_live().await {
        Ok(p) => Ok(p),
        // Live failed (old CLI, offline) → last state from the session files.
        Err(live) => codex_from_sessions().ok_or(live),
    }
}

async fn fetch_codex_live() -> Result<Provider, Fail> {
    let auth = read_json(&home().join(".codex").join("auth.json")).ok_or("not-found")?;
    let tokens = &auth["tokens"];
    let token = tokens["access_token"].as_str().ok_or("not-signed-in")?;
    let mut req = client()?.get("https://chatgpt.com/backend-api/wham/usage").bearer_auth(token).header("User-Agent", "codex_cli_rs");
    if let Some(account) = tokens["account_id"].as_str() {
        req = req.header("chatgpt-account-id", account);
    }
    let res = req.send().await.map_err(|_| Fail::new("offline"))?;
    check(&res)?;
    let body: Value = res.json().await.map_err(|_| Fail::new("failed"))?;
    let limits = &body["rate_limit"];
    let windows: Vec<Window> = ["primary_window", "secondary_window"]
        .iter()
        .filter_map(|k| {
            let w = &limits[*k];
            let used = w["used_percent"].as_f64()?;
            let secs = w["limit_window_seconds"].as_u64();
            let resets_at = w["reset_at"].as_u64().map(|s| s * 1000).or_else(|| w["reset_after_seconds"].as_u64().map(|s| now_ms() + s * 1000));
            Some(Window { kind: window_kind(secs.unwrap_or(0) / 60).into(), used_percent: used, resets_at, window_secs: secs })
        })
        .collect();
    if windows.is_empty() {
        return Err("failed".into());
    }
    Ok(Provider { id: "codex".into(), plan: body["plan_type"].as_str().map(capitalize), windows, error: None, updated_at: now_ms() })
}

fn codex_from_sessions() -> Option<Provider> {
    let sessions = home().join(".codex").join("sessions");
    // Newest first by file name (contains the timestamp); mtime is unreliable
    // because Codex rewrites old files when resuming.
    for file in newest_files(&sessions, 15) {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        for line in text.lines().rev() {
            if !line.contains("\"rate_limits\":{") {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
            let limits = &event["payload"]["rate_limits"];
            if !limits.is_object() {
                continue;
            }
            let plan = event["payload"]["plan_type"].as_str().or(limits["plan_type"].as_str()).map(capitalize);
            let windows: Vec<Window> = ["primary", "secondary"].iter().filter_map(|k| codex_window(&limits[*k])).collect();
            if windows.is_empty() {
                continue;
            }
            let updated_at = event["timestamp"].as_str().and_then(parse_iso_ms).unwrap_or_else(now_ms);
            return Some(Provider { id: "codex".into(), plan, windows, error: None, updated_at });
        }
    }
    None
}

fn codex_window(w: &Value) -> Option<Window> {
    let minutes = w.get("window_minutes")?.as_u64()?;
    let mut used = w.get("used_percent")?.as_f64()?;
    let resets_at = w.get("resets_at").and_then(Value::as_u64).map(|s| s * 1000);
    // Window has expired since → back to 0.
    if resets_at.is_some_and(|r| r < now_ms()) {
        used = 0.0;
    }
    Some(Window { kind: window_kind(minutes).into(), used_percent: used, resets_at, window_secs: Some(minutes * 60) })
}

fn window_kind(minutes: u64) -> &'static str {
    match minutes {
        0..=360 => "session",
        361..=1440 => "daily",
        1441..=11_520 => "weekly",
        _ => "monthly",
    }
}

// ---------- Gemini ----------

async fn fetch_gemini(state: &UsageState) -> Result<Provider, Fail> {
    let token = gemini_token(state).await?;
    let http = client()?;
    let code_assist = "https://cloudcode-pa.googleapis.com/v1internal";

    let res = http
        .post(format!("{code_assist}:loadCodeAssist"))
        .bearer_auth(&token)
        .json(&json!({ "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" } }))
        .send()
        .await
        .map_err(|_| Fail::new("offline"))?;
    check(&res)?;
    let info: Value = res.json().await.map_err(|_| Fail::new("failed"))?;
    let project = info["cloudaicompanionProject"].as_str().or(info["cloudaicompanionProject"]["id"].as_str()).map(str::to_string);
    let plan = info["currentTier"]["name"].as_str().map(|s| s.replace("Gemini Code Assist", "").trim().to_string()).filter(|s| !s.is_empty());

    let res = http
        .post(format!("{code_assist}:retrieveUserQuota"))
        .bearer_auth(&token)
        .json(&json!({ "project": project }))
        .send()
        .await
        .map_err(|_| Fail::new("offline"))?;
    check(&res)?;
    let body: Value = res.json().await.map_err(|_| Fail::new("failed"))?;
    let mut windows: Vec<Window> = body["buckets"]
        .as_array()
        .map(|b| {
            b.iter()
                .filter_map(|bucket| {
                    let remaining = bucket["remainingFraction"].as_f64()?;
                    let model = bucket["modelId"].as_str().unwrap_or("Gemini");
                    Some(Window {
                        kind: format!("model:{}", pretty_model(model)),
                        used_percent: ((1.0 - remaining) * 100.0).clamp(0.0, 100.0),
                        resets_at: bucket["resetTime"].as_str().and_then(parse_iso_ms),
                        window_secs: Some(86_400),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // Merge variants of the same model (the tightest counts). Show at most three.
    windows.sort_by(|a, b| b.used_percent.total_cmp(&a.used_percent));
    let mut seen = std::collections::HashSet::new();
    windows.retain(|w| seen.insert(w.kind.clone()));
    windows.truncate(3);
    if windows.is_empty() {
        return Err("failed".into());
    }
    Ok(Provider { id: "gemini".into(), plan, windows, error: None, updated_at: now_ms() })
}

/// Valid Gemini CLI access token; refreshed in memory if expired (the file is untouched).
async fn gemini_token(state: &UsageState) -> Result<String, Fail> {
    let creds = read_json(&home().join(".gemini").join("oauth_creds.json")).ok_or("not-found")?;
    let expiry = creds["expiry_date"].as_u64().unwrap_or(0);
    if let Some(token) = creds["access_token"].as_str().filter(|_| expiry > now_ms() + 60_000) {
        return Ok(token.to_string());
    }
    if let Some((token, exp)) = state.gemini_token.lock().unwrap().clone() {
        if exp > now_ms() + 60_000 {
            return Ok(token);
        }
    }
    let refresh = creds["refresh_token"].as_str().ok_or("not-signed-in")?;
    let res = client()?
        .post("https://oauth2.googleapis.com/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("client_id={GEMINI_CLIENT_ID}&client_secret={GEMINI_CLIENT_SECRET}&refresh_token={}&grant_type=refresh_token", url_encode(refresh)))
        .send()
        .await
        .map_err(|_| Fail::new("offline"))?;
    if !res.status().is_success() {
        return Err("expired".into());
    }
    let body: Value = res.json().await.map_err(|_| Fail::new("failed"))?;
    let token = body["access_token"].as_str().ok_or("expired")?.to_string();
    let exp = now_ms() + body["expires_in"].as_u64().unwrap_or(3000) * 1000;
    *state.gemini_token.lock().unwrap() = Some((token.clone(), exp));
    Ok(token)
}

/// "gemini-2.5-pro" → "2.5 Pro", "gemini-2.5-flash-lite" → "2.5 Flash Lite".
fn pretty_model(id: &str) -> String {
    id.trim_start_matches("models/").trim_start_matches("gemini-").split('-').map(capitalize).collect::<Vec<_>>().join(" ")
}

// ---------- Cursor ----------

async fn fetch_cursor() -> Result<Provider, Fail> {
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from).ok_or("not-found")?;
    let db = appdata.join("Cursor").join("User").join("globalStorage").join("state.vscdb");
    let bytes = std::fs::read(&db).map_err(|_| Fail::new("not-found"))?;
    let jwt = find_jwt_after(&bytes, b"cursorAuth/accessToken").ok_or("not-signed-in")?;
    // "sub" in the token = "auth0|user_…" → user ID for the query and cookie.
    let payload = jwt.split('.').nth(1).and_then(|p| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p).ok()).ok_or("not-signed-in")?;
    let claims: Value = serde_json::from_slice(&payload).map_err(|_| Fail::new("not-signed-in"))?;
    let user = claims["sub"].as_str().and_then(|s| s.split('|').next_back()).ok_or("not-signed-in")?.to_string();

    let res = client()?
        .get(format!("https://cursor.com/api/usage?user={user}"))
        .header("Cookie", format!("WorkosCursorSessionToken={user}%3A%3A{jwt}"))
        .send()
        .await
        .map_err(|_| Fail::new("offline"))?;
    check(&res)?;
    let body: Value = res.json().await.map_err(|_| Fail::new("failed"))?;
    let start = body["startOfMonth"].as_str().and_then(parse_iso_ms);
    let resets_at = start.map(|s| s + 30 * 86_400_000);
    let windows: Vec<Window> = body
        .as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(model, v)| {
                    let used = v["numRequests"].as_f64()?;
                    let max = v["maxRequestUsage"].as_f64().filter(|m| *m > 0.0)?;
                    Some(Window { kind: format!("model:{}", if model.starts_with("gpt-4") { "Premium" } else { model.as_str() }), used_percent: (used / max * 100.0).min(100.0), resets_at, window_secs: Some(30 * 86_400) })
                })
                .collect()
        })
        .unwrap_or_default();
    if windows.is_empty() {
        return Err("failed".into());
    }
    Ok(Provider { id: "cursor".into(), plan: None, windows, error: None, updated_at: now_ms() })
}

/// First JWT ("eyJ…") after `key` in a binary file (Cursor's SQLite file, without SQLite).
fn find_jwt_after(bytes: &[u8], key: &[u8]) -> Option<String> {
    let mut from = 0;
    while let Some(pos) = bytes[from..].windows(key.len()).position(|w| w == key) {
        let after = from + pos + key.len();
        let window = &bytes[after..(after + 64).min(bytes.len())];
        if let Some(start) = window.windows(3).position(|w| w == b"eyJ") {
            let s = after + start;
            let end = bytes[s..].iter().position(|&c| !(c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'.')).map_or(bytes.len(), |e| s + e);
            let token = std::str::from_utf8(&bytes[s..end]).ok()?;
            if token.matches('.').count() == 2 {
                return Some(token.to_string());
            }
        }
        from = after;
    }
    None
}

// ---------- Disk cache ----------

fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("usage-cache.json"))
}

fn load_disk_cache(app: &AppHandle, state: &UsageState) {
    let mut loaded = state.loaded.lock().unwrap();
    if *loaded {
        return;
    }
    *loaded = true;
    let Some(saved) = cache_path(app).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<HashMap<String, (u64, Provider)>>(&b).ok()) else { return };
    state.cache.lock().unwrap().extend(saved);
}

fn save_disk_cache(app: &AppHandle, state: &UsageState) {
    let Some(path) = cache_path(app) else { return };
    let cache = state.cache.lock().unwrap();
    // Only store real data, not bare errors.
    let keep: HashMap<&String, &(u64, Provider)> = cache.iter().filter(|(_, (_, p))| !p.windows.is_empty()).collect();
    let _ = std::fs::write(path, serde_json::to_vec(&keep).unwrap_or_default());
}

// ---------- Helpers ----------

fn url_encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// Newest `.jsonl` files under sessions/YYYY/MM/DD, sorted by path descending.
fn newest_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    fn sorted_desc(dir: &Path) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(dir).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        v.sort_by(|a, b| b.cmp(a));
        v
    }
    let mut out = Vec::new();
    for year in sorted_desc(root).into_iter().filter(|p| p.is_dir()) {
        for month in sorted_desc(&year).into_iter().filter(|p| p.is_dir()) {
            for day in sorted_desc(&month).into_iter().filter(|p| p.is_dir()) {
                for file in sorted_desc(&day) {
                    if file.extension().is_some_and(|e| e == "jsonl") {
                        out.push(file);
                        if out.len() >= limit {
                            return out;
                        }
                    }
                }
            }
        }
    }
    out
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// Minimal ISO 8601 parser ("2026-10-04T17:30:00.123+00:00" / "...Z") → Unix ms.
fn parse_iso_ms(s: &str) -> Option<u64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time_end = rest.find(|c: char| c == 'Z' || c == '+' || (c == '-' && rest.len() > 8)).unwrap_or(rest.len());
    let (time, tz) = rest.split_at(time_end);
    let mut t = time.split(':');
    let (h, min) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let sec: f64 = t.next().unwrap_or("0").parse().ok()?;
    let offset_min = match tz.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let mut p = tz[1..].split(':');
            let oh: i64 = p.next()?.parse().ok()?;
            let om: i64 = p.next().unwrap_or("0").parse().ok()?;
            (oh * 60 + om) * if sign == '-' { -1 } else { 1 }
        }
        _ => 0,
    };
    // Days since 1970 (Howard Hinnant's algorithm).
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + min * 60 - offset_min * 60;
    Some((secs as f64 * 1000.0 + sec * 1000.0) as u64)
}

#[cfg(test)]
mod tests {
    use super::{find_jwt_after, parse_iso_ms, pretty_model};

    #[test]
    fn iso() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-04T12:00:00Z"), Some(1_791_115_200_000));
        assert_eq!(parse_iso_ms("2026-10-04T14:00:00+02:00"), Some(1_791_115_200_000));
        assert_eq!(parse_iso_ms("2026-10-04T12:00:00.500Z"), Some(1_791_115_200_500));
    }

    #[test]
    fn models() {
        assert_eq!(pretty_model("gemini-2.5-pro"), "2.5 Pro");
        assert_eq!(pretty_model("gemini-2.5-flash-lite"), "2.5 Flash Lite");
    }

    #[test]
    fn jwt_scan() {
        let db = b"\x00\x01cursorAuth/accessToken\x07\x12eyJhbGc.eyJzdWIiOiJ4In0.sig-_x\x00more";
        assert_eq!(find_jwt_after(db, b"cursorAuth/accessToken").as_deref(), Some("eyJhbGc.eyJzdWIiOiJ4In0.sig-_x"));
    }
}

/// For backend tests without the Tauri runtime: Claude + ChatGPT, error codes/counters only.
#[doc(hidden)]
pub async fn probe_for_test() -> Vec<(String, Result<usize, String>)> {
    let state = UsageState::default();
    vec![
        ("claude".into(), fetch_claude().await.map(|p| p.windows.len()).map_err(|e| e.code)),
        ("codex".into(), fetch_codex().await.map(|p| p.windows.len()).map_err(|e| e.code)),
        ("gemini".into(), fetch_gemini(&state).await.map(|p| p.windows.len()).map_err(|e| e.code)),
    ]
}
