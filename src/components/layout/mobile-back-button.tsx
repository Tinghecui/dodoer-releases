"use client"

import { ChevronLeft } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { leaveInPage, wasOpenedInPage } from "@/lib/in-page-navigation"
import { isDesktop } from "@/lib/transport"
import { isIosShell } from "@/lib/transport/detect"

/**
 * 设置、提交这些页面在手机布局（窄屏或 iOS 壳）下是在当前页里打开的，
 * 标题栏左边放这个返回按钮：有历史记录就后退，没有就回到工作区（#1332）。
 * 宽屏不显示：那时这些页面是单独的窗口，用窗口自己的关闭；但在当前页打开
 * 以后再拉宽的，还是显示（不然回不去）。桌面版不显示：窗口再窄，这些页面
 * 也是独立窗口。
 */
export function MobileBackButton() {
  const t = useTranslations("Folder.windowControls")
  const isMobile = useIsMobile()
  if (isDesktop()) return null
  if (!isMobile && !isIosShell() && !wasOpenedInPage()) return null
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      aria-label={t("back")}
      title={t("back")}
      onClick={leaveInPage}
    >
      <ChevronLeft className="h-4 w-4" />
    </Button>
  )
}
