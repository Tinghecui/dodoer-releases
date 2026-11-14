//! The person's own Chrome, as a browser agents can be given.
//!
//! The built-in browser is a profile of its own: nothing the person is
//! signed in to elsewhere is signed in there. Their everyday Chrome is where
//! the sign-ins are, so this connects to that one — through the switch at
//! `chrome://inspect/#remote-debugging`, which the person turns on, and a
//! dialog in Chrome, which they answer for each connection. The design, what
//! was measured on a real Chrome before any of it was written, and the steps
//! still to come are in `docs/agent-chrome.md`.
//!
//! So far this is the connection and the list of Chrome's tabs, which only
//! the person sees: no tab is in the browser registry, so no agent can name,
//! read or act on one yet.
//!
//! - `endpoint` — where a running Chrome says it can be reached
//! - `cdp`      — the DevTools protocol over one WebSocket
//! - `link`     — the one connection the app keeps, and its state
//! - `tabs`     — which web pages the connected Chrome has open

pub mod cdp;
pub mod endpoint;
pub mod link;
pub mod tabs;

pub use link::{ChromeLink, ChromeStatus};
pub use tabs::ChromeTab;

/// Backend → frontend: the state of the connection changed (`ChromeStatus`).
pub const STATUS_EVENT: &str = "browser://chrome";

/// Backend → frontend: the connected Chrome's tabs changed (`Vec<ChromeTab>`,
/// empty when not connected).
pub const TABS_EVENT: &str = "browser://chrome-tabs";
