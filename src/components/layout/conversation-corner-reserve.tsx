"use client"

import { ChromeReserve } from "@/components/layout/chrome-reserve"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useWorkspaceView } from "@/contexts/workspace-context"
import { useZoomLevel } from "@/hooks/use-appearance"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePlatform } from "@/hooks/use-platform"
import { isDesktop } from "@/lib/platform"
import { leftChromeReserve, rightChromeReserve } from "@/lib/window-chrome"
import { useRightStatusCapsuleWidth } from "@/stores/right-status-capsule-store"

/**
 * Corner reserve for the single conversation header:
 * left for LeftEdgeChrome while the
 * sidebar is collapsed (the conversation column then owns the window's left
 * edge), right for RightEdgeChrome while the column owns the right edge (aux
 * panel closed + conversation mode, or the column maximized over the file
 * column). Like that row, the reserve is mounted while its column holds the
 * corner — the right one only then; a mode switch or a maximize toggle snaps
 * the layout — and sized by the side panel over the corner, so a sidebar/aux
 * toggle slides it (ChromeReserve). Mobile shows the full-width FolderTitleBar
 * instead of corner overlays — no reserve. Self-subscribed so sidebar/aux/zoom
 * toggles re-render these slivers, not the whole panel.
 *
 * Cowork（#1401）：「分享给我」的只读视图盖在会话栏上，顶栏第一行同样落在这两个
 * 角下面，也用它留位置；那一行不是标签条，传 `line={false}` 不画底下的细线。
 */
export function ConversationCornerReserve({
  side,
  line = true,
}: {
  side: "left" | "right"
  line?: boolean
}) {
  const isMobile = useIsMobile()
  const { isOpen: sidebarOpen } = useSidebarContext()
  const { isOpen: auxOpen } = useAuxPanelContext()
  const { mode, conversationMaximized } = useWorkspaceView()
  const { isMac, isWindows, isLinux } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  const statusCapsuleWidth = useRightStatusCapsuleWidth()
  if (isMobile) return null
  const holdsRight = mode === "conversation" || conversationMaximized
  if (side === "right" && !holdsRight) return null
  // jenny fork: the left reserve ends where the overlay's buttons do, so the
  // folder crumb follows search at the header's own `pl-3` — one row with no
  // extra gap while the sidebar is collapsed.
  const width =
    side === "left"
      ? sidebarOpen
        ? 0
        : leftChromeReserve(isMac && isDesktop(), zoomLevel)
      : auxOpen
        ? 0
        : rightChromeReserve(isDesktop() && (isWindows || isLinux), zoomLevel) +
          statusCapsuleWidth
  return <ChromeReserve width={width} line={line} />
}
