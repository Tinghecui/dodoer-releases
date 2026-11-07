// WS wire-protocol constants shared by `WebTransport` and
// `RemoteDesktopTransport`. The string values MUST stay in sync with their
// Rust counterparts in `src-tauri/src/web/ws.rs` — drift will break the
// server→client handshake silently.
export const WS_READY_CHANNEL = "__ready__"

// Cowork fork: the optional handshake (`src/lib/transport/server-info.ts`). A
// client sends `{ action: hello }` after each `__ready__`; a server that knows
// it answers with one `{ type: server_info, ... }`, an older one with nothing.
// MUST match the consts in `src-tauri/src/web/ws_attach.rs`.
export const WS_HELLO_ACTION = "hello"
export const WS_SERVER_INFO_TYPE = "server_info"
