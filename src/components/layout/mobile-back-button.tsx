"use client"

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { ChevronLeft } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { leaveInPage, wasOpenedInPage } from "@/lib/in-page-navigation"
import { isDesktop } from "@/lib/transport"
import { isIosShell } from "@/lib/transport/detect"

/**
 * 页面里临时接管返回按钮的处理（#1335）：提交、推送、stash 在手机上进了详情时，
 * 标题栏的返回先回到列表，不离开这页。后挂上的优先；都卸掉了就照常离开。
 */
const backOverrides: Array<{ current: () => void }> = []
const overrideListeners = new Set<() => void>()

function notifyOverrides() {
  for (const listener of overrideListeners) listener()
}

function subscribeOverrides(listener: () => void) {
  overrideListeners.add(listener)
  return () => {
    overrideListeners.delete(listener)
  }
}

function currentOverride(): { current: () => void } | null {
  return backOverrides[backOverrides.length - 1] ?? null
}

/**
 * `handler` 不为 null 时，{@link MobileBackButton} 按下去调它，不离开这页；
 * 给 null 或卸载时还回去。
 */
export function useMobileBackOverride(handler: (() => void) | null): void {
  const handlerRef = useRef(handler)
  useLayoutEffect(() => {
    handlerRef.current = handler
  })
  const active = handler !== null
  useEffect(() => {
    if (!active) return
    const entry = { current: () => handlerRef.current?.() }
    backOverrides.push(entry)
    notifyOverrides()
    return () => {
      const index = backOverrides.indexOf(entry)
      if (index >= 0) backOverrides.splice(index, 1)
      notifyOverrides()
    }
  }, [active])
}

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
  const override = useSyncExternalStore(
    subscribeOverrides,
    currentOverride,
    () => null
  )
  if (isDesktop()) return null
  if (!isMobile && !isIosShell() && !wasOpenedInPage()) return null
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      aria-label={t("back")}
      title={t("back")}
      onClick={() => (override ? override.current() : leaveInPage())}
    >
      <ChevronLeft className="h-4 w-4" />
    </Button>
  )
}
