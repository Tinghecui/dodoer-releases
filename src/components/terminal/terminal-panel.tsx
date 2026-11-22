"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import { TerminalTabBar } from "./terminal-tab-bar"
import { TerminalView } from "./terminal-view"

const KEYBAR_COLLAPSED_STORAGE_KEY = "codeg:term-keybar"

/**
 * 终端面板：顶栏（tab + 折叠键栏开关）+ 所有挂载的 xterm。
 *
 * 移动端键栏的可见性在面板层决定：
 *   · `useIsMobile()` —— 必须与 workspace layout 挑选移动端外壳用的是同一个
 *     判据，否则会在断点边界上出现「桌面外壳里冒出移动端键栏」；
 *   · 折叠态持久化到 localStorage，避免多个终端 tab 各自记一份导致切 tab
 *     后展开/折叠不一致。
 */
export function TerminalPanel() {
  const {
    isOpen,
    tabs,
    visibleTabs,
    activeTabId,
    createTerminal,
    canCreateTerminal,
    markTerminalExited,
    markTerminalRunning,
    markTerminalStarted,
  } = useTerminalContext()
  const t = useTranslations("Folder.terminal")
  const isMobile = useIsMobile()
  // 别的项目的终端也一直挂着（不能把它们的 shell 断掉），只是不显示（#787）。
  const visibleIds = useMemo(
    () => new Set(visibleTabs.map((tab) => tab.id)),
    [visibleTabs]
  )

  const [keybarCollapsed, setKeybarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false
    try {
      return window.localStorage.getItem(KEYBAR_COLLAPSED_STORAGE_KEY) === "1"
    } catch {
      return false
    }
  })

  // SSR / 初次客户端渲染时 window.matchMedia 默认 matches=false（test-setup.ts
  // 的 polyfill），桌面态 hydration 一致后 useMediaQuery 才返回真实值。
  // localStorage 在 SSR 也是 undefined，所以初次 client render 与 SSR 都
  // 是「未折叠」——只有用户主动折叠过才改。
  useEffect(() => {
    try {
      window.localStorage.setItem(
        KEYBAR_COLLAPSED_STORAGE_KEY,
        keybarCollapsed ? "1" : "0"
      )
    } catch {
      // best effort（隐私模式 / 配额超限时静默放弃）
    }
  }, [keybarCollapsed])

  const toggleKeybar = useCallback(() => {
    setKeybarCollapsed((prev) => !prev)
  }, [])

  const keybarVisible = isMobile && !keybarCollapsed

  return (
    <section
      data-terminal-panel-region="true"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden ws-surface"
    >
      <TerminalTabBar
        showKeybarToggle={isMobile}
        keybarCollapsed={keybarCollapsed}
        onToggleKeybar={toggleKeybar}
      />
      <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
        {tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            terminalId={tab.id}
            workingDir={tab.workingDir}
            shell={tab.shell}
            initialCommand={tab.initialCommand}
            attach
            spawnOnMissing={!tab.restored}
            reuseCompleted
            onSpawned={markTerminalStarted}
            onProcessRestored={markTerminalRunning}
            isActive={tab.id === activeTabId && visibleIds.has(tab.id)}
            isVisible={isOpen}
            keybarVisible={keybarVisible}
            onProcessExited={markTerminalExited}
          />
        ))}
        {/* 没有当前项目时建不了终端，不显示一个点了没反应的按钮。 */}
        {visibleTabs.length === 0 && canCreateTerminal && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>{t("emptyForFolder")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void createTerminal()}
            >
              <Plus className="h-3 w-3" aria-hidden />
              {t("newTerminal")}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
