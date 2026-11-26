"use client"

import { StatusBarStats } from "@/components/layout/status-bar-stats"
import { StatusBarTasks } from "@/components/layout/status-bar-tasks"
import { StatusBarAlerts } from "@/components/layout/status-bar-alerts"
import { StatusBarMcp } from "@/components/layout/status-bar-mcp"
import { StatusBarComputer } from "@/components/layout/status-bar-computer"
import { StatusBarChrome } from "@/components/layout/status-bar-chrome"
import { StatusBarUpdate } from "@/components/layout/status-bar-update"
import { StatusBarWebService } from "@/components/layout/status-bar-web-service"
import { CommandDropdown } from "@/components/layout/command-dropdown"
import { QuickActionsDropdown } from "@/components/layout/quick-actions-dropdown"
import { Ellipsis } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { CoworkAccountMenu } from "@/components/cowork/account-menu"
import { StatusBarDevices } from "@/components/cowork/status-bar-devices"
import { StatusBarHostSsh } from "@/components/cowork/status-bar-host-ssh"
import { ResourceMeter } from "@/components/cowork/resource-meter"

/**
 * 手机布局的状态栏（#1334）：一行装不下十来项，390px 宽时会被截断。所以这一行
 * 只直接放「提醒类」的项和账户，其余收进左边的「更多」。
 *
 * 提醒类 = 按钮本身会变红或变黄、不点开也要看得到的项：借出电脑（出问题时琥珀色）、
 * Chrome（等待连接时琥珀色、暂停网站时琥珀点）、MCP 服务（停了红、不可用黄）、
 * 提醒铃（按最坏的一条红或黄）、资源表（吃紧黄、告急红）。其余的（快捷操作、
 * 工作区统计、更新、命令、网页服务、设备）只在弹层里才有颜色，收进「更多」。
 */
function MobileStatusBar() {
  const t = useTranslations("Folder.statusBar")
  return (
    <div
      data-testid="status-bar-mobile"
      className="h-8 min-w-0 shrink-0 overflow-hidden border-t border-border ws-chrome-border ws-surface-muted px-3 flex items-center justify-between gap-3 text-xs text-muted-foreground"
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("more")}
            title={t("more")}
            className="shrink-0 hover:text-foreground"
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-auto max-w-[calc(100vw-1.5rem)] p-2"
        >
          {/* 每一项还是原来那个按钮，点了照旧打开它自己的弹层。 */}
          <div
            data-testid="status-bar-more"
            className="flex min-w-0 flex-wrap items-center gap-3 text-xs text-muted-foreground"
          >
            <QuickActionsDropdown />
            <StatusBarStats />
            <StatusBarUpdate />
            <CommandDropdown />
            {/* Narrow is a viewport width, not a browser: a desktop window
                shrunk below the breakpoint must still say the web service is
                listening. Renders nothing outside the local desktop. */}
            <StatusBarWebService />
            <StatusBarDevices />
          </div>
        </PopoverContent>
      </Popover>
      <div
        data-testid="status-bar-direct"
        className="flex shrink-0 items-center gap-3"
      >
        <StatusBarHostSsh />
        <StatusBarChrome />
        <StatusBarMcp />
        <StatusBarAlerts />
        <ResourceMeter />
        <CoworkAccountMenu />
      </div>
    </div>
  )
}

export function StatusBar() {
  const isMobile = useIsMobile()

  if (isMobile) return <MobileStatusBar />

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
 *
 * Cowork: the resource meter and the portal account menu end it, pushed to
 * the sidebar foot's far end. The foot (or, with the sidebar collapsed, the
 * bottom-left capsule) is always on screen, and it is where the workspace's
 * name already sits — the meter says how that machine is doing.
 *
 * The lent-computer item leads that group for the same reasons: lending is
 * to the server named right there, and a lent computer must show without
 * opening anything. The right half is behind the top-right status button on
 * desktop widths, where nobody sees a mark until they look for it.
 *
 * The person's own Chrome follows it, for the same reason: its glyph's
 * colour is the connection's state, which is no use behind a button.
 *
 * Then the person's devices (Cowork, `docs/devices.md`): there once some
 * computer has connected to this workspace.
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
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <StatusBarHostSsh className="h-6 rounded-full px-1.5 hover:bg-[var(--g-hover)]" />
        <StatusBarChrome className="h-6 rounded-full px-1.5 hover:bg-[var(--g-hover)]" />
        <StatusBarDevices className="h-6 rounded-full px-1.5 hover:bg-[var(--g-hover)]" />
        <ResourceMeter />
        <CoworkAccountMenu
          className="shrink-0 rounded-full hover:bg-[var(--g-hover)]"
          side="top"
        />
      </div>
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
      {/* Cowork: the command launcher lives in the terminal strip on desktop
          (CommandDropdown's "terminal" variant); the mobile bar keeps it. */}
      {/* Computer use: which windows agents may see right now. Renders
          nothing unless the desktop runtime has it switched on. */}
      <StatusBarComputer />
      {/* The person's own Chrome is in StatusBarLeft on desktop widths, its
          state always on screen. */}
      {/* Web service (remote access): whether the desktop is reachable over
          HTTP right now, and how far. Beside computer use because both say
          what is exposed. Local desktop only. */}
      <StatusBarWebService />
      {/* Cowork: the lent-computer item is in StatusBarLeft on desktop
          widths, always on screen. */}
      {/* codeg-mcp service health, next to the alerts bell: both answer "is
          something wrong right now?". */}
      <StatusBarMcp />
      <StatusBarAlerts />
      {/* Cowork's account menu ends StatusBarLeft on desktop widths. */}
    </div>
  )
}
