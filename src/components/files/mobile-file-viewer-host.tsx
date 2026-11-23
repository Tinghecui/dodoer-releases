"use client"

/**
 * 整个工作区共用的文件查看抽屉（#1335）。
 *
 * 手机布局下不开桌面那个多标签编辑区，看文件一律用抽屉。会话里点的文件由会话自己的
 * `SessionViewerHost` 弹抽屉；会话以外的入口（侧面板的文件树、Git 改动和提交记录、
 * 搜索、后台任务的输出）没有那个宿主，就交给这里：挂在工作区最外层，哪里都够得着。
 *
 * 只管文件，不管会话查看器：会话以外的入口只会打开文件。电脑上这里永远不会被调用
 * （`useOpenFilePreviewTarget` 只在手机布局下才转过来），所以挂着也不碍事。
 */

import * as React from "react"

import { FileViewerDrawer } from "@/components/files/file-viewer-drawer"
import {
  MobileFileViewerHostContext,
  type MobileFileViewerHostValue,
} from "@/components/files/mobile-file-viewer-host-context"
import type { FileViewerRequest } from "@/components/message/session-viewer-host-context"

export function MobileFileViewerHost({
  children,
}: {
  children: React.ReactNode
}) {
  const [request, setRequest] = React.useState<FileViewerRequest | null>(null)
  const [open, setOpen] = React.useState(false)

  const value = React.useMemo<MobileFileViewerHostValue>(
    () => ({
      open: (next) => {
        setRequest(next)
        setOpen(true)
      },
    }),
    []
  )

  // 关的时候只放下开关，请求留着给抽屉的退场动画画内容（和 SessionViewerHost 一样）。
  return (
    <MobileFileViewerHostContext.Provider value={value}>
      {children}
      {request && (
        <FileViewerDrawer
          request={request}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </MobileFileViewerHostContext.Provider>
  )
}
