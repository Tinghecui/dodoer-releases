"use client"

import { isDesktop } from "@/lib/transport"
import { useIsMobile } from "./use-mobile"

/**
 * 要不要藏起只在电脑上有用的设置项和页面入口（快捷键、本机电脑操控、合并
 * 编辑器、画布、宠物、导入会话这些，#1335）：手机布局，而且不是桌面版。
 * 桌面版的窗口再窄也是在电脑上，照常显示（「不改桌面布局」）。
 */
export function useHideDesktopOnly(): boolean {
  const isMobile = useIsMobile()
  return isMobile && !isDesktop()
}
