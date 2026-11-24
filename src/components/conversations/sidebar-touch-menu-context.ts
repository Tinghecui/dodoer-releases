"use client"

import { createContext, useContext } from "react"

// #1455：侧栏里每一行（会话卡片、文件夹行、分组标题）的菜单在触屏上靠 Radix
// 的长按打开，松手后浏览器还会补发一次 click，落到行上被当成点按（会话被打开、
// 文件夹被收起，菜单跟着关）。列表外层在捕获阶段记着「这次触屏按下期间有菜单打开
// 了」，松手后吞掉那次 click；行内的菜单打开时调这里的回调告诉外层。
// 不在列表里用（没有 Provider）时是空操作。
const SidebarTouchMenuContext = createContext<() => void>(() => {})

export const SidebarTouchMenuProvider = SidebarTouchMenuContext.Provider

export function useNotifyTouchMenuOpened(): () => void {
  return useContext(SidebarTouchMenuContext)
}
