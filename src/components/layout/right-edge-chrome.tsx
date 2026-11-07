"use client"

import { useCallback, useLayoutEffect, useRef } from "react"
import { PanelRight, Settings, SquareTerminal } from "lucide-react"
import { useTranslations } from "next-intl"
import { openSettingsWindow } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { FilePanelToggle } from "@/components/files/file-panel-toggle"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { WorkbenchRouteChromeActions } from "@/components/workbench/workbench-content"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { GLASS_RAISED_CARD_CLASS, Glass } from "@/components/ui/glass"
import { RightChromeSlot } from "@/components/layout/right-chrome-slot"
import { StatusIndicator } from "@/components/cowork/status-indicator"
import { useRightStatusCapsuleStore } from "@/stores/right-status-capsule-store"
import { cn } from "@/lib/utils"

/**
 * Contents of the window's fixed top-RIGHT chrome overlay: terminal + aux-panel
 * toggles (conversations) or the active route's own page-level controls
 * (full-page routes), then settings. `FolderLayoutShell` pins this at the
 * window's top-right
 * corner (to the LEFT of the Windows/Linux caption buttons) so it never moves —
 * or re-mounts — when the aux panel opens or closes. Preserves the old title
 * bar's disabled predicates and active styling. A leading drag filler right-
 * aligns the cluster and lets its empty space move the window; the fixed width
 * matches the right-edge column's reservation (see `rightChromeReserve`).
 */
export function RightEdgeChrome() {
  const tTitleBar = useTranslations("Folder.folderTitleBar")
  const { activeFolder } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  // Full-page workbench routes (tasks / automations) overlay the workspace the
  // terminal and aux panel live in — toggling them there is invisible, so the
  // two buttons hide and the route's own page-level controls take their slots
  // (WorkbenchRouteChromeActions below). The way OUT of such a route is the
  // breadcrumb button at the head of its title (see WorkbenchPageTitle), not
  // this corner.
  const { isConversations } = useWorkbenchRoute()
  const { isOpen: auxPanelOpen, toggle: toggleAuxPanel } = useAuxPanelContext()
  const { isOpen: terminalOpen, toggle: toggleTerminal } = useTerminalContext()
  const isMac = useIsMac()
  const { shortcuts } = useShortcutSettings()

  const handleOpenSettings = useCallback(() => {
    openSettingsWindow().catch((err) => {
      console.error("[RightEdgeChrome] failed to open settings:", err)
    })
  }, [])

  const asCapsule = !(isConversations && auxPanelOpen)
  const btn = cn(
    "lg-ib shrink-0 rounded-full text-[var(--ink2)] hover:bg-[var(--g-hover)] hover:text-foreground dark:hover:bg-[var(--g-hover)]",
    asCapsule ? "mx-[0.1875rem] h-7 w-[1.875rem]" : "h-7 w-7"
  )
  const on = "bg-[var(--g-sel)] text-foreground"

  const cluster = (
    <>
      {isConversations && (
        <>
          <FilePanelToggle
            className={btn}
            iconClassName="h-[0.9375rem] w-[0.9375rem]"
          />
          <Button
            variant="ghost"
            size="icon"
            className={cn(btn, terminalOpen && on)}
            onClick={() => toggleTerminal()}
            disabled={!activeFolder}
            title={tTitleBar("withShortcut", {
              label: tTitleBar("toggleTerminal"),
              shortcut: formatShortcutLabel(shortcuts.toggle_terminal, isMac),
            })}
          >
            <SquareTerminal className="h-[0.9375rem] w-[0.9375rem]" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(btn, auxPanelOpen && on)}
            onClick={toggleAuxPanel}
            disabled={!activeFolder && !isChatMode}
            title={tTitleBar("withShortcut", {
              label: tTitleBar("toggleAuxPanel"),
              shortcut: formatShortcutLabel(shortcuts.toggle_aux_panel, isMac),
            })}
          >
            <PanelRight className="h-[0.9375rem] w-[0.9375rem]" />
          </Button>
        </>
      )}
      <WorkbenchRouteChromeActions
        buttonClassName={btn}
        iconClassName="h-[0.9375rem] w-[0.9375rem]"
      />
      <Button
        variant="ghost"
        size="icon"
        className={btn}
        onClick={handleOpenSettings}
        title={tTitleBar("withShortcut", {
          label: tTitleBar("openSettings"),
          shortcut: formatShortcutLabel(shortcuts.open_settings, isMac),
        })}
      >
        <Settings className="h-[0.9375rem] w-[0.9375rem]" />
      </Button>
    </>
  )

  if (asCapsule) {
    // Aux panel collapsed (or a full-page route): one capsule at the top
    // bar's right end. jenny fork: it holds everything up there — the status
    // items (Cowork: folded into one button), the shown conversation's own
    // buttons (RightChromeSlot), then the window buttons — in the sidebar's
    // card look, centred on the traffic lights' line (15px down, like the left
    // capsule).
    return (
      <div className="flex h-[3.25rem] items-center justify-end pt-2.5 pr-3">
        <Glass
          interactive
          data-right-chrome-capsule=""
          className={cn(
            GLASS_RAISED_CARD_CLASS,
            "flex h-8 items-center rounded-full px-0"
          )}
        >
          <CapsuleLead />
          {cluster}
        </Glass>
      </div>
    )
  }

  // Aux panel open: the same buttons sit on the panel's header (plain icon
  // buttons — the panel is a card already). jenny fork: the card floats 8px
  // in from the window's top and right edges, so the row moves in with it.
  return (
    <div className="flex h-[3.375rem] items-center gap-px pt-2 pr-[1.125rem]">
      {cluster}
    </div>
  )
}

/**
 * jenny fork: the capsule's lead — the right half of the status bar, then the
 * conversation's slot. It reports its width so the strips beneath reserve room
 * for it on top of the window buttons' fixed reserve, and 0 once it unmounts.
 *
 * Cowork: the status half is one button (StatusIndicator) at every window
 * width, so the capsule stays narrow and the tab strip under it keeps its
 * tabs. It used to fold only below 1440px, which missed wide windows with a
 * narrow file column.
 */
function CapsuleLead() {
  const ref = useRef<HTMLDivElement>(null)
  const setWidth = useRightStatusCapsuleStore((s) => s.setWidth)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => setWidth(el.getBoundingClientRect().width)
    report()
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report)
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      setWidth(0)
    }
  }, [setWidth])
  return (
    <div
      ref={ref}
      data-status-capsule="right"
      className="flex h-full shrink-0 items-center pl-0.5"
    >
      <StatusIndicator className="lg-ib mx-[0.1875rem] h-7 w-[1.875rem] shrink-0 rounded-full text-[var(--ink2)] hover:bg-[var(--g-hover)] hover:text-foreground dark:hover:bg-[var(--g-hover)]" />
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--g-sep2)]" />
      <RightChromeSlot />
    </div>
  )
}
