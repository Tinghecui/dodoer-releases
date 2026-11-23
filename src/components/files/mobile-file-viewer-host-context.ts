"use client"

/**
 * 工作区文件抽屉（`mobile-file-viewer-host.tsx`）的接口，单独放一个叶子模块：
 * 只想「请它打开一个文件」的入口（文件树、搜索、后台任务）不用把抽屉和它背后的
 * 整套渲染一起拉进来。
 */

import { createContext, useContext } from "react"

import type { FileViewerRequest } from "@/components/message/session-viewer-host-context"

export interface MobileFileViewerHostValue {
  open: (request: FileViewerRequest) => void
}

export const MobileFileViewerHostContext =
  createContext<MobileFileViewerHostValue | null>(null)

/** 工作区的文件抽屉；工作区以外（没挂宿主）是 `null`。 */
export function useMobileFileViewerHost(): MobileFileViewerHostValue | null {
  return useContext(MobileFileViewerHostContext)
}
