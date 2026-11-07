"use client"

import { StatusBarStats } from "@/components/layout/status-bar-stats"
import { StatusBarTasks } from "@/components/layout/status-bar-tasks"
import { StatusBarAlerts } from "@/components/layout/status-bar-alerts"
import { StatusBarMcp } from "@/components/layout/status-bar-mcp"
import { StatusBarComputer } from "@/components/layout/status-bar-computer"
import { StatusBarUpdate } from "@/components/layout/status-bar-update"
import { CommandDropdown } from "@/components/layout/command-dropdown"
import { QuickActionsDropdown } from "@/components/layout/quick-actions-dropdown"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { CoworkAccountMenu } from "@/components/cowork/account-menu"

export function StatusBar() {
  const isMobile = useIsMobile()

  if (isMobile) {
    // Mobile mirrors the desktop bar: workspace stats on the left, the command
    // launcher + alerts on the right. `h-8` (matching desktop) gives the h-6
    // command control room. The branch selector and context-window circle live
    // in the below-composer row, so those are the bar's only two clusters.
    return (
      <div className="h-8 shrink-0 border-t border-border ws-chrome-border ws-surface-muted px-3 flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <QuickActionsDropdown />
          <StatusBarStats />
        </div>
        <div className="flex items-center gap-3">
          <StatusBarUpdate />
          <CommandDropdown />
          <StatusBarMcp />
          <StatusBarAlerts />
          <CoworkAccountMenu />
        </div>
      </div>
    )
  }

  // Desktop has no full-width status bar any more (Liquid Glass, handoff
  // 6.2): the bottom edge is left to the floating composer. Its left half
  // (StatusBarLeft) sits at the foot of the sidebar pane and its right half
  // (StatusBarRight) at the foot of the aux panel; whichever panel is
  // collapsed, its half becomes a small glass capsule in that bottom corner
  // (FolderLayoutShell).
  return null
}

/**
 * Left half of the status bar: the quick-actions launcher and the workspace
 * stats. The launcher keeps the same glyph and size as before.
 */
export function StatusBarLeft({ className }: { className?: string }) {
  return (
    <div
      data-status-bar-left=""
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground",
        className
      )}
    >
      <QuickActionsDropdown />
      <StatusBarStats />
    </div>
  )
}

/**
 * Right half of the status bar: update, background tasks, command launcher,
 * computer use, MCP and alerts. Update, tasks and computer use render only
 * when there is something to show, exactly as before.
 */
export function StatusBarRight({ className }: { className?: string }) {
  return (
    <div
      data-status-bar-right=""
      className={cn(
        "flex items-center gap-3 text-xs text-muted-foreground",
        className
      )}
    >
      <StatusBarUpdate />
      <StatusBarTasks />
      {/* Command launcher (moved from the aux "session details" tab). */}
      <CommandDropdown />
      {/* Computer use: which windows agents may see right now. Renders
          nothing unless the desktop runtime has it switched on. */}
      <StatusBarComputer />
      {/* codeg-mcp service health, next to the alerts bell: both answer "is
          something wrong right now?". */}
      <StatusBarMcp />
      <StatusBarAlerts />
      {/* Cowork's account menu lives in RightEdgeChrome on desktop widths. */}
    </div>
  )
}
