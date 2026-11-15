// Cowork fork: which conversations use one of the person's computers right
// now — a device's browser (often their own Chrome) or its command line —
// for the mark on the conversation's sidebar row and tab
// (`docs/session-usage-badge.md`, `src-tauri/src/web/session_usage.rs`).
//
// The server decides; this keeps what it said. It is read once
// (`list_session_usage`) and then followed (`conversation://device-usage`),
// and read again after a reconnect, as `background-pending-store` does.

import { useEffect } from "react"
import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"

import { onTransportReconnect, subscribe } from "@/lib/platform"
import { getTransport } from "@/lib/transport"

/** `EVENT` in `session_usage.rs`. */
export const SESSION_USAGE_EVENT = "conversation://device-usage"

/** `UseKind` there. */
export type SessionUseKind = "browser" | "shell"

/** `Use` there. */
export interface SessionUse {
  kind: SessionUseKind
  /** The device's name; missing for the computer this app is on (or an app
   *  from before devices). */
  device?: string
  /** For the browser: its pages are in the person's own Chrome. Missing
   *  where the server does not know. */
  chrome?: boolean
  /** Milliseconds since 1970. */
  since: number
}

/** `UsageEntry` there. */
export interface SessionUsageEntry {
  conversationId: number
  uses: SessionUse[]
}

interface SessionUsageState {
  byConversation: ReadonlyMap<number, SessionUse[]>
}

const NONE: SessionUse[] = []

export const useSessionUsageStore = create<SessionUsageState>(() => ({
  byConversation: new Map(),
}))

export function listSessionUsage(): Promise<SessionUsageEntry[]> {
  return getTransport().call("list_session_usage", {})
}

function sameUses(a: SessionUse[], b: SessionUse[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (u, i) =>
        u.kind === b[i].kind &&
        u.device === b[i].device &&
        u.chrome === b[i].chrome &&
        u.since === b[i].since
    )
  )
}

/** Replace everything from a full listing. */
export function replaceSessionUsage(
  entries: Iterable<SessionUsageEntry>
): void {
  const next = new Map<number, SessionUse[]>()
  for (const entry of entries) {
    if (entry.uses.length > 0) next.set(entry.conversationId, entry.uses)
  }
  useSessionUsageStore.setState({ byConversation: next })
}

/** Apply one broadcast: the conversation's whole current state, no uses
 *  clearing it. A no-op (same reference) when it changes nothing. */
export function applySessionUsage(entry: SessionUsageEntry): void {
  const prev = useSessionUsageStore.getState().byConversation
  const have = prev.get(entry.conversationId)
  if (entry.uses.length === 0) {
    if (!have) return
    const next = new Map(prev)
    next.delete(entry.conversationId)
    useSessionUsageStore.setState({ byConversation: next })
    return
  }
  if (have && sameUses(have, entry.uses)) return
  const next = new Map(prev)
  next.set(entry.conversationId, entry.uses)
  useSessionUsageStore.setState({ byConversation: next })
}

/** What conversation `conversationId` uses now; empty when nothing. */
export function useSessionUsage(
  conversationId: number | null | undefined
): SessionUse[] {
  return useSessionUsageStore(
    useShallow((s) =>
      conversationId == null
        ? NONE
        : (s.byConversation.get(conversationId) ?? NONE)
    )
  )
}

/**
 * Keep the store current: subscribe, then read the listing (so a change
 * can't fall between the two), and read again after a reconnect — the
 * broadcaster drops what fires while nobody listens. Mount once per window.
 */
export function useSessionUsageSync(): void {
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    const seed = () => {
      Promise.resolve()
        .then(() => listSessionUsage())
        .then((entries) => {
          if (!disposed && Array.isArray(entries)) replaceSessionUsage(entries)
        })
        .catch(() => {
          // A server from before this: no marks.
        })
    }

    void (async () => {
      try {
        const dispose = await subscribe<SessionUsageEntry>(
          SESSION_USAGE_EVENT,
          (entry) => applySessionUsage(entry)
        )
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
      } catch (err) {
        console.error("[SessionUsage] subscribe failed:", err)
      }
      if (!disposed) seed()
    })()

    const offReconnect = onTransportReconnect(seed)

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])
}

/** The bridge component for layouts: mounts {@link useSessionUsageSync}. */
export function SessionUsageSync(): null {
  useSessionUsageSync()
  return null
}
