"use client"

import { ChevronLeft, Monitor } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { AppTitleBar } from "@/components/layout/app-title-bar"
import { MobileBackButton } from "@/components/layout/mobile-back-button"
import { leaveInPage } from "@/lib/in-page-navigation"

/**
 * 手机布局下打开了只在电脑上有用的页面（合并编辑器、画布、宠物、导入会话、
 * 快捷键这类设置页）时，放在页面位置上的统一提示：一句「请在电脑上使用」和
 * 返回按钮（#1335）。页面本身不挂载。
 *
 * `onBack` 不给时按当前页打开的页面处理：有历史记录就后退，没有就回到工作区。
 * 工作区里的整页路由（画布）给自己的返回：回到会话。
 */
export function DesktopOnlyNotice({ onBack }: { onBack?: () => void }) {
  const t = useTranslations("DesktopOnly")
  return (
    <div
      role="status"
      data-desktop-only-notice
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <Monitor className="h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{t("message")}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => (onBack ?? leaveInPage)()}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t("back")}
      </Button>
    </div>
  )
}

/**
 * 单独一页（合并、导入会话、宠物）在手机布局下的整页替身：和这些页一样的
 * 标题栏（左边是返回），下面是 {@link DesktopOnlyNotice}。
 */
export function DesktopOnlyPage({ title }: { title?: string }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar
        left={<MobileBackButton />}
        center={
          title ? (
            <div className="text-sm font-semibold tracking-tight">{title}</div>
          ) : undefined
        }
      />
      <main className="min-h-0 flex-1">
        <DesktopOnlyNotice />
      </main>
    </div>
  )
}
