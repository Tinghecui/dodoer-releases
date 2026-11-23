"use client"

import { useLayoutEffect, useState, type RefObject } from "react"

import { useVisualViewport } from "@/hooks/use-visual-viewport"

/**
 * 从输入框往上弹的菜单的最大高度。
 *
 * 手机布局下工作区按键盘以上真正可见的高度排版（`--app-vvh`，由
 * useVisualViewport 写进根元素）；按整屏算（`dvh`）的话，键盘弹起时菜单
 * 会比可见区域还高，顶部跑出屏幕。没有这个变量时（桌面布局、浏览器不支持
 * visualViewport）退回 `100dvh`，结果和原来一样。
 */

/** `/` 命令菜单：最多 16rem，且不超过可见高度的 40%（原来是 40dvh）。 */
export const SLASH_MENU_MAX_HEIGHT_CLASS =
  "max-h-[min(16rem,calc(var(--app-vvh,100dvh)*0.4))]"

/**
 * Radix 弹出层（会话设置选择器）：Radix 算的可用高度和可见高度取小的那个。
 */
export const UPWARD_POPOVER_MAX_HEIGHT_CLASS =
  "max-h-[min(var(--radix-popover-content-available-height),var(--app-vvh,100dvh))]"

/**
 * Radix 下拉菜单（加号菜单、插话菜单）：同上，用下拉菜单自己的可用高度变量。
 * 会盖掉 DropdownMenuContent 默认的 `max-h-(--radix-dropdown-menu-content-available-height)`。
 */
export const UPWARD_DROPDOWN_MAX_HEIGHT_CLASS =
  "max-h-[min(var(--radix-dropdown-menu-content-available-height),var(--app-vvh,100dvh))]"

/** 菜单和可见区域顶边之间至少留这么多。 */
const TOP_MARGIN_PX = 8

/**
 * 锚点（输入框）顶边以上、可见区域以内还剩多少像素给菜单。
 *
 * `anchorTop` 和 `viewportTop` 都是布局视口坐标（getBoundingClientRect、
 * visualViewport.offsetTop）；`gap` 是菜单和锚点之间的间距。输入框变高、
 * 上面的内容占了地方时剩下的就少，不会小于 0。
 */
export function roomAbovePx(
  anchorTop: number,
  viewportTop: number,
  gap: number
): number {
  return Math.max(0, Math.floor(anchorTop - viewportTop - gap - TOP_MARGIN_PX))
}

/**
 * 菜单打开期间跟踪锚点上方的可见空间（像素），没打开时为 null。
 *
 * 只靠 CSS 的 `--app-vvh` 只知道可见区域多高，不知道输入框占了多少；这里量
 * 锚点的实际位置，键盘开合（visualViewport 的 resize / scroll）、窗口变化、
 * 输入框变高（ResizeObserver）时重量。
 *
 * 视口变化时工作区根容器的 `--app-vvh` 要等 useVisualViewport 在下一帧写进去，
 * 事件当时量到的还是旧布局下输入框的位置；之后根容器变矮、输入框整体上移，
 * 输入框自己的尺寸没变，ResizeObserver 不会再触发。所以事件里除了当场量一次，
 * 还排到下一帧再量（排在 useVisualViewport 那一帧之后）；可见区域的快照变了
 * （包括键盘开合时底部状态栏被去掉、React 重排之后）也重量一次。
 */
export function useRoomAbove(
  anchorRef: RefObject<HTMLElement | null>,
  active: boolean,
  gap: number
): number | null {
  const [room, setRoom] = useState<number | null>(null)
  const {
    height: vvHeight,
    offsetTop: vvTop,
    keyboardOpen,
  } = useVisualViewport(active)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!active || !anchor) return
    const vv = window.visualViewport ?? null
    const update = () => {
      const top = anchor.getBoundingClientRect().top
      setRoom(roomAbovePx(top, vv?.offsetTop ?? 0, gap))
    }
    let raf = 0
    const onViewportChange = () => {
      update()
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        update()
      })
    }
    update()
    vv?.addEventListener("resize", onViewportChange)
    vv?.addEventListener("scroll", onViewportChange)
    window.addEventListener("resize", onViewportChange)
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null
    observer?.observe(anchor)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      vv?.removeEventListener("resize", onViewportChange)
      vv?.removeEventListener("scroll", onViewportChange)
      window.removeEventListener("resize", onViewportChange)
      observer?.disconnect()
    }
  }, [anchorRef, active, gap, vvHeight, vvTop, keyboardOpen])

  // 关着时不用旧的量值；下次打开时 effect 会先重量一次。
  return active ? room : null
}
