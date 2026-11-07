"use client"

/**
 * jenny fork: the aux-panel "Jenny progress" tab — the record Jenny keeps for
 * the conversation on screen. A Jenny record is per agent session, keyed by
 * the same id dodoer stores as the conversation's `external_id`, so the tab
 * follows whichever conversation is active. Read-only.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ClipboardCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { LoopProgressPanel } from "@/components/loop/loop-progress-panel"
import { ProgressDetailBody } from "@/components/progress/progress-detail"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTabStore } from "@/contexts/tab-context"
import { getJennyProgress } from "@/lib/api"
import { isNotFoundError, toErrorMessage } from "@/lib/app-error"
import { onTransportReconnect } from "@/lib/platform"
import type { JennyProgressDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

/** Re-read while the tab shows: Jenny writes at the end of every turn. */
const POLL_MS = 20_000

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; detail: JennyProgressDetail }

/**
 * The agent session id of the active conversation, or null when none is open
 * or it has not started yet. A brand-new conversation learns its id from the
 * live session first (keyed by its virtual runtime id), the stored list later.
 */
function useActiveSessionId(): string | null {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tab = useMemo(
    () =>
      tabs.find((t) => t.id === activeTabId && t.conversationId != null) ??
      null,
    [tabs, activeTabId]
  )
  const runtimeId = tab?.runtimeConversationId ?? tab?.conversationId ?? null
  const liveId = useConversationRuntimeStore((s) =>
    runtimeId != null
      ? (s.byConversationId.get(runtimeId)?.detail?.summary?.external_id ??
        null)
      : null
  )
  const storedId = useAppWorkspaceStore((s) =>
    tab?.conversationId != null
      ? (s.conversations.find((c) => c.id === tab.conversationId)
          ?.external_id ?? null)
      : null
  )
  return liveId ?? storedId
}

/** The folder of the active tab when that tab is a Loop conversation. */
function useActiveLoopFolderId(): number | null {
  const conversationId = useTabStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.conversationId ?? null
  )
  return useAppWorkspaceStore((s) => {
    if (conversationId == null) return null
    const row = s.conversations.find((c) => c.id === conversationId)
    return row?.kind === "loop" ? row.folder_id : null
  })
}

export function JennyProgressAuxTab() {
  const loopFolderId = useActiveLoopFolderId()
  // A Loop keeps a record across its stages, not one per turn, so its
  // registration reads differently from a conversation's.
  return loopFolderId != null ? (
    <LoopProgressPanel folderId={loopFolderId} />
  ) : (
    <SessionProgress />
  )
}

function SessionProgress() {
  const t = useTranslations("JennyProgress")
  const tDetails = useTranslations("Folder.sessionDetails")
  const { isOpen, activeTab } = useAuxPanelContext()
  const active = isOpen && activeTab === "jenny_progress"
  const sessionId = useActiveSessionId()
  const [state, setState] = useState<{ id: string; load: Load } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (id: string) => {
    try {
      const detail = await getJennyProgress(id)
      setState({ id, load: { kind: "ready", detail } })
    } catch (e) {
      setState({
        id,
        load: isNotFoundError(e)
          ? { kind: "missing" }
          : { kind: "error", message: toErrorMessage(e) },
      })
    }
    setNow(Date.now())
  }, [])

  useEffect(() => {
    if (!active || !sessionId) return
    // The first read when the tab shows or the conversation changes; every
    // state write in `load` lands after its await, never during this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(sessionId)
    const refresh = () => void load(sessionId)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, POLL_MS)
    const unsubscribe = onTransportReconnect(refresh)
    return () => {
      window.clearInterval(timer)
      unsubscribe?.()
    }
  }, [active, sessionId, load])

  if (!sessionId) {
    return <Notice title={tDetails("noActiveSession")} />
  }

  // Only what was read for THIS conversation: a switch shows the skeleton,
  // never the previous conversation's record.
  const shown: Load = state?.id === sessionId ? state.load : { kind: "loading" }

  switch (shown.kind) {
    case "loading":
      return (
        <div className="space-y-2 p-4" aria-hidden="true">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
        </div>
      )
    case "missing":
      return <Notice title={t("noRecord")} hint={t("noRecordHint")} />
    case "error":
      return (
        <Notice
          title={t("loadFailed")}
          hint={shown.message}
          action={
            <Button
              size="sm"
              variant="outline"
              className="mt-3 h-7 rounded-full text-xs"
              onClick={() => void load(sessionId)}
            >
              {t("retry")}
            </Button>
          }
        />
      )
    case "ready":
      return (
        <ScrollArea className="h-full min-h-0">
          <div className="min-w-0 pb-3 pt-2" data-jenny-progress-tab="">
            <ProgressDetailBody detail={shown.detail} now={now} />
          </div>
        </ScrollArea>
      )
  }
}

function Notice({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center p-6 text-center">
      <ClipboardCheck
        className="mb-3 size-6 text-muted-foreground"
        aria-hidden
      />
      <p className="text-sm font-medium">{title}</p>
      {hint ? (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {action}
    </div>
  )
}
