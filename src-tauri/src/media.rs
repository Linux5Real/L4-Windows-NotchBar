//! Now Playing über GlobalSystemMediaTransportControls (GSMTC).
//!
//! Deckt alles ab, was Windows im Lautstärke-Overlay zeigt: Spotify, Browser
//! (YouTube, SoundCloud …), Apple Music, VLC usw. Ein Thread fragt die aktuelle
//! Sitzung regelmäßig ab und sendet `media://update`, sobald sich etwas ändert.
//! Polling statt WinRT-Events: robuster beim Wechsel der Sitzung, Kosten vernachlässigbar.

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    title: String,
    artist: String,
    /// Cover als Data-URL, `None` wenn die App keins liefert.
    artwork: Option<String>,
    is_playing: bool,
    /// Sekunden, bereits auf den Abfragezeitpunkt hochgerechnet.
    position: f64,
    /// Sekunden; 0 = unbekannt (z. B. Livestreams).
    duration: f64,
    /// Erlaubt die App Spulen? (Spotify, YouTube: ja; manche Player: nein)
    can_seek: bool,
    app_id: String,
}

#[derive(Default)]
pub struct MediaState(Mutex<Option<NowPlaying>>);

#[tauri::command]
pub fn media_get(state: State<'_, MediaState>) -> Option<NowPlaying> {
    state.0.lock().unwrap().clone()
}

// Async, damit das blockierende `join()` nicht den Haupt-Thread anhält.
#[tauri::command]
pub async fn media_control(action: String, position: Option<f64>) -> Result<(), String> {
    let run = || -> windows::core::Result<()> {
        let session = SessionManager::RequestAsync()?.join()?.GetCurrentSession()?;
        match action.as_str() {
            "toggle" => session.TryTogglePlayPauseAsync()?.join()?,
            "next" => session.TrySkipNextAsync()?.join()?,
            "previous" => session.TrySkipPreviousAsync()?.join()?,
            "seek" => {
                // Position relativ zum Start der Timeline, in 100-ns-Ticks.
                let start = session.GetTimelineProperties()?.StartTime()?.Duration;
                let ticks = start + (position.unwrap_or(0.0).max(0.0) * 10_000_000.0) as i64;
                session.TryChangePlaybackPositionAsync(ticks)?.join()?
            }
            _ => false,
        };
        Ok(())
    };
    run().map_err(|e| e.message())
}

const POLL: Duration = Duration::from_millis(400);
/// Abweichung, ab der eine Position als Sprung (Spulen) gilt und neu gesendet wird.
const SEEK_THRESHOLD: f64 = 1.5;

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let manager = loop {
            match SessionManager::RequestAsync().and_then(|op| op.join()) {
                Ok(m) => break m,
                Err(_) => thread::sleep(Duration::from_secs(2)),
            }
        };

        let mut last: Option<NowPlaying> = None;
        let mut last_sent_at = SystemTime::now();
        // Cover nur neu laden, wenn der Titel wechselt.
        let mut artwork_key = String::new();
        let mut artwork: Option<String> = None;

        loop {
            let current = manager.GetCurrentSession().ok().and_then(|session| {
                read(&session, &mut artwork_key, &mut artwork).ok()
            });

            if changed(&last, &current, last_sent_at) {
                *app.state::<MediaState>().0.lock().unwrap() = current.clone();
                let _ = app.emit("media://update", &current);
                last = current;
                last_sent_at = SystemTime::now();
            }
            thread::sleep(POLL);
        }
    });
}

fn read(session: &Session, artwork_key: &mut String, artwork: &mut Option<String>) -> windows::core::Result<NowPlaying> {
    let props = session.TryGetMediaPropertiesAsync()?.join()?;
    let title = props.Title()?.to_string();
    let artist = props.Artist()?.to_string();
    let app_id = session.SourceAppUserModelId()?.to_string();

    let key = format!("{app_id}\u{1}{title}\u{1}{artist}");
    if *artwork_key != key {
        *artwork_key = key;
        *artwork = props.Thumbnail().ok().and_then(|t| load_thumbnail(&t).ok());
    } else if artwork.is_none() {
        // Manche Apps liefern das Cover erst kurz nach dem Titel.
        *artwork = props.Thumbnail().ok().and_then(|t| load_thumbnail(&t).ok());
    }

    let playback = session.GetPlaybackInfo()?;
    let is_playing = playback.PlaybackStatus()? == PlaybackStatus::Playing;
    let can_seek = playback.Controls().and_then(|c| c.IsPlaybackPositionEnabled()).unwrap_or(false);
    let timeline = session.GetTimelineProperties()?;
    let duration = ticks_to_secs(timeline.EndTime()?.Duration - timeline.StartTime()?.Duration);
    let mut position = ticks_to_secs(timeline.Position()?.Duration);

    // GSMTC meldet die Position nur sporadisch → auf jetzt hochrechnen.
    if is_playing {
        let updated = timeline.LastUpdatedTime()?.UniversalTime;
        let elapsed = ticks_to_secs(now_filetime() - updated);
        if updated > 0 && (0.0..86_400.0).contains(&elapsed) {
            position += elapsed;
        }
    }
    if duration > 0.0 {
        position = position.clamp(0.0, duration);
    }

    Ok(NowPlaying { title, artist, artwork: artwork.clone(), is_playing, position, duration, can_seek, app_id })
}

fn load_thumbnail(reference: &windows::Storage::Streams::IRandomAccessStreamReference) -> windows::core::Result<String> {
    let stream = reference.OpenReadAsync()?.join()?;
    let size = stream.Size()? as u32;
    let mime = stream.ContentType().map(|m| m.to_string()).unwrap_or_default();
    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size)?.join()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes)?;
    let mime = if mime.is_empty() { "image/png".into() } else { mime };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Nur senden, wenn sich etwas Sichtbares geändert hat oder gespult wurde.
fn changed(last: &Option<NowPlaying>, current: &Option<NowPlaying>, last_sent_at: SystemTime) -> bool {
    match (last, current) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            if a.title != b.title || a.artist != b.artist || a.is_playing != b.is_playing
                || a.artwork != b.artwork || a.duration != b.duration || a.app_id != b.app_id
                || a.can_seek != b.can_seek
            {
                return true;
            }
            let elapsed = last_sent_at.elapsed().map(|d| d.as_secs_f64()).unwrap_or(0.0);
            let expected = if a.is_playing { a.position + elapsed } else { a.position };
            (expected - b.position).abs() > SEEK_THRESHOLD
        }
        _ => true,
    }
}

/// WinRT-Zeiten sind 100-ns-Ticks.
fn ticks_to_secs(ticks: i64) -> f64 {
    ticks as f64 / 10_000_000.0
}

/// Jetzt als FILETIME (100-ns-Ticks seit 1601), passend zu `DateTime::UniversalTime`.
fn now_filetime() -> i64 {
    const EPOCH_DIFF_SECS: i64 = 11_644_473_600;
    let since_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (since_unix.as_secs() as i64 + EPOCH_DIFF_SECS) * 10_000_000 + since_unix.subsec_nanos() as i64 / 100
}
