//! The surface behind a tab of the person's own Chrome that they handed to
//! agents, or that an agent opened there (`browser::chrome::page`).
//!
//! The other surfaces answer on the main thread; this one answers over the
//! DevTools connection, which only ever answers later. So what the registry
//! asks for synchronously — the address, whether it is loading, history — is
//! what the page last reported, and every operation is started here and
//! finishes on its own task, reporting through the callback it was given
//! where there is one.
//!
//! What the app does to how a tab of its own is shown (bounds, zoom, find,
//! inspector, freeze frames) does nothing here: the tab is in Chrome, and
//! Chrome's. Nothing paints into it and nothing runs in the page's own world
//! — the person's page is not the app's to write to.

use std::future::Future;

use serde_json::{json, Value};
use tauri::Url;

use super::agent::PointerButton;
use super::chrome::cdp::CdpError;
use super::chrome::ChromePage;
use super::surface::{PointerFailure, PointerGesture, SurfaceError};

/// Why a Chrome tab will not run an agent's code in the page.
pub const NO_PAGE_SCRIPT: &str =
    "running code in the page is not available for tabs of the person's own Chrome";

/// What the operations that are Chrome's own answer, when asked for one.
pub const NOT_OURS: &str = "this belongs to the person's own Chrome, not to the app";

#[derive(Clone)]
pub struct ExternalHandle {
    page: ChromePage,
    label: String,
}

impl ExternalHandle {
    pub fn new(page: ChromePage, tab_id: &str) -> Self {
        Self {
            page,
            label: format!("chrome-{tab_id}"),
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// Close the tab in Chrome (`ChromePage::close_target`): for a tab an
    /// agent opened, never for one the person handed over.
    pub fn close_tab(&self) {
        self.page.close_target();
    }

    pub fn url(&self) -> Result<Url, SurfaceError> {
        Url::parse(&self.page.url()).map_err(|err| SurfaceError(err.to_string()))
    }

    pub fn is_loading(&self) -> bool {
        self.page.is_loading()
    }

    pub fn can_go_back(&self) -> bool {
        self.page.can_go_back()
    }

    pub fn can_go_forward(&self) -> bool {
        self.page.can_go_forward()
    }

    pub fn navigate(&self, url: &Url) -> Result<(), SurfaceError> {
        let page = self.page.clone();
        let url = url.to_string();
        start("navigate", async move { page.navigate(&url).await });
        Ok(())
    }

    pub fn reload(&self) -> Result<(), SurfaceError> {
        let page = self.page.clone();
        start("reload", async move { page.reload().await });
        Ok(())
    }

    pub fn stop(&self) -> Result<(), SurfaceError> {
        let page = self.page.clone();
        start("stop", async move { page.stop().await });
        Ok(())
    }

    pub fn go(&self, delta: i64) -> Result<(), SurfaceError> {
        let page = self.page.clone();
        start("history", async move { page.go(delta).await });
        Ok(())
    }

    /// Let the tab go. It stays open in Chrome: closing a tab of the app's
    /// means handing this one back, never closing the person's page.
    pub fn close(&self) {
        self.page.detach();
    }

    pub fn eval_in_world(
        &self,
        expression: &str,
        callback: impl Fn(Result<String, String>) + Send + 'static,
    ) {
        let page = self.page.clone();
        let expression = expression.to_string();
        tauri::async_runtime::spawn(async move {
            // Awaited before the call: `callback(…await)` would hold a borrow
            // of the callback across the await, and it need not be `Sync`.
            let result = page.eval_in_world(&expression).await;
            callback(result);
        });
    }

    pub fn dispatch_pointer(
        &self,
        gesture: PointerGesture,
        done: impl FnOnce(Result<(), PointerFailure>) + Send + 'static,
    ) {
        let page = self.page.clone();
        let steps = mouse_steps(gesture);
        tauri::async_runtime::spawn(async move {
            let result = page.mouse(&steps).await.map_err(|failure| PointerFailure {
                // Step 0 is the move; a button has reached the page only
                // once a later step was taken.
                delivered: failure.step > 0,
                error: failure.error,
            });
            done(result);
        });
    }

    pub fn snapshot_png(&self, callback: impl Fn(Result<Vec<u8>, String>) + Send + 'static) {
        let page = self.page.clone();
        tauri::async_runtime::spawn(async move {
            let result = page.screenshot_png().await;
            callback(result);
        });
    }
}

/// Run `operation` on its own; a failure is logged, the way an engine's own
/// failed navigation is reported by the page rather than by the call.
fn start(what: &'static str, operation: impl Future<Output = Result<(), CdpError>> + Send + 'static) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = operation.await {
            tracing::warn!("[chrome] {what} in a shared tab failed: {err}");
        }
    });
}

/// A gesture as `Input.dispatchMouseEvent` steps, in viewport CSS pixels —
/// the unit the world's `locate` answers in, so nothing is scaled. A click is
/// a move, then a press and a release per count.
fn mouse_steps(gesture: PointerGesture) -> Vec<Value> {
    let event = |kind: &str, x: f64, y: f64, button: &str, count: u8| {
        json!({ "type": kind, "x": x, "y": y, "button": button, "clickCount": count })
    };
    match gesture {
        PointerGesture::Move { x, y } => vec![event("mouseMoved", x, y, "none", 0)],
        PointerGesture::Click { x, y, button, count } => {
            let name = match button {
                PointerButton::Left => "left",
                PointerButton::Right => "right",
            };
            let mut steps = vec![event("mouseMoved", x, y, "none", 0)];
            for n in 1..=count.max(1) {
                steps.push(event("mousePressed", x, y, name, n));
                steps.push(event("mouseReleased", x, y, name, n));
            }
            steps
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_double_click_is_a_move_and_two_press_release_pairs() {
        let steps = mouse_steps(PointerGesture::Click {
            x: 10.0,
            y: 20.0,
            button: PointerButton::Left,
            count: 2,
        });
        let kinds: Vec<&str> = steps.iter().map(|step| step["type"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            ["mouseMoved", "mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]
        );
        assert_eq!(steps[3]["clickCount"], 2);
        assert_eq!(steps[1]["button"], "left");
        assert_eq!(mouse_steps(PointerGesture::Move { x: 1.0, y: 1.0 }).len(), 1);
    }
}
