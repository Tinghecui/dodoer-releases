// The WS wire constants are written out on both sides of the protocol: the
// TypeScript transports here, the server in `web/ws.rs` and `web/auth.rs`,
// the desktop app's remote proxy in `commands/remote_proxy.rs`. Nothing ties them together, and
// a drift breaks the handshake silently, so this reads the Rust sources and
// holds every copy to the TypeScript value.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WS_READY_CHANNEL } from "./constants"
import { CODEG_WS_PROTOCOL } from "./ws-auth"

const rust = (file: string) =>
  readFileSync(join(__dirname, "../../../src-tauri/src", file), "utf8")

function rustConst(source: string, name: string): string | undefined {
  const m = new RegExp(`const ${name}: &str = "([^"]*)";`).exec(source)
  return m?.[1]
}

function tsConst(source: string, name: string): string | undefined {
  const m = new RegExp(`const ${name} = "([^"]*)"`).exec(source)
  return m?.[1]
}

describe("WS protocol constants agree across TypeScript and Rust", () => {
  const ws = rust("web/ws.rs")
  const auth = rust("web/auth.rs")
  const proxy = rust("commands/remote_proxy.rs")
  const wsAuth = readFileSync(join(__dirname, "ws-auth.ts"), "utf8")
  const tokenPrefix = tsConst(wsAuth, "CODEG_WS_TOKEN_PROTOCOL_PREFIX")

  it("ready channel", () => {
    expect(rustConst(ws, "WS_READY_CHANNEL")).toBe(WS_READY_CHANNEL)
    expect(rustConst(proxy, "WS_READY_CHANNEL")).toBe(WS_READY_CHANNEL)
  })

  it("event subprotocol and token prefix", () => {
    expect(tokenPrefix).toBeTruthy()
    expect(rustConst(auth, "WS_EVENT_PROTOCOL")).toBe(CODEG_WS_PROTOCOL)
    expect(rustConst(auth, "WS_TOKEN_PROTOCOL_PREFIX")).toBe(tokenPrefix)
    expect(rustConst(proxy, "WS_EVENT_PROTOCOL")).toBe(CODEG_WS_PROTOCOL)
    expect(rustConst(proxy, "WS_TOKEN_PROTOCOL_PREFIX")).toBe(tokenPrefix)
  })
})
