//! A thread that asks the main thread and the tokio runtime for a heartbeat
//! every second, and marks the app hung while one of them has not answered
//! for [`HANG_AFTER`]. One heartbeat per side is in flight at a time: a new
//! one is sent only once the last was answered.
//!
//! The tokio heartbeat sleeps for a millisecond before it answers, so it
//! needs the runtime's timers as well as a free worker: on 2026-11-15 the
//! worker that drove the timers was the one stuck in `AppHandle::restart()`
//! (#271).
//!
//! It also keeps the running marker fresh: rewritten every minute, and as
//! soon as what the app is doing changes (an update, the quit).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::store::Phase;
use crate::update::state::AppUpdateLifecycle;

const TICK: Duration = Duration::from_secs(1);
/// Unanswered this long = hung.
const HANG_AFTER: Duration = Duration::from_secs(10);
/// How often the hung marker is rewritten with how long it has been.
const HANG_REWRITE: Duration = Duration::from_secs(5);
/// How often the running marker is rewritten when nothing changed.
const ALIVE_EVERY: Duration = Duration::from_secs(60);
/// A tick this late means this thread was not running either — the computer
/// slept — and what was in flight did not wait that long.
const SLEPT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Beat {
    Main,
    Tokio,
}

impl Beat {
    fn name(self) -> &'static str {
        match self {
            Beat::Main => "main",
            Beat::Tokio => "tokio",
        }
    }

    /// Send a heartbeat; the flag turns true when it is answered. `None` when
    /// it could not be sent (the event loop has ended).
    fn send(self, app: &AppHandle) -> Option<Arc<AtomicBool>> {
        let answered = Arc::new(AtomicBool::new(false));
        let flag = answered.clone();
        match self {
            Beat::Main => app
                .run_on_main_thread(move || flag.store(true, Ordering::SeqCst))
                .ok()?,
            Beat::Tokio => {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    flag.store(true, Ordering::SeqCst);
                });
            }
        }
        Some(answered)
    }
}

struct Side {
    beat: Beat,
    /// The heartbeat in flight: when it was sent, and whether it was answered.
    sent: Option<(Instant, Arc<AtomicBool>)>,
    /// Unanswered for longer than [`HANG_AFTER`].
    hung: bool,
}

impl Side {
    fn new(beat: Beat) -> Self {
        Self {
            beat,
            sent: None,
            hung: false,
        }
    }

    fn waited(&self, now: Instant) -> Option<Duration> {
        self.sent
            .as_ref()
            .map(|(sent, _)| now.duration_since(*sent))
    }
}

pub fn spawn(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("crash-report-watchdog".to_string())
        .spawn(move || watch(app));
    if let Err(e) = spawned {
        tracing::warn!("[crash-report] could not start the watchdog: {e}");
    }
}

/// What the app is doing, from state that exists anyway.
fn phase(app: &AppHandle) -> Phase {
    let update = app
        .try_state::<crate::update::AppUpdateStateHandle>()
        .map(|handle| crate::update::state::snapshot(&handle).status)
        .filter(|status| !matches!(status, AppUpdateLifecycle::Idle | AppUpdateLifecycle::Error))
        .and_then(|status| serde_json::to_value(status).ok())
        .and_then(|value| value.as_str().map(str::to_string));
    Phase {
        update,
        quitting: super::quitting(),
    }
}

fn watch(app: AppHandle) {
    let mut sides = [Side::new(Beat::Main), Side::new(Beat::Tokio)];
    let mut last_tick = Instant::now();
    // What the running marker last said, and when; `None` = not written.
    let mut written: Option<(Phase, Instant)> = None;
    // When the hung marker was last written; `None` = there is none.
    let mut hang_written: Option<Instant> = None;
    loop {
        std::thread::sleep(TICK);
        if super::stopped() {
            return;
        }
        let now = Instant::now();
        let gap = now.duration_since(last_tick);
        last_tick = now;
        if !super::enabled() {
            // Start over when it is turned back on.
            sides = [Side::new(Beat::Main), Side::new(Beat::Tokio)];
            written = None;
            hang_written = None;
            continue;
        }
        if gap > SLEPT {
            let lost = gap.saturating_sub(TICK);
            for side in &mut sides {
                if let Some((sent, _)) = &mut side.sent {
                    *sent = sent.checked_add(lost).unwrap_or(now).min(now);
                }
            }
        }

        let phase = phase(&app);
        for side in &mut sides {
            let answered = side
                .sent
                .as_ref()
                .map(|(_, flag)| flag.load(Ordering::SeqCst));
            let waited = side.waited(now).unwrap_or_default();
            match answered {
                Some(true) => {
                    if side.hung {
                        super::write_recovered(side.beat.name(), waited.as_secs(), &phase);
                    }
                    side.sent = None;
                    side.hung = false;
                }
                Some(false) => side.hung = side.hung || waited > HANG_AFTER,
                None => {}
            }
            if side.sent.is_none() {
                side.sent = side.beat.send(&app).map(|flag| (now, flag));
            }
        }

        let hung: Vec<&Side> = sides.iter().filter(|side| side.hung).collect();
        if hung.is_empty() {
            if hang_written.take().is_some() {
                super::remove_hang_marker();
            }
        } else if hang_written.is_none_or(|at| now.duration_since(at) >= HANG_REWRITE) {
            let names = hung
                .iter()
                .map(|side| side.beat.name().to_string())
                .collect();
            let stuck = hung
                .iter()
                .filter_map(|side| side.waited(now))
                .max()
                .unwrap_or_default();
            super::write_hang_marker(names, stuck.as_secs(), &phase);
            hang_written = Some(now);
        }

        let fresh = written
            .as_ref()
            .is_some_and(|(said, at)| *said == phase && now.duration_since(*at) < ALIVE_EVERY);
        if !fresh {
            super::write_run_marker(&phase);
            written = Some((phase, now));
        }
    }
}
