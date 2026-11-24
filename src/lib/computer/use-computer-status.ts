"use client"

// Computer use's full status — the helper's permissions, codeg's own, the
// backend — as the status-bar popover and the settings page show it.
//
// Asked for when `live` turns on, and again each time this window comes back
// to the front while it stays on: whoever went to System Settings to grant a
// permission comes back expecting to see it. Each ask is fresh — the helper
// checks in a new process every time (a process that once heard "not
// granted" keeps hearing it), so a refresh is worth the name.
//
// A fetched value is only as new as the moment the fetch began; the shared
// windows and the backend status it carries go to the store through the
// `…Since` setters, which drop them if an event has moved on since.
//
// Granting is one step for the person: `request` has a helper started for
// the purpose ask macOS for that one permission — which lists the helper in
// System Settings, the only place either is actually turned on. macOS puts up
// a dialog of its own for it, with a button to that pane, until the person
// has once turned the switch off there; after that it says nothing, and
// `request` opens the pane itself. Never both at once.
//
// 刚打开开关时驱动往往还没装、helper 起不来，那一次拿不到权限报告；之后在
// 同一页装好驱动（`computer://driver` 报安装结束）或后端变成 ready，都再查
// 一次，不用人去点刷新。

import { useCallback, useEffect, useRef, useState } from "react"

import { toErrorMessage } from "@/lib/app-error"
import { subscribe } from "@/lib/platform"

import {
  computerOpenPermissionSettings,
  computerRequestPermission,
  computerRevealHelper,
  computerStatus,
} from "./computer-api"
import {
  computerStoreMark,
  setComputerBackendSince,
  setComputerSharedSince,
  useComputerStore,
} from "./computer-store"
import {
  COMPUTER_DRIVER_EVENT,
  type ComputerStatus,
  type DriverInfo,
  type OsPermission,
} from "./types"

export function useComputerStatus(live: boolean) {
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The permission a request is on its way for: one at a time, so a double
   *  click neither asks twice nor opens System Settings twice. */
  const [requesting, setRequesting] = useState<OsPermission | null>(null)
  const requestingRef = useRef(false)
  const aliveRef = useRef(true)
  const liveRef = useRef(live)
  useEffect(() => {
    liveRef.current = live
  }, [live])
  /** The latest refresh; an older one that answers late is dropped. */
  const seqRef = useRef(0)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    const mark = computerStoreMark()
    setLoading(true)
    try {
      const next = await computerStatus()
      if (!aliveRef.current || seq !== seqRef.current) return
      setStatus(next)
      setComputerSharedSince(next.shared, mark)
      setComputerBackendSince(next.backend, mark)
      setError(null)
    } catch (e) {
      if (aliveRef.current && seq === seqRef.current) {
        setError(toErrorMessage(e))
      }
    } finally {
      if (aliveRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!live) return
    void refresh()
    const onFocus = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [live, refresh])

  // 驱动装完或删完（不再带进行中的任务）时再查：装好之前 helper 起不来。
  useEffect(() => {
    if (!live) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    subscribe<DriverInfo>(COMPUTER_DRIVER_EVENT, (info) => {
      if (!disposed && info.task === undefined) void refresh()
    })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [live, refresh])

  // 后端从别的状态变成 ready 时再查；重取带回来的仍是 ready，不会再触发。
  // 之前一无所知（第一次查本身带回 ready）不算，那一次已经带着权限了。
  const backendState = useComputerStore().backend?.state
  const lastBackendStateRef = useRef(backendState)
  useEffect(() => {
    const previous = lastBackendStateRef.current
    lastBackendStateRef.current = backendState
    if (
      live &&
      backendState === "ready" &&
      previous !== undefined &&
      previous !== "ready"
    ) {
      void refresh()
    }
  }, [live, backendState, refresh])

  const request = useCallback(
    async (permission: OsPermission) => {
      if (requestingRef.current) return
      requestingRef.current = true
      setRequesting(permission)
      setError(null)
      try {
        const { report, prompted } = await computerRequestPermission(permission)
        const granted =
          permission === "accessibility"
            ? report.accessibility
            : report.screenRecording
        // Neither is ever turned on from the request itself: the switch is
        // in System Settings, which the system's own dialog leads to.
        if (report.required && !granted && !prompted) {
          await computerOpenPermissionSettings(permission)
        }
        if (liveRef.current) await refresh()
      } catch (e) {
        setError(toErrorMessage(e))
      } finally {
        requestingRef.current = false
        if (aliveRef.current) setRequesting(null)
      }
    },
    [refresh]
  )

  const openPermissionSettings = useCallback((permission: OsPermission) => {
    computerOpenPermissionSettings(permission).catch((e) =>
      setError(toErrorMessage(e))
    )
  }, [])

  const revealHelper = useCallback(() => {
    computerRevealHelper().catch((e) => setError(toErrorMessage(e)))
  }, [])

  return {
    status,
    loading,
    error,
    setError,
    refresh,
    request,
    requesting,
    openPermissionSettings,
    revealHelper,
  }
}

/** codeg itself holds a permission — one every agent's shell holds too.
 *  Only for a codeg that is its own responsible process: a development build
 *  run from a terminal reports the terminal's. */
export function codegHoldsPermission(status: ComputerStatus | null): boolean {
  const codeg = status?.codeg
  return (
    !!codeg?.selfResponsible && (codeg.accessibility || codeg.screenRecording)
  )
}
