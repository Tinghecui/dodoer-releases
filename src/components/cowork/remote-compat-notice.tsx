"use client"

import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { useAppUpdate } from "@/components/providers/update-provider"
import { judgeCompat, readServerCompat } from "@/lib/cowork/compat"
import { useCoworkText } from "@/lib/cowork/i18n"
import { getTransport, isRemoteDesktopMode } from "@/lib/transport"

const TOAST_ID = "cowork-compat"
/** Re-checked when the window comes back after this long: Cowork may have
 * upgraded the server (and its minimum desktop version) meanwhile. */
const RECHECK_AFTER_MS = 10 * 60 * 1000

/**
 * In a remote-desktop window, checks once whether this app and the server work
 * together (`src/lib/cowork/compat.ts`) and, when they don't, says which side
 * to upgrade in a toast that stays until dismissed. A too-old app gets a
 * "check for update" button (the desktop app updates itself). Renders nothing.
 */
export function RemoteCompatNotice() {
  const t = useCoworkText()
  const update = useAppUpdate()
  const checkNowRef = useRef(update?.checkNow)
  checkNowRef.current = update?.checkNow
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    if (!isRemoteDesktopMode()) return
    let cancelled = false
    let lastCheck = 0

    const check = async () => {
      lastCheck = Date.now()
      let health: unknown
      let version: string
      try {
        health = await getTransport().call("health", {}, { timeoutMs: 8000 })
        const { getVersion } = await import("@tauri-apps/api/app")
        version = await getVersion()
      } catch (err) {
        // Offline or restarting: the connection UI says so; try next time.
        lastCheck = 0
        console.warn("[RemoteCompatNotice] check failed:", err)
        return
      }
      if (cancelled) return
      const verdict = judgeCompat(readServerCompat(health), version)
      const tr = tRef.current
      if (verdict.kind === "ok") {
        toast.dismiss(TOAST_ID)
      } else if (verdict.kind === "desktop_too_old") {
        toast.warning(tr("desktopTooOld"), {
          id: TOAST_ID,
          duration: Infinity,
          description: tr("desktopTooOldHint", {
            required: verdict.required,
            version: verdict.version,
          }),
          action: {
            label: tr("checkForUpdate"),
            onClick: () => void checkNowRef.current?.({ silent: false }),
          },
        })
      } else {
        toast.warning(tr("serverTooOld"), {
          id: TOAST_ID,
          duration: Infinity,
          description: tr("serverTooOldHint"),
        })
      }
    }

    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastCheck >= RECHECK_AFTER_MS) void check()
    }

    void check()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  return null
}
