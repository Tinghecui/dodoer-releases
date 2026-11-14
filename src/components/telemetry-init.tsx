"use client"

import { useEffect } from "react"
import { useCachedCoworkInfo } from "@/lib/cowork/info"
import { isRemoteDesktopWindow } from "@/lib/platform"
import { installEarlyCapture, startTelemetry } from "@/lib/telemetry"

/**
 * Cowork fork: starts telemetry once the server's `cowork_info` says it is
 * on (docs/telemetry.md §5.3). Does not ask for `cowork_info` itself — the
 * workspace's account menu and update checks do, and on the login page a
 * call would only meet a 401 — and until then keeps uncaught errors for the
 * SDK to send once it starts. Nothing is loaded while telemetry is off.
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
  return null
}
