"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Keyboard, Minus, Plus, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useIsMac } from "@/hooks/use-is-mac"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { handleMiddleClickClose } from "@/lib/utils"
import { terminalIsBusy } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { CommandDropdown } from "@/components/layout/command-dropdown"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** 等用户确认的关闭：哪些终端里还有程序在跑，确认了做什么（#1136）。 */
interface PendingClose {
  busyTitles: string[]
  /** 一次关好几个（「关闭其它」「关闭所有」）时列出忙的终端名。 */
  several: boolean
  close: () => void
}

interface TerminalTabBarProps {
  /** 移动端折叠/展开键栏的开关。仅 isMobile 时父级才传 true。 */
  showKeybarToggle?: boolean
  /** 当前是否已折叠（驱动键盘按钮的 active 高亮）。 */
  keybarCollapsed?: boolean
  /** 点击键盘按钮的回调。 */
  onToggleKeybar?: () => void
}

export function TerminalTabBar({
  showKeybarToggle = false,
  keybarCollapsed = false,
  onToggleKeybar,
}: TerminalTabBarProps) {
  const t = useTranslations("Folder.terminal")
  const ime = useImeGuard()
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()
  const {
    // 跟随开着时只列当前项目的和全局的终端（#787）。
    visibleTabs: tabs,
    activeTabId,
    switchTerminal,
    closeTerminal,
    closeOtherTerminals,
    closeAllTerminals,
    renameTerminal,
    createTerminal,
    toggle,
  } = useTerminalContext()
  const { activeFolderId } = useActiveFolder()
  const folders = useAppWorkspaceStore((s) => s.folders)

  const folderIndex = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of folders) map.set(f.id, f.name)
    return map
  }, [folders])

  const canCreateTerminal = activeFolderId != null

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)

  // 关终端会结束里面的程序：先问后端哪些终端还有程序在跑，有就弹确认，
  // 取消了什么都不动；都空闲、查不出来（Windows、终端已经不在）或者查询
  // 失败时照旧直接关（#1136）。
  const requestClose = useCallback(
    async (
      targets: { id: string; title: string }[],
      close: () => void,
      several = false
    ) => {
      const flags = await Promise.all(
        targets.map((target) =>
          terminalIsBusy(target.id).then(
            (busy) => busy === true,
            () => false
          )
        )
      )
      const busyTitles = targets
        .filter((_, index) => flags[index])
        .map((target) => target.title)
      if (busyTitles.length === 0) {
        close()
        return
      }
      setPendingClose({ busyTitles, several, close })
    },
    []
  )

  const requestCloseOne = (tab: { id: string; title: string }) =>
    void requestClose([tab], () => closeTerminal(tab.id))

  // 最新的标签：查询要等后端，等的时候可能又新建了终端。
  const latestTabsRef = useRef(tabs)
  useEffect(() => {
    latestTabsRef.current = tabs
  }, [tabs])

  // 「关闭其它」「关闭所有」只关查过的那几个：查询期间新建的终端没查过、
  // 也没列进确认，不能跟着一起关掉、结束里面的程序（#1136）。标签没变时
  // 照旧走整批关闭。
  const closeChecked = (
    checked: { id: string }[],
    keepId: string | null,
    closeBatch: () => void
  ) => {
    const ids = new Set(checked.map((target) => target.id))
    const latest = latestTabsRef.current
    if (latest.every((other) => other.id === keepId || ids.has(other.id))) {
      closeBatch()
      return
    }
    for (const other of latest) {
      if (ids.has(other.id)) closeTerminal(other.id)
    }
    if (keepId && latest.some((other) => other.id === keepId)) {
      switchTerminal(keepId)
    }
  }

  const requestCloseMany = (
    targets: { id: string; title: string }[],
    keepId: string | null,
    closeBatch: () => void
  ) =>
    void requestClose(
      targets,
      () => closeChecked(targets, keepId, closeBatch),
      true
    )

  const startRename = (id: string, title: string) => {
    setEditingId(id)
    setEditValue(title)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      renameTerminal(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="flex items-center h-8 bg-muted/50 border-b gap-0.5 px-1 shrink-0">
      {tabs.map((tab) => (
        <ContextMenu key={tab.id}>
          <ContextMenuTrigger asChild>
            <div
              className={`flex items-center gap-1 h-6 px-2 rounded-sm text-xs cursor-pointer select-none ${
                tab.id === activeTabId
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
              onClick={() => switchTerminal(tab.id)}
              onMouseDown={(event) => {
                if (editingId === tab.id) return
                handleMiddleClickClose(event, () => requestCloseOne(tab))
              }}
              title={`${folderIndex.get(tab.folderId) ?? String(tab.folderId)}  —  ${tab.title}`}
            >
              {editingId === tab.id ? (
                <input
                  ref={inputRef}
                  className="bg-transparent outline-none border border-primary/50 rounded px-0.5 w-20 text-xs"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  {...ime.props}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (ime.isComposing(e)) return
                    if (e.key === "Enter") commitRename()
                    if (e.key === "Escape") setEditingId(null)
                  }}
                />
              ) : (
                <span className="truncate max-w-[7.5rem]">{tab.title}</span>
              )}
              <button
                type="button"
                className="ml-1 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                // Cowork: an icon-only control needs its own name — every tab's
                // close button used to be an unnamed "button" to assistive tech.
                aria-label={t("closeTab", { title: tab.title })}
                onClick={(e) => {
                  e.stopPropagation()
                  requestCloseOne(tab)
                }}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => startRename(tab.id, tab.title)}>
              {t("rename")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => requestCloseOne(tab)}>
              {t("close")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                requestCloseMany(
                  tabs.filter((other) => other.id !== tab.id),
                  tab.id,
                  () => closeOtherTerminals(tab.id)
                )
              }
              disabled={tabs.length <= 1}
            >
              {t("closeOthers")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                requestCloseMany(tabs, null, () => closeAllTerminals())
              }
            >
              {t("closeAll")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => void createTerminal()}
                disabled={!canCreateTerminal}
                // Cowork: the icon-only "+" had no name at all (no label, no
                // title), so it could only be found by position.
                aria-label={t("newTerminal")}
              >
                <Plus className="h-3 w-3" aria-hidden />
              </Button>
            </span>
          </TooltipTrigger>
          {!canCreateTerminal && (
            <TooltipContent side="top">{t("openFolderFirst")}</TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      {/* Cowork: the folder's commands, run into terminal tabs like this one.
          Renders nothing without an active folder. */}
      <CommandDropdown variant="terminal" />
      {showKeybarToggle && onToggleKeybar && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 shrink-0 ${keybarCollapsed ? "" : "text-primary"}`}
                onClick={onToggleKeybar}
                aria-pressed={!keybarCollapsed}
                aria-label={
                  keybarCollapsed ? t("keybar.show") : t("keybar.hide")
                }
              >
                <Keyboard className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {keybarCollapsed ? t("keybar.show") : t("keybar.hide")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 ml-auto"
        onClick={toggle}
        title={t("hideTerminal", {
          shortcut: formatShortcutLabel(shortcuts.toggle_terminal, isMac),
        })}
      >
        <Minus className="h-3 w-3" />
      </Button>
      <AlertDialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClose(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("closeBusyTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("closeBusyBody")}
              {pendingClose?.several && (
                <>
                  <br />
                  {t("closeBusyList", {
                    titles: pendingClose.busyTitles.join(", "),
                  })}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("closeBusyCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                pendingClose?.close()
                setPendingClose(null)
              }}
            >
              {t("closeBusyConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
