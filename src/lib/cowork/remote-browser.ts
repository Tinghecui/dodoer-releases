// Cowork fork: a remote workspace window lending its built-in browser to the
// server's agents (`docs/remote-browser.md`). The server sends an agent's
// browser call down the event socket to this app, which runs it on this
// window's tabs — the per-tab share and the `browser_eval` prompt included.

import { useEffect, useState } from "react"

import { serverHasFeature } from "@/lib/cowork/compat"
import { listHostDevices } from "@/lib/cowork/host-devices"
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

/** The last answer `serverTakesTabs` heard, and whether it is listening. */
let takesTabs = false
let watching = false

/**
 * `useCanShareWithAgents` for code outside React: whether this remote window's
 * server takes its tabs, as of the last `server_info`. It starts listening on
 * the first ask; a `server_info` already in hand answers that ask at once.
 */
export function serverTakesTabs(): boolean {
  if (!watching) {
    let transport: ReturnType<typeof getTransport>
    try {
      transport = getTransport()
    } catch {
      // No transport yet: ask again next time.
      return false
    }
    watching = true
    transport.onServerInfo?.((info) => {
      takesTabs = serverHasFeature(info, HOST_BRIDGE_FEATURE)
    })
  }
  return takesTabs
}

export function resetServerTakesTabsForTests(): void {
  takesTabs = false
  watching = false
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

/** 远端窗口里，服务器上的智能体要看到这台电脑的 Chrome 标签还要看的两样
 *  （#1060）：这台电脑自己的浏览器工具开没开（关着就不向服务器借出标签），
 *  服务器记着几台电脑（多于一台时，对话要在「选电脑」里选这台）。 */
export interface RemoteBrowserReach {
  browserTools: boolean
  devices: number
}

/** 本地窗口没有可说的，给 `null`。服务器记的电脑问不到（老服务器）时按一台算。 */
export async function remoteBrowserReach(): Promise<RemoteBrowserReach | null> {
  if (!isRemoteDesktopMode()) return null
  const settings = await getShellTransport().call<{ enabled?: boolean }>(
    "get_browser_tools_settings"
  )
  let devices = 1
  try {
    devices = (await listHostDevices()).devices.length
  } catch {
    // 问不到：不提示选电脑
  }
  return { browserTools: settings?.enabled === true, devices }
}
