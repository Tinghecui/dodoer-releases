"use client"

import { useCallback } from "react"

import { useMobileFileViewerHost } from "@/components/files/mobile-file-viewer-host-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { isDesktop } from "@/lib/transport"

/**
 * 会话以外的「打开文件」入口用的（文件树、Git 改动和提交记录、搜索、后台任务输出）。
 *
 * 电脑上（包括桌面版窗口拉窄）照旧 `openFilePreview`，开在文件栏的标签里。
 * 手机布局（不是桌面版）下交给工作区的文件抽屉（#1335），不去开手机上那个多标签
 * 编辑区；工作区以外没挂抽屉宿主时退回 `openFilePreview`。
 */
export function useOpenFilePreviewTarget() {
  const { openFilePreview } = useWorkspaceActions()
  const host = useMobileFileViewerHost()
  const isMobile = useIsMobile()
  const useDrawer = isMobile && !isDesktop() && host != null

  return useCallback(
    async (
      path: string,
      options?: { line?: number; folderId?: number }
    ): Promise<void> => {
      if (useDrawer && host) {
        host.open({
          path,
          line: options?.line ?? null,
          folderId: options?.folderId,
        })
        return
      }
      if (options) await openFilePreview(path, options)
      else await openFilePreview(path)
    },
    [host, openFilePreview, useDrawer]
  )
}
