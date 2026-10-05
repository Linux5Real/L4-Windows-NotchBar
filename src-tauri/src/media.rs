//! Now Playing via GlobalSystemMediaTransportControls (GSMTC).
//!
//! Covers everything Windows shows in its volume flyout: Spotify, browsers
//! (YouTube, SoundCloud …), Apple Music, VLC and so on. A thread polls the current
//! session and emits `media://update` when something changes.
//! Polling instead of WinRT events: more robust when sessions switch, negligible cost.

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
    /// Cover as a data URL, `None` if the app provides none.
    artwork: Option<String>,
    is_playing: bool,
    /// Seconds, already extrapolated to the time of the query.
    position: f64,
    /// Seconds; 0 = unknown (e.g. live streams).
    duration: f64,
    /// Does the app allow seeking? (Spotify, YouTube: yes; some players: no)
    can_seek: bool,
    app_id: String,
}

#[derive(Default)]
pub struct MediaState(Mutex<Option<NowPlaying>>);

#[tauri::command]
pub fn media_get(state: State<'_, MediaState>) -> Option<NowPlaying> {
    state.0.lock().unwrap().clone()
}

// Async so the blocking `join()` doesn't stall the main thread.
#[tauri::command]
pub async fn media_control(action: String, position: Option<f64>) -> Result<(), String> {
    let run = || -> windows::core::Result<()> {
        let session = SessionManager::RequestAsync()?.join()?.GetCurrentSession()?;
        match action.as_str() {
            "toggle" => session.TryTogglePlayPauseAsync()?.join()?,
            "next" => session.TrySkipNextAsync()?.join()?,
            "previous" => session.TrySkipPreviousAsync()?.join()?,
            "seek" => {
                // Position relative to the timeline start, in 100 ns ticks.
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
/// Drift beyond which a position counts as a seek and is sent again.
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
        // Only reload the cover when the title changes.
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
        // Some apps deliver the cover shortly after the title.
        *artwork = props.Thumbnail().ok().and_then(|t| load_thumbnail(&t).ok());
    }

    let playback = session.GetPlaybackInfo()?;
    let is_playing = playback.PlaybackStatus()? == PlaybackStatus::Playing;
    let can_seek = playback.Controls().and_then(|c| c.IsPlaybackPositionEnabled()).unwrap_or(false);
    let timeline = session.GetTimelineProperties()?;
    let duration = ticks_to_secs(timeline.EndTime()?.Duration - timeline.StartTime()?.Duration);
    let mut position = ticks_to_secs(timeline.Position()?.Duration);

    // GSMTC reports the position only sporadically, so extrapolate to now.
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

/// Only emit when something visible changed or the user seeked.
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

/// WinRT times are 100 ns ticks.
fn ticks_to_secs(ticks: i64) -> f64 {
    ticks as f64 / 10_000_000.0
}

/// Now as FILETIME (100 ns ticks since 1601), matching `DateTime::UniversalTime`.
fn now_filetime() -> i64 {
    const EPOCH_DIFF_SECS: i64 = 11_644_473_600;
    let since_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (since_unix.as_secs() as i64 + EPOCH_DIFF_SECS) * 10_000_000 + since_unix.subsec_nanos() as i64 / 100
}
