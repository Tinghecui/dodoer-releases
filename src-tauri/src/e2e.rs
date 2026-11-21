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
