// Cowork fork: the device a conversation's agent works on, for the mark
// beside its composer (`docs/devices.md` 8, `web::working_device`). The
// server keeps it; the agent changes it (`use_device`) when the person says
// so. The mark only shows it.

import { useCallback, useEffect, useRef, useState } from "react"

import { serverHasFeature } from "@/lib/cowork/compat"
import { hostDevicesApply, type HostDevice } from "@/lib/cowork/host-devices"
import { getTransport } from "@/lib/transport"

/** The `server_info` feature of a server that answers
 *  `get_conversation_device` (`FEATURE` in
 *  `src-tauri/src/web/working_device.rs`). */
export const CONVERSATION_DEVICE_FEATURE = "conversation_device"

/** How often it is asked again: nothing tells a window that the agent
 *  switched, or that the computer went. */
export const CONVERSATION_DEVICE_POLL_MS = 10_000

/** `ConversationDeviceAnswer` there. */
export interface ConversationDeviceAnswer {
  /** None until the conversation has one. */
  device: HostDevice | null
}

export function getConversationDevice(
  conversationId: number
): Promise<ConversationDeviceAnswer> {
  return getTransport().call("get_conversation_device", { conversationId })
}

/** Why the agent cannot go on with the device now, if it cannot. */
export type DeviceTrouble = "offline" | "lendsNothing"

export function deviceTrouble(device: HostDevice): DeviceTrouble | null {
  if (!device.online) return "offline"
  if (!device.shell && !device.browser) return "lendsNothing"
  return null
}

/**
 * The working device of `conversationId`, kept current: asked when the
 * conversation changes, on a timer while the window is in view, and when it
 * comes back to the front. `null` where there is none, or nothing to ask —
 * a local window, a server from before this.
 */
export function useConversationDevice(
  conversationId: number | null
): HostDevice | null {
  const [applies] = useState(hostDevicesApply)
  const [serverTakes, setServerTakes] = useState(false)
  /** The answer, with the conversation it is for. */
  const [known, setKnown] = useState<{
    conversationId: number
    device: HostDevice | null
  } | null>(null)
  /** A read is applied only if no newer one was asked since. */
  const seqRef = useRef(0)

  const refresh = useCallback(async (id: number) => {
    const seq = ++seqRef.current
    try {
      const answer = await getConversationDevice(id)
      if (seq === seqRef.current) {
        setKnown({ conversationId: id, device: answer.device ?? null })
      }
    } catch {
      // Keep the last known answer; the next tick asks again.
    }
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
      setServerTakes(serverHasFeature(info, CONVERSATION_DEVICE_FEATURE))
    )
  }, [applies])

  useEffect(() => {
    if (!applies || !serverTakes || conversationId == null) return
    let disposed = false
    void Promise.resolve().then(() => {
      if (!disposed) void refresh(conversationId)
    })
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh(conversationId)
    }, CONVERSATION_DEVICE_POLL_MS)
    const onFocus = () => void refresh(conversationId)
    window.addEventListener("focus", onFocus)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [applies, serverTakes, conversationId, refresh])

  if (!applies || !serverTakes || known?.conversationId !== conversationId) {
    return null
  }
  return known?.device ?? null
}
