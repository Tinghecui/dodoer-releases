"use client"

import { Suspense, useCallback, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { AppTitleBar } from "@/components/layout/app-title-bar"
import { MobileBackButton } from "@/components/layout/mobile-back-button"
import { DesktopOnlyPage } from "@/components/layout/desktop-only-notice"
import { useHideDesktopOnly } from "@/hooks/use-hide-desktop-only"
import { AppToaster } from "@/components/ui/app-toaster"
import { ImportSessionsWindow } from "@/components/import-sessions/import-sessions-window"
import { RemoteConnectionGate } from "@/contexts/remote-connection-context"
import { isDesktop } from "@/lib/platform"
import { leaveIfOpenedInPage } from "@/lib/in-page-navigation"
import { brandTitle } from "@/lib/cowork/brand"

const TOAST_DURATION_MS = 6000

function ImportSessionsPageInner() {
  const t = useTranslations("ImportSessions")
  const searchParams = useSearchParams()
  const focusPath = searchParams.get("focusPath")

  const closeWindow = useCallback(async () => {
    if (isDesktop()) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        await getCurrentWindow().close()
        return
      } catch (err) {
        console.error("[ImportSessionsPage] failed to close window:", err)
      }
    }
    // 手机布局下这一页是在当前页里打开的（#1332）：返回上一页
    if (leaveIfOpenedInPage()) return
    window.close()
  }, [])

  useEffect(() => {
    document.title = brandTitle(t("title"))
  }, [t])

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar
        left={<MobileBackButton />}
        center={
          <div className="text-sm font-semibold tracking-tight">
            {t("title")}
          </div>
        }
      />
      <main className="min-h-0 flex-1">
        <ImportSessionsWindow
          focusPath={focusPath}
          onClose={() => void closeWindow()}
        />
      </main>
      <AppToaster
        position="bottom-right"
        duration={TOAST_DURATION_MS}
        closeButton
      />
    </div>
  )
}

// 导入会话（扫本机的会话文件）手机上不做（#1335）：手机布局下整页换成
// 「请在电脑上使用」，不挂载导入窗口。
function ImportSessionsPageSwitch() {
  const t = useTranslations("ImportSessions")
  const hideDesktopOnly = useHideDesktopOnly()
  if (hideDesktopOnly) return <DesktopOnlyPage title={t("title")} />
  return <ImportSessionsPageInner />
}

export default function ImportSessionsPage() {
  return (
    <Suspense>
      <RemoteConnectionGate>
        <ImportSessionsPageSwitch />
      </RemoteConnectionGate>
    </Suspense>
  )
}
