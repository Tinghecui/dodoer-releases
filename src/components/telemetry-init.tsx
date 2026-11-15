"use client"

import { useEffect } from "react"
import {
  loadLocalDaemonTelemetry,
  useCachedCoworkInfo,
} from "@/lib/cowork/info"
import { isRemoteDesktopWindow } from "@/lib/platform"
import { installEarlyCapture, startTelemetry } from "@/lib/telemetry"

/** Tries at asking the desktop app's own daemon, and the wait between them. */
export const LOCAL_TELEMETRY_TRIES = 3
export const LOCAL_TELEMETRY_RETRY_MS = 20_000

/**
 * Cowork fork: starts telemetry once the server's `cowork_info` says it is
 * on (docs/telemetry.md §5.3). Does not ask for `cowork_info` itself — the
 * workspace's account menu and update checks do, and on the login page a
 * call would only meet a 401 — and until then keeps uncaught errors for the
 * SDK to send once it starts. Nothing is loaded while telemetry is off.
 *
 * A local window of the desktop app asks its own daemon instead (§5.11): it
 * has no account menu to ask for it, and the daemon answers only when it
 * reports (a release build, diagnostics not turned off).
 */
export function TelemetryInit() {
  const config = useCachedCoworkInfo()?.telemetry
  useEffect(() => installEarlyCapture(), [])
  useEffect(() => {
    if (!config) return
    void startTelemetry(
      config,
      isRemoteDesktopWindow() ? "remote-desktop" : "web"
    )
  }, [config])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = (left: number) => {
      loadLocalDaemonTelemetry().then(
        (local) => {
          if (!cancelled && local) void startTelemetry(local, "desktop-local")
        },
        () => {
          // The daemon is restarting: ask again in a while.
          if (cancelled || left <= 1) return
          timer = setTimeout(() => attempt(left - 1), LOCAL_TELEMETRY_RETRY_MS)
        }
      )
    }
    attempt(LOCAL_TELEMETRY_TRIES)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])
  return null
}
