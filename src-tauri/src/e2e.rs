//! End-to-end test builds only (`e2e` feature, debug builds; `lib.rs`
//! refuses a release build with it). Registers what WebdriverIO's
//! `@wdio/tauri-service` drives the app through:
//!
//! - `tauri-plugin-wdio-webdriver` (macOS): an in-app W3C WebDriver server.
//!   Linux and Windows use tauri-driver instead.
//! - `tauri-plugin-wdio`: window states, `browser.tauri.execute`, mocks.
//!   Without it the service waits ~10 s before every element command
//!   looking for the focused window.
//!
//! The plugins' commands are granted here, at run time, rather than in
//! `capabilities/*.json`: a capability file naming `wdio:default` would not
//! build without the feature. The frontend half (`@wdio/tauri-plugin`) is in
//! the web bundle only when it is built with NEXT_PUBLIC_CODEG_E2E=1.
//! See .cowork/journal/2026-11-21-e2e-wdio-plugin.md.
//!
//! The update-flow suite (`scripts/desktop-e2e/update/`) also needs the app
//! to update from a fake feed on the runner instead of the real releases, see
//! .cowork/journal/2026-11-22-e2e-update-feed.md:
//!
//! - [`load_env_file`]: the settings below, from a file, because the updater
//!   relaunches the app through LaunchServices (`open -n`), which does not
//!   pass the environment on.
//! - [`updater_endpoints`] / [`updater_pubkey`]: the feed, and the test key
//!   its packages are signed with (made in CI for the run; never the real
//!   one, which no e2e build has).
//! - [`with_bundle_version`]: the version in the bundle's `Info.plist`, so
//!   the second package of a run (N+1) is the same build with another
//!   version in its `Info.plist` rather than a second compile.
//!
//! None of it is compiled without the feature, and the release check
//! (`scripts/check-no-e2e-bits.sh`) looks for the `CODEG_E2E_` names in the
//! shipped binary.

use tauri::{
    ipc::CapabilityBuilder,
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Builder, Manager, Runtime,
};

pub(crate) fn register<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(grant_wdio_commands())
}

fn grant_wdio_commands<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("codeg-e2e")
        .setup(|app, _api| {
            // Every window: the settings and remote workspace windows are
            // driven too.
            let capability = CapabilityBuilder::new("e2e-wdio")
                .window("*")
                .permission("wdio:default");
            app.add_capability(capability)?;
            Ok(())
        })
        .build()
}

/// Where [`load_env_file`] reads from, when set; else `~/.codeg-e2e.env`.
const ENV_FILE_VAR: &str = "CODEG_E2E_ENV_FILE";
/// The updater endpoints instead of the configured ones: one URL per line or
/// separated by spaces or commas.
const ENDPOINTS_VAR: &str = "CODEG_E2E_UPDATER_ENDPOINTS";
/// The updater's public key instead of the configured one (the content of
/// the `.pub` file `tauri signer generate` writes, base64).
const PUBKEY_VAR: &str = "CODEG_E2E_UPDATER_PUBKEY";

/// Set the variables of the e2e env file (`KEY=VALUE` lines; `#` comments
/// and blank lines skipped) that are not set already. A missing file is
/// nothing to do. Call while the process is single-threaded: before the
/// runtime starts, as `lib::run` does.
pub(crate) fn load_env_file() {
    let path = match std::env::var_os(ENV_FILE_VAR) {
        Some(path) => std::path::PathBuf::from(path),
        None => match dirs::home_dir() {
            Some(home) => home.join(".codeg-e2e.env"),
            None => return,
        },
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    for (key, value) in env_file_entries(&text) {
        if std::env::var_os(key).is_none() {
            // SAFETY: single-threaded, see the doc comment.
            unsafe { std::env::set_var(key, value) };
        }
    }
}

fn env_file_entries(text: &str) -> Vec<(&str, &str)> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .filter(|(key, _)| !key.is_empty())
        .collect()
}

/// The updater endpoints from [`ENDPOINTS_VAR`], when it is set and lists
/// any.
pub(crate) fn updater_endpoints() -> Option<Vec<String>> {
    let value = std::env::var(ENDPOINTS_VAR).ok()?;
    let list = split_endpoints(&value);
    (!list.is_empty()).then_some(list)
}

fn split_endpoints(value: &str) -> Vec<String> {
    value
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|endpoint| !endpoint.is_empty())
        .map(str::to_string)
        .collect()
}

/// The updater's public key from [`PUBKEY_VAR`], when it is set.
pub(crate) fn updater_pubkey() -> Option<String> {
    let key = std::env::var(PUBKEY_VAR).ok()?;
    let key = key.trim();
    (!key.is_empty()).then(|| key.to_string())
}

/// On macOS, when the app runs from a bundle whose `Info.plist` holds a
/// valid `CFBundleShortVersionString` other than the built one, that is the
/// version the app runs as (what the updater compares against, what the
/// windows show).
#[cfg(target_os = "macos")]
pub(crate) fn with_bundle_version<R: Runtime>(mut context: tauri::Context<R>) -> tauri::Context<R> {
    if let Some(version) = bundle_version() {
        if version != context.package_info().version {
            eprintln!(
                "[e2e] running as {version} (Info.plist), built as {}",
                context.package_info().version
            );
            context.config_mut().version = Some(version.to_string());
            context.package_info_mut().version = version;
        }
    }
    context
}

/// Elsewhere there is no bundle version to take.
#[cfg(not(target_os = "macos"))]
pub(crate) fn with_bundle_version<R: Runtime>(context: tauri::Context<R>) -> tauri::Context<R> {
    context
}

#[cfg(target_os = "macos")]
fn bundle_version() -> Option<semver::Version> {
    let exe = std::env::current_exe().ok()?;
    let bundle = crate::relaunch::app_bundle(&exe)?;
    let plist = std::fs::read_to_string(bundle.join("Contents/Info.plist")).ok()?;
    plist_string(&plist, "CFBundleShortVersionString")
        .and_then(|version| semver::Version::parse(version).ok())
}

/// The `<string>` after `<key>{key}</key>` in an XML property list.
#[cfg(target_os = "macos")]
fn plist_string<'a>(plist: &'a str, key: &str) -> Option<&'a str> {
    let after_key = &plist[plist.find(&format!("<key>{key}</key>"))?..];
    let start = after_key.find("<string>")? + "<string>".len();
    let rest = &after_key[start..];
    Some(rest[..rest.find("</string>")?].trim())
}
