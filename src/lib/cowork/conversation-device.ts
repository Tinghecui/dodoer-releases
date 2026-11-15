// Cowork fork: the device a conversation's agent works on, for the button
// beside its composer (`docs/devices.md` 6.7 and 8, `web::working_device`).
// The server keeps it; the person picks it on that button, and the agent
// switches it (`use_device`) only when the person names one in the chat.

import { useCallback, useEffect, useRef, useState } from "react"

import { serverHasFeature } from "@/lib/cowork/compat"
import { hostDevicesApply, type HostDevice } from "@/lib/cowork/host-devices"
import { getTransport } from "@/lib/transport"

/** The `server_info` feature of a server that answers
 *  `get_conversation_device` (`FEATURE` in
 *  `src-tauri/src/web/working_device.rs`). */
export const CONVERSATION_DEVICE_FEATURE = "conversation_device"

/** The `server_info` feature of a server that takes
 *  `set_conversation_device` (`PICK_FEATURE` there): the person picks the
 *  device on the button. */
export const CONVERSATION_DEVICE_PICK_FEATURE = "conversation_device_pick"

/** How often it is asked again: nothing tells a window that the agent
 *  switched, or that the computer went. */
export const CONVERSATION_DEVICE_POLL_MS = 10_000

/** `ConversationDeviceAnswer` there. */
export interface ConversationDeviceAnswer {
  /** None until the conversation has one. */
  device: HostDevice | null
  /** Its agent is waiting for the person to pick one. Missing from a server
   *  from before the picker. */
  needsPick?: boolean
  /** How many devices the server's book has. */
  deviceCount?: number
}

export function getConversationDevice(
  conversationId: number
): Promise<ConversationDeviceAnswer> {
  return getTransport().call("get_conversation_device", { conversationId })
}

/** The person picks `deviceId` for the conversation, or none. */
export function setConversationDevice(
  conversationId: number,
  deviceId: string | null
): Promise<ConversationDeviceAnswer> {
  return getTransport().call("set_conversation_device", {
    conversationId,
    deviceId,
  })
}

/** Whether the button is shown for `answer`: with a device, while the agent
 *  waits for one, or with more than one to pick from. One device alone is
 *  used as it is (`docs/devices.md` 6.2). */
export function offersPick(answer: ConversationDeviceAnswer): boolean {
  return !!answer.device || !!answer.needsPick || (answer.deviceCount ?? 0) > 1
}

/** Why the agent cannot go on with the device now, if it cannot. */
export type DeviceTrouble = "offline" | "lendsNothing"

export function deviceTrouble(device: HostDevice): DeviceTrouble | null {
  if (!device.online) return "offline"
  if (!device.shell && !device.browser) return "lendsNothing"
  return null
}

/** What the button of a conversation goes by. */
export interface ConversationDeviceState {
  answer: ConversationDeviceAnswer
  /** The server takes a pick (`set_conversation_device`). */
  canPick: boolean
  /** Pick `deviceId`, or none; what the server answers is shown at once.
   *  Rejects with what went wrong. */
  pick: (deviceId: string | null) => Promise<void>
}

/**
 * The working device of `conversationId`, kept current: asked when the
 * conversation changes, on a timer while the window is in view, and when it
 * comes back to the front. `null` where there is nothing to ask — a local
 * window, a server from before this — and until the first answer.
 */
export function useConversationDeviceState(
  conversationId: number | null
): ConversationDeviceState | null {
  const [applies] = useState(hostDevicesApply)
  const [serverTakes, setServerTakes] = useState(false)
  const [serverPicks, setServerPicks] = useState(false)
  /** The answer, with the conversation it is for. */
  const [known, setKnown] = useState<{
    conversationId: number
    answer: ConversationDeviceAnswer
  } | null>(null)
  /** A read is applied only if no newer one was asked since. */
  const seqRef = useRef(0)

  const refresh = useCallback(async (id: number) => {
    const seq = ++seqRef.current
    try {
      const answer = await getConversationDevice(id)
      if (seq === seqRef.current) {
        setKnown({
          conversationId: id,
          answer: { ...answer, device: answer.device ?? null },
        })
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
    return transport.onServerInfo?.((info) => {
      setServerTakes(serverHasFeature(info, CONVERSATION_DEVICE_FEATURE))
      setServerPicks(serverHasFeature(info, CONVERSATION_DEVICE_PICK_FEATURE))
    })
  }, [applies])

  const pick = useCallback(
    async (deviceId: string | null) => {
      if (conversationId == null) return
      const id = conversationId
      const answer = await setConversationDevice(id, deviceId)
      // Newer than any read on its way.
      seqRef.current++
      setKnown({
        conversationId: id,
        answer: { ...answer, device: answer.device ?? null },
      })
    },
    [conversationId]
  )

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

  if (
    !applies ||
    !serverTakes ||
    !known ||
    known.conversationId !== conversationId
  ) {
    return null
  }
  return { answer: known.answer, canPick: serverPicks, pick }
}

/** Just the working device of `conversationId` (see
 *  [`useConversationDeviceState`]). */
export function useConversationDevice(
  conversationId: number | null
): HostDevice | null {
  return useConversationDeviceState(conversationId)?.answer.device ?? null
}
