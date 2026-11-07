//! Cowork fork: what a server tells its clients about itself, on `/api/health`.
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
];

/// The fields `/api/health` adds for clients.
pub fn health_fields() -> serde_json::Map<String, serde_json::Value> {
    let mut fields = serde_json::Map::new();
    fields.insert("api_version".into(), API_VERSION.into());
    fields.insert("min_desktop_version".into(), MIN_DESKTOP_VERSION.into());
    fields.insert("features".into(), FEATURES.into());
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
        assert_eq!(fields["features"], serde_json::json!(["cowork_info"]));
    }

    #[test]
    fn min_desktop_version_is_semver() {
        assert!(semver::Version::parse(MIN_DESKTOP_VERSION).is_ok());
    }
}
