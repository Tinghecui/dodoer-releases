// Cowork fork: lending this computer's shell to a remote workspace's agents
// (`docs/host-ssh.md`). The switch and the SSH service behind it are this
// app's, so every call here goes to the app (the shell transport), never to
// the window's server.

import { useCallback, useEffect, useRef, useState } from "react"

import { serverHasFeature } from "@/lib/cowork/compat"
import {
  getActiveRemoteConnectionId,
  getShellTransport,
  getTransport,
  isDesktop,
  isRemoteDesktopMode,
} from "@/lib/transport"

/** Sent by the app whenever a lending or the service changed
 *  (`HOST_SSH_CHANGED_EVENT` in `src-tauri/src/commands/host_ssh.rs`). */
export const HOST_SSH_CHANGED_EVENT = "host-ssh://changed"

/** The `server_info` feature of a server whose agents can reach a lent
 *  computer. No server has it yet: the tunnel is the next step, and until
 *  then lending only readies this side. */
export const HOST_SSH_FEATURE = "host_ssh"

/** `LendingStatus` in `src-tauri/src/host_ssh/mod.rs`. */
export interface HostSshStatus {
  supported: boolean
  lent: boolean
  running: boolean
  error: string | null
}

/** `SelfTest` in `src-tauri/src/host_ssh/sshd.rs`. */
export interface HostSshSelfTest {
  ok: boolean
  tools: string[]
  detail: string | null
}

/** `Permission` in `src-tauri/src/host_ssh/permissions.rs`. */
export type HostSshPermission = "screenRecording" | "accessibility"

/** `Permissions` there: the macOS permissions a lent shell borrows from the
 *  app, as they stand for this run of it. */
export interface HostSshPermissions {
  applicable: boolean
  selfResponsible: boolean
  items: { permission: HostSshPermission; granted: boolean }[]
}

export function getHostSshStatus(connectionId: number): Promise<HostSshStatus> {
  return getShellTransport().call("host_ssh_status", { connectionId })
}

export function setHostSshLent(
  connectionId: number,
  lent: boolean
): Promise<HostSshStatus> {
  return getShellTransport().call("host_ssh_set_lent", { connectionId, lent })
}

export function runHostSshSelfTest(): Promise<HostSshSelfTest> {
  return getShellTransport().call("host_ssh_self_test")
}

export function getHostSshPermissions(): Promise<HostSshPermissions> {
  return getShellTransport().call("host_ssh_permissions")
}

/** Clear the app's grant and ask again: the system's dialog comes up. */
export function repairHostSshPermission(
  permission: HostSshPermission
): Promise<HostSshPermissions> {
  return getShellTransport().call("host_ssh_repair_permission", { permission })
}

/** The connection whose server this window could lend the computer to: a
 *  remote window's, in the desktop app. A local window's agents are on this
 *  computer already, and a browser has no computer to lend. */
export function lendableConnectionId(): number | null {
  if (!isDesktop() || !isRemoteDesktopMode()) return null
  return getActiveRemoteConnectionId()
}

/**
 * This window's lending, followed live: the app says when anything changed
 * (another window of the same server flipped the switch, the service died),
 * and the status is asked again.
 */
export function useHostSsh() {
  const [connectionId] = useState(lendableConnectionId)
  const [status, setStatus] = useState<HostSshStatus | null>(null)
  const [serverTakes, setServerTakes] = useState(false)
  /** Bumped by every read issued and every answer adopted: a read is
   *  applied only if nothing newer happened since it was asked. */
  const seqRef = useRef(0)

  const refresh = useCallback(async () => {
    if (connectionId === null) return
    const seq = ++seqRef.current
    try {
      const next = await getHostSshStatus(connectionId)
      if (seq === seqRef.current) setStatus(next)
    } catch {
      // Keep the last known answer; the next change or opening asks again.
    }
  }, [connectionId])

  /** Adopt what a switch of this window's own answered. */
  const adopt = useCallback((next: HostSshStatus) => {
    seqRef.current++
    setStatus(next)
  }, [])

  useEffect(() => {
    if (connectionId === null) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    getShellTransport()
      .subscribe(HOST_SSH_CHANGED_EVENT, () => void refresh())
      .then((off) => {
        if (disposed) off()
        else unsubscribe = off
      })
      .catch(() => {})
      // Subscribed before the first read, so nothing in between is missed.
      .finally(() => {
        if (!disposed) void refresh()
      })
    // A change missed while the window was busy heals when it comes back to
    // the front.
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      disposed = true
      unsubscribe?.()
      window.removeEventListener("focus", onFocus)
    }
  }, [connectionId, refresh])

  useEffect(() => {
    if (connectionId === null) return
    let transport: ReturnType<typeof getTransport>
    try {
      transport = getTransport()
    } catch {
      // No transport to ask (yet): nothing has said the server can use it.
      return
    }
    return transport.onServerInfo?.((info) =>
      setServerTakes(serverHasFeature(info, HOST_SSH_FEATURE))
    )
  }, [connectionId])

  return { connectionId, status, serverTakes, refresh, adopt }
}
