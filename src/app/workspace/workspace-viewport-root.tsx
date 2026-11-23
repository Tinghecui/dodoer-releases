"use client"

import type { ReactNode } from "react"

import { useVisualViewport } from "@/hooks/use-visual-viewport"
import { cn } from "@/lib/utils"

/**
 * 工作区根容器。
 *
 * 高度按键盘以上真正可见的区域排版（`--app-vvh`，由 useVisualViewport 写入），
 * 顶部跟着可见区域的偏移（iOS 键盘弹起时会把页面往上推，固定定位的元素是按
 * 布局视口摆的，不跟着偏移就会把标题栏推出屏幕）。没有变量时（桌面、浏览器
 * 不支持 visualViewport）退回 `100dvh` / 顶部 0，和原来的 `fixed inset-0` 一样。
 * 仍是 fixed：保留它建立的层叠上下文（背景图的 -z-10 靠它），也不让页面跟着
 * iOS 回弹滚动。
 *
 * 键盘弹起时底部安全区（home indicator）本来就被键盘盖住，去掉那块留白；
 * 手机布局的底部状态栏（`mobileFooter`）也收起来，把高度留给消息列表。
 */
export function WorkspaceViewportRoot({
  isMobile,
  mobileFooter,
  children,
}: {
  isMobile: boolean
  /** 只在手机布局、键盘收起时渲染，放在 children 之后。 */
  mobileFooter?: ReactNode
  children: ReactNode
}) {
  const { keyboardOpen } = useVisualViewport(isMobile)
  return (
    <div
      data-keyboard-open={keyboardOpen || undefined}
      className={cn(
        "fixed inset-x-0 top-[var(--app-vv-top,0px)] h-[var(--app-vvh,100dvh)] flex flex-col overflow-hidden bg-background text-foreground pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]",
        !keyboardOpen && "pb-[env(safe-area-inset-bottom)]"
      )}
    >
      {children}
      {isMobile && !keyboardOpen && mobileFooter}
    </div>
  )
}
