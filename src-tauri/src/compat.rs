//! Cowork fork: what a server tells its clients about itself, on `/api/health`
//! and as the `server_info` answer to a WS `hello` (`web/ws.rs`).
//!
//! The desktop app and the server are released apart (the app updates itself
//! from dodoer-releases, the server is upgraded by Cowork), so every mix of an
//! older and a newer one will show up. A client reads these fields once, when
//! it connects (`src/lib/cowork/compat.ts`), and either works or says which
//! side to upgrade — instead of failing a click at a time on calls the other
//! side doesn't know.
//!
//! * [`API_VERSION`]: bump it when the server gains something a client may
//!   come to depend on as a whole (a changed contract, not a new optional
//!   route — those are [`FEATURES`]). A client that needs more refuses with
//!   "the server needs an upgrade" (`MIN_SERVER_API_VERSION` on its side).
//! * [`MIN_DESKTOP_VERSION`]: raise it when this server stops working with
//!   older desktop apps. They are told to update, with the update button.
//! * [`FEATURES`]: optional abilities a client checks before offering an
//!   entry, so it can hide what an older server lacks instead of failing.
//!
//! Only add; a field or feature a client reads must keep its meaning. Servers
//! from before this module send none of it, which a client reads as API
//! version 0, no minimum and no features.

/// The server's API revision (see the module docs).
pub const API_VERSION: u32 = 1;

/// The oldest desktop app this server works with: the first one released
/// through dodoer-releases (`1.<minor>.<patch>` of the cowork-codeg tag), so
/// the first one that can update itself.
pub const MIN_DESKTOP_VERSION: &str = "1.2.0";

/// Optional abilities a client may check (see the module docs).
pub const FEATURES: &[&str] = &[
    // `/api/cowork_info` (and the Cowork UI it unlocks).
    "cowork_info",
    // A desktop app may lend this server its built-in browser over
    // `/ws/events` (`web::host_registry`, `docs/remote-browser.md`).
    "host_bridge_ws",
];

/// The contract as one value: the `server_info` frame carries it as is
/// (`ServerMsg::ServerInfo`), `/api/health` as [`health_fields`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerInfo {
    pub api_version: u32,
    pub min_desktop_version: &'static str,
    pub features: &'static [&'static str],
}

pub fn server_info() -> ServerInfo {
    ServerInfo {
        api_version: API_VERSION,
        min_desktop_version: MIN_DESKTOP_VERSION,
        features: FEATURES,
    }
}

/// The fields `/api/health` adds for clients.
pub fn health_fields() -> serde_json::Map<String, serde_json::Value> {
    let info = server_info();
    let mut fields = serde_json::Map::new();
    fields.insert("api_version".into(), info.api_version.into());
    fields.insert(
        "min_desktop_version".into(),
        info.min_desktop_version.into(),
    );
    fields.insert("features".into(), info.features.into());
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_fields_carry_the_contract() {
        let fields = health_fields();
        assert_eq!(fields["api_version"], serde_json::json!(API_VERSION));
        assert_eq!(fields["min_desktop_version"], serde_json::json!("1.2.0"));
        assert_eq!(
            fields["features"],
            serde_json::json!(["cowork_info", "host_bridge_ws"])
        );
    }

    #[test]
    fn server_info_and_health_say_the_same() {
        let info = serde_json::to_value(server_info()).unwrap();
        assert_eq!(info, serde_json::Value::Object(health_fields()));
    }

    #[test]
    fn min_desktop_version_is_semver() {
        assert!(semver::Version::parse(MIN_DESKTOP_VERSION).is_ok());
    }
}
