"use client"

import { useMediaQuery } from "./use-media-query"

/**
 * 手机布局：宽度 767px 以下，或者粗指针（手指）且高度 500px 以下——后一条是
 * iPhone 横屏，宽度够了但屏幕很矮，桌面外壳摆不下。有鼠标的矮窗口、平板横屏
 * 仍走桌面布局。
 */
const MOBILE_BREAKPOINT =
  "(max-width: 767px), (pointer: coarse) and (max-height: 500px)"

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_BREAKPOINT)
}
