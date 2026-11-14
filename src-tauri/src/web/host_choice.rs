//! Cowork fork: which of a person's computers this server's agents use
//! (`docs/host-choice.md`).
//!
//! A person may have the desktop app open on two computers, both lending
//! this server their tabs (`web::host_registry`) or their command line
//! (`host_ssh`). The registry decides which one takes a call; here is how a
//! person sees what it decided and fixes it to one computer instead:
//!
//! * `POST /api/get_host_devices` — the computers registered now, what each
//!   lends, what is fixed, and where a browser call and `ssh desktop` go
//!   right now;
//! * `POST /api/set_host_choice` — fix the browser or the command line to
//!   one of those computers, or leave it to the registry again.
//!
//! The choice is the server's, not an app's: it holds from whichever
//! computer, browser or phone the person talks to their agents — which is
//! the point of fixing it ("I am on the laptop, use the Mac mini's
//! browser"). It is kept in the database, so it holds across restarts too.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use super::host_registry::{ChooseError, HostChoices, HostDevices};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::db::service::app_metadata_service;

/// The `server_info` feature a client looks for before it shows the chooser
/// (`compat::FEATURES`).
pub const FEATURE: &str = "host_choice";

/// Where the choices are kept (`app_metadata`), as JSON.
const KEY_CHOICES: &str = "host_choice.choices";

/// Hand the registry the choices kept from before the server last stopped.
pub async fn restore(state: &AppState) {
    match app_metadata_service::get_value(&state.db.conn, KEY_CHOICES).await {
        Ok(Some(stored)) => match serde_json::from_str::<HostChoices>(&stored) {
            Ok(choices) => state.host_registry.set_choices(choices),
            Err(e) => tracing::warn!("[host-choice] the stored choice does not read: {e}"),
        },
        Ok(None) => {}
        Err(e) => tracing::warn!("[host-choice] reading the stored choice: {e}"),
    }
}

/// `POST /api/get_host_devices` (`cowork::api_routes`).
pub async fn get_host_devices(Extension(state): Extension<Arc<AppState>>) -> Json<HostDevices> {
    Json(state.host_registry.devices())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetHostChoiceParams {
    /// `browser` or `shell`.
    capability: String,
    /// A registered computer's id; nothing to leave it to the registry.
    #[serde(default)]
    device_id: Option<String>,
}

/// `POST /api/set_host_choice` (`cowork::api_routes`): the state afterwards.
pub async fn set_host_choice(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetHostChoiceParams>,
) -> Result<Json<HostDevices>, AppCommandError> {
    let choices = state
        .host_registry
        .choose(&params.capability, params.device_id.as_deref())
        .map_err(|e| match e {
            ChooseError::NoSuchCapability => AppCommandError::invalid_input(format!(
                "No computer is chosen for \"{}\"",
                params.capability
            )),
            ChooseError::NoSuchDevice => AppCommandError::not_found(
                "That computer is not connected to this workspace right now",
            ),
        })?;
    let stored = serde_json::to_string(&choices)
        .map_err(|e| AppCommandError::invalid_input(e.to_string()))?;
    // Kept or not, the registry already follows it: say so rather than
    // leave the person looking at the old choice.
    if let Err(e) = app_metadata_service::upsert_value(&state.db.conn, KEY_CHOICES, &stored).await
    {
        tracing::warn!("[host-choice] keeping the choice: {e}");
    }
    Ok(Json(state.host_registry.devices()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parameters_read_as_the_client_sends_them() {
        let fix: SetHostChoiceParams =
            serde_json::from_str(r#"{"capability":"browser","deviceId":"0123456789abcdef"}"#)
                .unwrap();
        assert_eq!(fix.capability, "browser");
        assert_eq!(fix.device_id.as_deref(), Some("0123456789abcdef"));
        let free: SetHostChoiceParams =
            serde_json::from_str(r#"{"capability":"shell","deviceId":null}"#).unwrap();
        assert_eq!(free.device_id, None);
        let bare: SetHostChoiceParams = serde_json::from_str(r#"{"capability":"shell"}"#).unwrap();
        assert_eq!(bare.device_id, None);
    }

    /// What the chooser reads: camelCase, as `src/lib/cowork/host-choice.ts`
    /// mirrors it.
    #[test]
    fn the_state_serializes_as_the_client_reads_it() {
        let registry = Arc::new(crate::web::host_registry::HostRegistry::new());
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let _host = registry.register_on(
            tx,
            vec!["browser".into(), "chrome".into()],
            None,
            None,
            Some(crate::host_device::HostDevice {
                id: "0123456789abcdef".into(),
                name: "MacBook".into(),
            }),
        );
        registry
            .choose("browser", Some("0123456789abcdef"))
            .unwrap();
        assert_eq!(
            serde_json::to_value(registry.devices()).unwrap(),
            serde_json::json!({
                "devices": [{
                    "key": "0123456789abcdef",
                    "id": "0123456789abcdef",
                    "name": "MacBook",
                    "browser": true,
                    "chrome": true,
                    "shell": false,
                }],
                "choices": {
                    "browser": {"id": "0123456789abcdef", "name": "MacBook"},
                    "shell": null,
                },
                "browserNow": "0123456789abcdef",
                "shellNow": null,
            })
        );
    }
}
