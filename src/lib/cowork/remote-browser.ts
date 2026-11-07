// Cowork fork: a remote workspace window lending its built-in browser to the
// server's agents (`docs/remote-browser.md`). The server sends an agent's
// browser call down the event socket to this app, which runs it on this
// window's tabs — the per-tab share and the `browser_eval` prompt included.

import { useEffect, useState } from "react"

import { serverHasFeature } from "@/lib/cowork/compat"
import {
  getShellTransport,
  getTransport,
  isRemoteDesktopMode,
} from "@/lib/transport"

/** The `server_info` feature of a server that takes this app's tabs
 *  (`FEATURE` in `src-tauri/src/web/host_registry.rs`). */
export const HOST_BRIDGE_FEATURE = "host_bridge_ws"

/** Whether this window's tabs can be shared with agents: always in a local
 *  window; in a remote one, once its server says it takes them. A server from
 *  before this has no way to reach them, so sharing there would hand a page to
 *  nobody. */
export function useCanShareWithAgents(): boolean {
  const remote = isRemoteDesktopMode()
  const [lends, setLends] = useState(false)
  useEffect(() => {
    if (!remote) return
    let transport: ReturnType<typeof getTransport>
    try {
      transport = getTransport()
    } catch {
      // No transport to ask (yet): nothing has said the server takes the
      // tabs, so they stay unshared.
      return
    }
    return transport.onServerInfo?.((info) =>
      setLends(serverHasFeature(info, HOST_BRIDGE_FEATURE))
    )
  }, [remote])
  return !remote || lends
}

/**
 * In a remote window, turning a browser switch on for the server turns it on
 * for this computer too: the tabs are this computer's, and the app lends them
 * only while its own switch is on (a server cannot turn their use on for it).
 * Turning one off is left to the server alone: with the server's switch off
 * no call comes here, and this computer's own workspace keeps its setting.
 */
export async function lendBrowserSwitch(key: string): Promise<void> {
  if (!isRemoteDesktopMode()) return
  if (key !== "browser" && key !== "browser_eval") return
  const shell = getShellTransport()
  if (key === "browser_eval") {
    // `browser_eval` is nothing with its group off.
    await shell.call("set_codeg_mcp_tool_group", {
      key: "browser",
      enabled: true,
    })
  }
  await shell.call("set_codeg_mcp_tool_group", { key, enabled: true })
}
