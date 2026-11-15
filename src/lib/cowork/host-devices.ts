// Cowork fork: the book of the person's devices this server keeps
// (`docs/devices.md`, `web::host_devices`). Every computer that ever
// connected a desktop app is in it — online, or since when not — under a
// name the person and the agents call it by.
//
// The book is the server's, so it is asked through the window's own
// transport — the same from a remote window, a browser or a phone. Only
// "which of these is the computer I am at" is the app's.

import { useCallback, useEffect, useRef, useState } from "react"

import { serverHasFeature } from "@/lib/cowork/compat"
import {
  getShellTransport,
  getTransport,
  isDesktop,
  isRemoteDesktopMode,
} from "@/lib/transport"

/** The `server_info` feature of a server that keeps the book
 *  (`FEATURE` in `src-tauri/src/web/host_devices.rs`). */
export const HOST_DEVICES_FEATURE = "host_devices"

/** `NAME_MAX` there. */
export const DEVICE_NAME_MAX = 32

/** `DeviceView` in `src-tauri/src/web/host_devices.rs`. */
export interface HostDevice {
  id: string
  /** What the person and the agents call it. */
  name: string
  /** The person chose the name, or kept the one offered: not asked again. */
  named: boolean
  /** The computer's own name ("James's MacBook Air"). */
  computerName: string
  /** "MacBook Air", "iMac"; empty from an app from before this. */
  model: string
  /** `desktop`, `laptop`; later `phone`, `tablet`. */
  kind: string | null
  platform: string | null
  appVersion: string | null
  /** Milliseconds since 1970. */
  firstSeen: number
  /** When it was last connected (about now, while it is). */
  lastSeen: number
  online: boolean
  /** It lends its command line now. */
  shell: boolean
  /** It lends its tabs now. */
  browser: boolean
  /** …and the person lets agents use their own Chrome there. */
  chrome: boolean
}

/** `DeviceList` there. */
export interface HostDeviceList {
  /** Online first, then the one seen last. */
  devices: HostDevice[]
  /** Apps connected now too old to say which computer they are on. */
  unnamedHosts: number
}

/** `HostDevice` in `src-tauri/src/host_device.rs`: this app's computer. */
export interface ThisDevice {
  id: string
  name: string
  model?: string
  kind?: string | null
}

export function listHostDevices(): Promise<HostDeviceList> {
  return getTransport().call("list_host_devices", {})
}

/** Call device `id` `name` (or keep its name, marking it chosen). Answers
 *  the list afterwards. */
export function renameHostDevice(
  id: string,
  name: string
): Promise<HostDeviceList> {
  return getTransport().call("rename_host_device", { id, name })
}

/** Take a device that is not connected out of the book. */
export function forgetHostDevice(id: string): Promise<HostDeviceList> {
  return getTransport().call("forget_host_device", { id })
}

/** The computer this app is on; `null` when it has no id to go by. */
export function getThisDevice(): Promise<ThisDevice | null> {
  return getShellTransport().call("host_device")
}

/** Whether this window talks to a server that may have devices: in a
 *  browser, and in a remote window of the desktop app. A local window's
 *  agents are on this computer. */
export function hostDevicesApply(): boolean {
  return !isDesktop() || isRemoteDesktopMode()
}

/** What the person typed, as the server keeps it. */
export function normalizeDeviceName(text: string): string {
  return text.trim().toLowerCase()
}

/** `is_name` there: lowercase letters, digits and dashes, starting and
 *  ending with a letter or a digit, at most [`DEVICE_NAME_MAX`]. */
export function isDeviceName(name: string): boolean {
  return (
    name.length <= DEVICE_NAME_MAX &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)
  )
}

/** "5 minutes ago", "yesterday", in the window's language; a date past a
 *  week. */
export function lastSeenText(
  lastSeen: number,
  locale: string,
  now: number = Date.now()
): string {
  const seconds = Math.max(0, Math.round((now - lastSeen) / 1000))
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  if (seconds < 60) return relative.format(0, "second")
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return relative.format(-minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 24) return relative.format(-hours, "hour")
  const days = Math.round(hours / 24)
  if (days <= 7) return relative.format(-days, "day")
  return new Date(lastSeen).toLocaleDateString(locale)
}

/** How often the list is asked again: nothing tells a window that a
 *  computer came or went, and the list is short. */
export const HOST_DEVICES_POLL_MS = 30_000
/** While the person is looking at it. */
export const HOST_DEVICES_POLL_OPEN_MS = 5_000

/**
 * The book, kept current: asked on a timer (faster while `watching`), and
 * when the window comes back to the front. `list` stays `null` where there
 * is nothing to ask — a local window, a server from before this.
 */
export function useHostDevices(watching: boolean) {
  const [applies] = useState(hostDevicesApply)
  const [serverTakes, setServerTakes] = useState(false)
  const [list, setList] = useState<HostDeviceList | null>(null)
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null)
  /** Bumped by every read issued and every answer adopted: a read is applied
   *  only if nothing newer happened since it was asked. */
  const seqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const next = await listHostDevices()
      if (seq === seqRef.current) setList(next)
    } catch {
      // Keep the last known answer; the next tick asks again.
    }
  }, [])

  /** Adopt what a change of this window's own answered. */
  const adopt = useCallback((next: HostDeviceList) => {
    seqRef.current++
    setList(next)
  }, [])

  useEffect(() => {
    if (!applies) return
    let transport: ReturnType<typeof getTransport>
    try {
      transport = getTransport()
    } catch {
      // No transport to ask (yet): nothing has said the server can answer.
      return
    }
    return transport.onServerInfo?.((info) =>
      setServerTakes(serverHasFeature(info, HOST_DEVICES_FEATURE))
    )
  }, [applies])

  useEffect(() => {
    if (!applies || !serverTakes) return
    let disposed = false
    // The first read, as soon as the server says it can be asked.
    void Promise.resolve().then(() => {
      if (!disposed) void refresh()
    })
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== "hidden") void refresh()
      },
      watching ? HOST_DEVICES_POLL_OPEN_MS : HOST_DEVICES_POLL_MS
    )
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [applies, serverTakes, watching, refresh])

  useEffect(() => {
    if (!applies || !isDesktop()) return
    let disposed = false
    getThisDevice()
      .then((device) => {
        if (!disposed) setThisDeviceId(device?.id ?? null)
      })
      // An app from before this: no device of the list is marked as this
      // one, and everything else works.
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [applies])

  return { list: applies && serverTakes ? list : null, thisDeviceId, adopt }
}
