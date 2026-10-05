//! Trading 212 Depot (Public API v0, nur lesend).
//!
//! - Auth: HTTP Basic aus API-Key + Secret (Anmeldeinformationsverwaltung). Ohne Secret
//!   wird der alte Header-Modus (nur Key) versucht.
//! - Rate-Limits: Summary 1/5 s, Positions 1/1 s → Ergebnis 6 s zwischenspeichern.
//! - Die API hat keinen Wertverlauf. Deshalb wird pro Tag ein Snapshot gespeichert
//!   (letzter Stand des Tages) — daraus entsteht "die letzten Tage".
//! - Zusätzlich Punkte über den heutigen Tag (alle 2 min, solange das Depot offen ist)
//!   für den "1T"-Verlauf. Gestern wird beim ersten Abruf des Tages verworfen.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::secrets;

const CACHE: Duration = Duration::from_secs(6);
const KEEP_DAYS: usize = 120;
const INTRADAY_STEP_MS: u64 = 2 * 60 * 1000;

#[derive(Default)]
pub struct TradingState {
    cache: Mutex<Option<(Instant, String, TradingData)>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradingData {
    currency: String,
    total_value: f64,
    cash: f64,
    invested: f64,
    current_value: f64,
    unrealized: f64,
    realized: f64,
    positions: Vec<Position>,
    history: Vec<Snapshot>,
    intraday: Vec<Point>,
}

/// Ein Messpunkt im Tagesverlauf.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    /// Unix-ms.
    t: u64,
    value: f64,
    pnl: f64,
}

#[derive(Default, Serialize, Deserialize)]
struct Intraday {
    date: String,
    points: Vec<Point>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    ticker: String,
    name: String,
    quantity: f64,
    average_price: f64,
    current_price: f64,
    /// Währung der Kurse (z. B. USD); Wert/Kosten/GuV sind in Kontowährung.
    price_currency: String,
    value: f64,
    cost: f64,
    pnl: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    date: String,
    /// Kontowert inkl. Cash.
    value: f64,
    invested: f64,
    /// Gewinn gesamt (realisiert + unrealisiert). Differenz zum Vortag = Tagesänderung,
    /// unabhängig von Einzahlungen und Käufen.
    #[serde(default)]
    pnl: f64,
}

