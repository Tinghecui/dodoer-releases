"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { automationList } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import type { Automation } from "@/lib/types"

const AUTOMATION_CHANGED_EVENT = "automation://changed"

interface AutomationsViewContextValue {
  automations: Automation[]
  /** Sum of unseen failed runs — drives the sidebar badge. */
  unseenFailures: number
  /** 还没成功拉到过列表、而上一次请求失败时的错误原文；其余时候是 null。
   *  页面靠它把「加载失败」和「还没有自动化」分开（#339）。 */
  error: string | null
  refetch: () => Promise<void>
}

const AutomationsViewContext =
  createContext<AutomationsViewContextValue | null>(null)

/**
 * Data layer for the Automations feature: the automation list + a realtime
 * subscription, kept always-mounted so the sidebar's failure badge stays live.
 * It is the single source for both the badge and the Automations route page.
 *
 * Navigation lives in WorkbenchRouteProvider (the sidebar sets the route, the
 * content region swaps), so this provider holds data only — no open-state, no
 * rendered overlay.
 */
export function useAutomationsView() {
  const ctx = useContext(AutomationsViewContext)
  if (!ctx) {
    throw new Error(
      "useAutomationsView must be used within AutomationsViewProvider"
    )
  }
  return ctx
}

export function AutomationsViewProvider({ children }: { children: ReactNode }) {
  const [automations, setAutomations] = useState<Automation[]>([])
  const [error, setError] = useState<string | null>(null)
  const reqRef = useRef(0)
  // 成功拉到过一次列表以后，瞬时失败只保留旧列表、不报错。
  const loadedRef = useRef(false)

  const refetch = useCallback(async () => {
    const id = ++reqRef.current
    try {
      const list = await automationList()
      // Drop stale responses; keep the previous list on transient error rather
      // than blanking the view (matches CONVERSATION_CHANGED_EVENT consumers).
      if (id !== reqRef.current) return
      loadedRef.current = true
      setAutomations(list)
      setError(null)
    } catch (err) {
      // 已经有列表时忽略，后面的事件或重连会补上；还没成功过就记下错误，
      // 页面显示「加载失败」和「重试」，不再进 onboarding（#339）。
      if (id === reqRef.current && !loadedRef.current) {
        setError(toErrorMessage(err))
      }
    }
  }, [])

  useEffect(() => {
    // Initial fetch + subscribe for backend-pushed updates. `refetch` only
    // setStates after an await / inside the subscribe callback (the canonical
    // "subscribe to an external system, setState in the callback" effect), and
    // its deps are stable, so this can't cascade. Same block-disable idiom as
    // workspace-context.tsx.
    /* eslint-disable react-hooks/set-state-in-effect */
    void refetch()
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(AUTOMATION_CHANGED_EVENT, () => {
      void refetch()
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    // Events fired while the WS was disconnected are dropped by the broadcaster
    // (receiver_count == 0); re-fetch on reconnect so a run that settled during
    // the gap doesn't leave the list stale. No-op on desktop IPC.
    const offReconnect = onTransportReconnect(() => {
      void refetch()
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [refetch])

  const unseenFailures = useMemo(
    () => automations.reduce((sum, a) => sum + (a.unseen_failures || 0), 0),
    [automations]
  )

  const value = useMemo<AutomationsViewContextValue>(
    () => ({ automations, unseenFailures, error, refetch }),
    [automations, unseenFailures, error, refetch]
  )

  return (
    <AutomationsViewContext.Provider value={value}>
      {children}
    </AutomationsViewContext.Provider>
  )
}
