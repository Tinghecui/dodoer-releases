"use client"

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { Loader2, WifiOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  acquireNativeSurfaceOcclusion,
  subscribeNativeSurfaceReclaim,
} from "@/lib/browser/native-surface-occlusion"
import type { RemoteDesktopTransport } from "@/lib/transport/remote-desktop-transport"

type ConnectionHealth = Pick<
  RemoteDesktopTransport,
  | "getConnectionSnapshot"
  | "subscribeConnection"
  | "eventStream"
  | "reconnectNow"
>

/** Mounted after the remote transport is configured, so it cannot subscribe
 * to the local shell by mistake. Keep the workspace mounted during an outage,
 * which the proxy keeps retrying, and show a manual recovery action once this
 * window's subscription to it has stopped. */
export function RemoteConnectionStatus({
  transport,
}: {
  transport: ConnectionHealth
}) {
  const t = useTranslations("WebConnection")
  const subscribe = useCallback(
    (callback: () => void) => transport.subscribeConnection(callback),
    [transport]
  )
  const getSnapshot = useCallback(
    () => transport.getConnectionSnapshot(),
    [transport]
  )
  const state = useSyncExternalStore(subscribe, getSnapshot, () => "connected")
  const [graceElapsed, setGraceElapsed] = useState(false)
  // A retry the user just asked for shows its progress at once: the pill is
  // already up, and hiding it for the grace window reads as "nothing
  // happened".
  const [retryRequested, setRetryRequested] = useState(false)

  useEffect(() => {
    // Settings and other restored remote shells may have no conversation
    // subscribers yet. Start the same shared proxy, not a second socket.
    transport.eventStream()
  }, [transport])

  useEffect(() => {
    if (state !== "reconnecting") return
    const timer = setTimeout(() => setGraceElapsed(true), 4_000)
    return () => {
      clearTimeout(timer)
      setGraceElapsed(false)
      setRetryRequested(false)
    }
  }, [state])

  const retry = () => {
    transport.reconnectNow()
    // Only a retry that started: the transport ignores one while another
    // is still under way.
    setRetryRequested(transport.getConnectionSnapshot() === "reconnecting")
  }

  const showing = !(
    state === "connected" ||
    (state === "reconnecting" && !graceElapsed && !retryRequested)
  )

  // 用户这次断线里已经点回了浏览器：这次断线不再遮，连上以后清掉。
  const [reclaimed, setReclaimed] = useState(false)
  const outage = state !== "connected"
  useEffect(() => {
    if (!outage) return
    return () => setReclaimed(false)
  }, [outage])

  // 内置浏览器是盖在所有 DOM 上面的原生视图，提示条伸进浏览器栏的那截会被
  // 挡住。跟弹出提示（app-toaster 的 ToastOcclusion）一样拿一个被动租约：
  // 浏览器停在最后一帧，用户一点浏览器就放掉租约、把页面还给他。
  useEffect(() => {
    if (!showing || reclaimed) return
    const release = acquireNativeSurfaceOcclusion("connection-status", {
      passive: true,
    })
    const unsubscribe = subscribeNativeSurfaceReclaim(() => setReclaimed(true))
    return () => {
      unsubscribe()
      release()
    }
  }, [showing, reclaimed])

  if (!showing) return null

  const retrying = state === "reconnecting"
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100%_-_2rem)] items-center gap-3 rounded-xl border bg-background px-4 py-3 text-sm shadow-lg"
    >
      {retrying ? (
        <Loader2 className="size-4 shrink-0 animate-spin" />
      ) : (
        <WifiOff className="size-4 shrink-0 text-destructive" />
      )}
      <div>
        <p>{t("disconnectedTitle")}</p>
        {retrying && (
          <p className="text-muted-foreground">
            {t("reconnectingDescription")}
          </p>
        )}
      </div>
      {!retrying && (
        <Button size="sm" onClick={retry}>
          {t("reconnectNow")}
        </Button>
      )}
    </div>
  )
}
