"use client"

import { useEffect, useRef } from "react"

import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"

// Single chokepoint that keeps the workbench route honest: opening or switching
// to a conversation from ANY entry point (sidebar, ⌘T, search, deep links, pet
// focus, branch switch, run history …) activates a tab, so leaving a non-default
// route whenever activeTabId changes covers every opener — present and future —
// without patching each call site. Re-selecting the ALREADY-active tab does not
// change activeTabId, so the interactive conversation pickers (sidebar list,
// search dialog, run history) also call openConversations() directly.
export function WorkbenchRouteConversationSync() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const { consumeRemoteActivation, consumeCloseActivation } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const prevRef = useRef(activeTabId)
  useEffect(() => {
    if (prevRef.current === activeTabId) return
    prevRef.current = activeTabId
    // A remote tab snapshot that mirrors another client's focus also changes
    // activeTabId. That's not a local conversation activation, so don't hijack
    // this window into the conversations route — doing so would unmount whatever
    // non-conversation view it's on (e.g. the Automations editor + unsaved
    // edits). Local activations leave the flag false and switch as before.
    // 两个一次性标记都要读掉，不能让短路留下一个没清的。
    const remote = consumeRemoteActivation()
    // Cowork（#1210）：关掉当前标签（比如在侧栏删掉正开着的会话）让焦点
    // 落到别的标签上，也不是用户打开了会话，用量页这类页面要留着。
    const closed = consumeCloseActivation()
    if (remote || closed) return
    openConversations()
  }, [
    activeTabId,
    openConversations,
    consumeRemoteActivation,
    consumeCloseActivation,
  ])
  return null
}
