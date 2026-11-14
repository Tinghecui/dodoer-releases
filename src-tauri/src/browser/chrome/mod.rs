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
//! So far this is the connection alone: no tab of Chrome is listed, read or
//! acted on yet.
//!
//! - `endpoint` — where a running Chrome says it can be reached
//! - `cdp`      — the DevTools protocol over one WebSocket
//! - `link`     — the one connection the app keeps, and its state

pub mod cdp;
pub mod endpoint;
pub mod link;

pub use link::{ChromeLink, ChromeStatus};

/// Backend → frontend: the state of the connection changed (`ChromeStatus`).
pub const STATUS_EVENT: &str = "browser://chrome";