// --- API-Antworten (nur die genutzten Felder) ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    currency: String,
    total_value: f64,
    cash: SummaryCash,
    investments: SummaryInvestments,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryCash {
    available_to_trade: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryInvestments {
    current_value: f64,
    total_cost: f64,
    realized_profit_loss: f64,
    unrealized_profit_loss: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiPosition {
    average_price_paid: f64,
    current_price: f64,
    quantity: f64,
    instrument: ApiInstrument,
    wallet_impact: ApiWallet,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiInstrument {
    ticker: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    currency: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiWallet {
    current_value: f64,
    total_cost: f64,
    unrealized_profit_loss: f64,
}

/// `env`: "live" oder "demo". `today`: lokales Datum "YYYY-MM-DD" (vom Frontend).
/// Fehler sind kurze Codes, die das Frontend übersetzt: no-key, unauthorized, forbidden, rate, network:…
#[tauri::command]
pub async fn trading_fetch(env: String, today: String, app: AppHandle, state: State<'_, TradingState>) -> Result<TradingData, String> {
    if let Some((at, cached_env, data)) = state.cache.lock().unwrap().as_ref() {
        if at.elapsed() < CACHE && *cached_env == env {
            return Ok(data.clone());
        }
    }

    let key = secrets::read("t212.key").ok_or("no-key")?;
    let auth = match secrets::read("t212.secret") {
        Some(secret) => format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{key}:{secret}"))),
        None => key,
    };
    let base = if env == "demo" { "https://demo.trading212.com" } else { "https://live.trading212.com" };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(12)).build().map_err(|e| format!("network:{e}"))?;

    let summary: Summary = get(&client, &format!("{base}/api/v0/equity/account/summary"), &auth).await?;
    let positions: Vec<ApiPosition> = get(&client, &format!("{base}/api/v0/equity/positions"), &auth).await?;

    let mut positions: Vec<Position> = positions
        .into_iter()
        .map(|p| Position {
            ticker: short_ticker(&p.instrument.ticker),
            name: p.instrument.name,
            quantity: p.quantity,
            average_price: p.average_price_paid,
            current_price: p.current_price,
            price_currency: p.instrument.currency,
            value: p.wallet_impact.current_value,
            cost: p.wallet_impact.total_cost,
            pnl: p.wallet_impact.unrealized_profit_loss,
        })
        .collect();
    positions.sort_by(|a, b| b.value.total_cmp(&a.value));

    let pnl_now = summary.investments.unrealized_profit_loss + summary.investments.realized_profit_loss;
    let intraday = record_point(&app, &env, &today, Point { t: now_ms(), value: summary.total_value, pnl: pnl_now });
    let history = record_snapshot(&app, &env, Snapshot {
        date: today,
        value: summary.total_value,
        invested: summary.investments.total_cost,
        pnl: summary.investments.unrealized_profit_loss + summary.investments.realized_profit_loss,
    });

    let data = TradingData {
        currency: summary.currency,
        total_value: summary.total_value,
        cash: summary.cash.available_to_trade,
        invested: summary.investments.total_cost,
        current_value: summary.investments.current_value,
        unrealized: summary.investments.unrealized_profit_loss,
        realized: summary.investments.realized_profit_loss,
        positions,
        history,
        intraday,
    };
    *state.cache.lock().unwrap() = Some((Instant::now(), env, data.clone()));
    Ok(data)
}

async fn get<T: for<'de> Deserialize<'de>>(client: &reqwest::Client, url: &str, auth: &str) -> Result<T, String> {
    let res = client.get(url).header("Authorization", auth).send().await.map_err(|e| format!("network:{e}"))?;
    match res.status().as_u16() {
        200 => res.json::<T>().await.map_err(|e| format!("network:Antwort unlesbar ({e})")),
        401 => Err("unauthorized".into()),
        403 => Err("forbidden".into()),
        429 => Err("rate".into()),
        code => Err(format!("network:HTTP {code}")),
    }
}

/// "AAPL_US_EQ" → "AAPL", "VUSAl_EQ" → "VUSA".
fn short_ticker(ticker: &str) -> String {
    let base = ticker.split('_').next().unwrap_or(ticker);
    base.trim_end_matches(|c: char| c.is_ascii_lowercase()).to_string()
}

fn history_path(app: &AppHandle, env: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("trading-history-{env}.json")))
}

/// Punkt im Tagesverlauf ergänzen (höchstens alle 2 min, der letzte wird sonst ersetzt).
fn record_point(app: &AppHandle, env: &str, today: &str, point: Point) -> Vec<Point> {
    let Some(path) = app.path().app_data_dir().ok().map(|d| d.join(format!("trading-intraday-{env}.json"))) else { return vec![point] };
    let mut day: Intraday = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if day.date != today {
        day = Intraday { date: today.to_string(), points: vec![] };
    }
    // Der letzte Punkt ist immer der aktuelle Stand; ein neuer kommt erst hinzu, wenn der
    // vorletzte mindestens INTRADAY_STEP_MS zurückliegt.
    let n = day.points.len();
    if n >= 2 && point.t.saturating_sub(day.points[n - 2].t) < INTRADAY_STEP_MS {
        day.points[n - 1] = point;
    } else {
        day.points.push(point);
    }
    let _ = std::fs::write(&path, serde_json::to_vec(&day).unwrap_or_default());
    day.points
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Heutigen Stand speichern (überschreibt den Eintrag des Tages) und Verlauf zurückgeben.
fn record_snapshot(app: &AppHandle, env: &str, snapshot: Snapshot) -> Vec<Snapshot> {
    let Some(path) = history_path(app, env) else { return vec![snapshot] };
    let mut history: Vec<Snapshot> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    match history.last_mut() {
        Some(last) if last.date == snapshot.date => *last = snapshot,
        _ => history.push(snapshot),
    }
    if history.len() > KEEP_DAYS {
        history.drain(..history.len() - KEEP_DAYS);
    }
    let _ = std::fs::write(&path, serde_json::to_vec(&history).unwrap_or_default());
    history
}
