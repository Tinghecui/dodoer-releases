"use client"

import { useCallback, useEffect } from "react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { subscribe } from "@/lib/platform"
import { FOLDER_OPEN_IN_WORKSPACE_EVENT } from "@/lib/api"
import { takePendingWorkspaceFolder } from "@/lib/in-page-navigation"
import type { FolderDetail } from "@/lib/types"

/**
 * Surfaces folders opened from the project launcher (a separate window/tab).
 * The launcher scaffolds a project; the backend upserts the folder and emits
 * `folder://open-in-workspace`. Here we add it to this workspace and open a
 * draft conversation tab so it lands focused.
 *
 * Routing is handled by the transport: `subscribe()` binds to this window's
 * own backend (the local Tauri bus, or the server's WebSocket for web/remote),
 * so only windows talking to the backend that opened the folder react — no
 * manual connection filtering needed. The detail rides on the event, so no
 * extra round-trip is required to apply it.
 */
export function WorkspaceOpenFolderListener() {
  const { openNewConversationTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()

  // 标签和项目列表恢复完之前不能开新标签：标签恢复会用存着的标签整个盖掉
  // 当前列表，TabProvider 接着还会切回上次停的项目，先开的会话和焦点就丢了。
  // 不刷新、在当前页回到工作区时 tabsHydrated 早就是 true，但工作区重新挂上
  // 又读了一遍标签（tabsRestoring），同样要等它读完。
  const tabsHydrated = useTabStore((s) => s.tabsHydrated)
  const tabsRestoring = useTabStore((s) => s.tabsRestoring)
  const foldersHydrated = useAppWorkspaceStore((s) => s.foldersHydrated)

  const openFolder = useCallback(
    (detail: FolderDetail) => {
      const store = useAppWorkspaceStore.getState()
      store.upsertFolder(detail)
      store.setBranch(detail.id, detail.git_branch ?? null)
      // Return to the conversation workspace if a route (e.g. Automations)
      // was covering the content region, else the new tab opens unseen.
      openConversations()
      openNewConversationTab(detail.id, detail.path)
      void store.refreshConversations()
    },
    [openNewConversationTab, openConversations]
  )

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<FolderDetail>(
        FOLDER_OPEN_IN_WORKSPACE_EVENT,
        openFolder
      )
      // The effect may have torn down while the async subscribe was in
      // flight; dispose immediately so we don't leak a subscription.
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [openFolder])

  // 手机上新建项目页是在当前页里打开的（#1332），建好时这里没挂着、错过了
  // 广播；那边把文件夹记下了，回来时接着打开。要等标签和项目都恢复完；再推
  // 一拍，让 TabProvider 同一轮里的事先做完（它是外层，effect 比这里晚跑：
  // 恢复上次停的项目、重新挂上时开始读标签）；那一拍里再看一眼是不是又在读。
  // 到时候才取走，中途卸下不会把它弄丢。
  useEffect(() => {
    if (!tabsHydrated || tabsRestoring || !foldersHydrated) return
    const timer = setTimeout(() => {
      if (useTabStore.getState().tabsRestoring) return
      const pending = takePendingWorkspaceFolder()
      if (pending) openFolder(pending)
    }, 0)
    return () => clearTimeout(timer)
  }, [tabsHydrated, tabsRestoring, foldersHydrated, openFolder])

  return null
}
