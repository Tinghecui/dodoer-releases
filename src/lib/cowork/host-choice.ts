// Cowork fork: which of the person's computers this workspace's agents use
// (`docs/host-choice.md`). A person may have the desktop app open on two
// computers, both lending the same server their tabs or their command line;
// the server says which one takes a call, and the person can fix it to one.
//
// The list and the choice are the server's (`web::host_choice`), so they are
// asked through the window's own transport — the same from a remote window,
// a browser or a phone. Only "which of these is the computer I am at" is the
// app's.

import { useCallback, useEffect, useRef, useState } from "react"

import { serverHasFeature } from "@/lib/cowork/compat"
import {
  getShellTransport,
  getTransport,
  isDesktop,
  isRemoteDesktopMode,
} from "@/lib/transport"

/** The `server_info` feature of a server that can be asked
 *  (`FEATURE` in `src-tauri/src/web/host_choice.rs`). */
export const HOST_CHOICE_FEATURE = "host_choice"

/** What a computer is chosen for: browser calls, or `ssh desktop`. */
export type HostCapability = "browser" | "shell"

/** `LendingDevice` in `src-tauri/src/web/host_registry.rs`. */
export interface LendingDevice {
  /** What `browserNow` and `shellNow` name it by. */
  key: string
  /** What a choice names it by; `null` for an app too old to say which
   *  computer it is on, which cannot be fixed on. */
  id: string | null
  name: string
  browser: boolean
  /** Its person lets this workspace's agents use their own Chrome there. */
  chrome: boolean
  shell: boolean
}

/** `PinnedDevice` there: a computer something is fixed to, with the name it
 *  had then — what there is to show while it is away. */
export interface PinnedDevice {
  id: string
  name: string
}

/** `HostDevices` there. */
export interface HostDevices {
  /** The one used last first. */
  devices: LendingDevice[]
  choices: Record<HostCapability, PinnedDevice | null>
  /** The `key` of the computer a browser call goes to now, if anywhere. */
  browserNow: string | null
  shellNow: string | null
}

/** `HostDevice` in `src-tauri/src/host_device.rs`. */
export interface ThisDevice {
  id: string
  name: string
}

export function getHostDevices(): Promise<HostDevices> {
  return getTransport().call("get_host_devices", {})
}

/** Fix `capability` to the computer `deviceId`, or leave it to the server
 *  again (`null`). Answers the state afterwards. */
export function setHostChoice(
  capability: HostCapability,
  deviceId: string | null
): Promise<HostDevices> {
  return getTransport().call("set_host_choice", { capability, deviceId })
}

/** The computer this app is on; `null` when it has no id to go by. */
export function getThisDevice(): Promise<ThisDevice | null> {
  return getShellTransport().call("host_device")
}

/** Whether this window's agents can be on another machine than its tabs: in
 *  a browser, and in a remote window of the desktop app. A local window's
 *  agents are on this computer and use it. */
export function hostChoiceApplies(): boolean {
  return !isDesktop() || isRemoteDesktopMode()
}

/** How often the list is asked again: nothing tells a window that a computer
 *  came or went, and the list is short. */
export const HOST_DEVICES_POLL_MS = 30_000
/** While the person is looking at it. */
export const HOST_DEVICES_POLL_OPEN_MS = 5_000

/**
 * The computers lending this workspace something, and the person's choices,
 * kept current: asked on a timer (faster while `watching`), and when the
 * window comes back to the front. `state` stays `null` where there is
 * nothing to ask — a local window, a server from before this.
 */
export function useHostDevices(watching: boolean) {
  const [applies] = useState(hostChoiceApplies)
  const [serverTakes, setServerTakes] = useState(false)
  const [state, setState] = useState<HostDevices | null>(null)
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null)
  /** Bumped by every read issued and every answer adopted: a read is applied
   *  only if nothing newer happened since it was asked. */
  const seqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const next = await getHostDevices()
      if (seq === seqRef.current) setState(next)
    } catch {
      // Keep the last known answer; the next tick asks again.
    }
  }, [])

  /** Adopt what a choice of this window's own answered. */
  const adopt = useCallback((next: HostDevices) => {
    seqRef.current++
    setState(next)
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
      setServerTakes(serverHasFeature(info, HOST_CHOICE_FEATURE))
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
      // An app from before this: no computer of the list is marked as this
      // one, and everything else works.
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [applies])

  return { state: applies && serverTakes ? state : null, thisDeviceId, adopt }
}

/** Where things stand for one capability, for the chooser to say. */
export interface HostChoiceView {
  /** The computer it is fixed to, if any. */
  pinned: PinnedDevice | null
  /** The computer a call goes to now, if any. */
  now: LendingDevice | null
  /** Fixed to a computer that is not lending it: calls fail until it is
   *  back, or the person chooses again. */
  away: boolean
}

export function hostChoiceView(
  state: HostDevices,
  capability: HostCapability
): HostChoiceView {
  const pinned = state.choices[capability]
  const nowKey = capability === "browser" ? state.browserNow : state.shellNow
  const now = state.devices.find((device) => device.key === nowKey) ?? null
  return { pinned, now, away: pinned !== null && now === null }
}
