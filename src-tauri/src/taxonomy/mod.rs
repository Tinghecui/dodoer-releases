//! jenny fork: the conversation mind map (分类导图).
//!
//! Each project (a root folder, worktrees included) keeps a small tree of
//! categories, each with a rule saying what belongs in it, and which category
//! every conversation sits in. The canvas draws it XMind-style.
//!
//! Three hands move things:
//! - **At night** a Codex automation reads every project's conversations
//!   (title and first prompt only) through `codeg-cli taxonomy export`,
//!   decides whether to add, change or remove categories and rules, and hands
//!   in the whole new tree with its placements (`codeg-cli taxonomy apply`).
//!   Only then does the tree change. See `docs/conversation-mindmap.md`.
//! - **During the day** Jev places each new conversation, from its first
//!   prompt, into one of the existing categories ([`classify`]).
//! - **The user** may move a conversation by hand; the night leaves that be.

pub mod classify;
pub mod model;
pub mod service;
pub mod store;

pub use store::{TaxonomyChanged, CONVERSATION_TAXONOMY_CHANGED_EVENT};
