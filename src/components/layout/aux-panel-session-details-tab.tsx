"use client"

import { useCallback, useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  useCoworkTeamStore,
  type SharedSessionInfo,
  type SharedSessionTarget,
} from "@/stores/cowork-team-store"
import type { TeamSessionState } from "@/lib/cowork/team"
import { formatTimeAgo } from "@/lib/relative-time"
import {
  projectRuntimeSessionDetails,
  resolveActiveSessionDetailsFromSnapshot,
} from "@/components/conversations/active-session-details"
import { SessionDetailsCard } from "@/components/conversations/session-details-content"
import { MessageNavScrollContext } from "@/components/message/message-nav-scroll-context"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { SessionDetailsInsights } from "./session-details-insights"

/**
 * The aux-panel "Session Details" tab. Shows the active conversation's identity
 * and identifiers as a card (`SessionDetailsCard`; the dialog is the full view,
 * with token usage and timestamps), then what its transcript knows: the
 * agent's plan and the message navigator, whose messages carry their
 * sub-agents and changed files (`SessionDetailsInsights`). The branch selector
 * + command launcher that used to sit atop this tab now live in the bottom
 * status bar on both platforms.
 *
 * Details are resolved from live runtime state exactly the way the conversation
 * detail panel does it (`resolveActiveSessionDetails`), so no network fetch is
 * needed for the focused session.
 */
export function SessionDetailsTab() {
  const t = useTranslations("Folder.sessionDetails")
  // 主区域盖着只读分享视图时（#1457、#1515），下面自己的会话还是活动标签；
  // 这里只认活动标签，接着画会把自己的会话当成正在看的那条。改成画分享会话
  // 本身的卡片，关掉视图后自动回到原样。
  const viewing = useCoworkTeamStore((s) => (s.available ? s.viewing : null))
  const viewingInfo = useCoworkTeamStore((s) => s.viewingInfo)
  const { isOpen, activeTab } = useAuxPanelContext()
  const active = isOpen && activeTab === "session_details"

  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeConversationTab = useMemo(
    () =>
      tabs.find(
        (tab) => tab.id === activeTabId && tab.conversationId != null
      ) ?? null,
    [tabs, activeTabId]
  )

  // A brand-new conversation streams under its virtual `runtimeConversationId`
  // until it reconciles; key the live-session lookup on it first (mirrors the
  // detail panel, exercised by active-session-details.test.ts). It is also the
  // key the conversation's transcript publishes its insights under.
  const activeRuntimeId =
    activeConversationTab?.runtimeConversationId ??
    activeConversationTab?.conversationId ??
    null
  // Keep transcript payloads out of both current and previous hook snapshots.
  // Shallow comparison still suppresses updates that change only message text.
  // Token usage isn't shown here, so its stats aren't read.
  const runtimeDetails = useConversationRuntimeStore(
    useShallow((s) => {
      const session =
        activeRuntimeId != null
          ? s.byConversationId.get(activeRuntimeId)
          : undefined
      const { summary, model } = projectRuntimeSessionDetails(session)
      return { summary, stats: null, model }
    })
  )
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  // The tab scrolls as one, and the message navigator renders only the rows
  // in view of that scroll: it needs the real scroll container, which
  // OverlayScrollbars hands over once it has initialized.
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback(
    (element: HTMLElement | null) => setViewport(element),
    []
  )
  const { summary, model } = resolveActiveSessionDetailsFromSnapshot(
    activeConversationTab,
    runtimeDetails,
    conversations
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {viewing ? (
        <SharedSessionDetails
          target={viewing}
          info={
            viewingInfo?.owner === viewing.owner &&
            viewingInfo.id === viewing.id
              ? viewingInfo
              : null
          }
        />
      ) : summary ? (
        <ScrollArea
          className="min-h-0 flex-1"
          onViewportRef={handleViewportRef}
        >
          <MessageNavScrollContext.Provider value={viewport}>
            {/* The cards are as far apart as they are from the panel's
                sides. */}
            <div className="min-w-0 space-y-3 p-3 text-sm">
              <SessionDetailsCard summary={summary} model={model} />
              <SessionDetailsInsights
                conversationId={activeRuntimeId}
                active={active}
              />
            </div>
          </MessageNavScrollContext.Provider>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("noActiveSession")}
        </div>
      )}
    </div>
  )
}

const SHARED_STATE_KEYS = {
  running: "stateRunning",
  waiting: "stateWaiting",
  done: "stateDone",
} as const satisfies Record<TeamSessionState, string>

/**
 * 只读分享视图开着时的卡片（#1515）：只画服务端给的几项（标题、主人、怎么
 * 看到的、状态、最后更新）。计划、消息导航这些只有本机的会话才有，不画。
 */
function SharedSessionDetails({
  target,
  info,
}: {
  target: SharedSessionTarget
  info: SharedSessionInfo | null
}) {
  const t = useTranslations("CoworkTeam")
  const locale = useLocale()
  const agent = info?.agent ?? null
  const gone = info !== null && agent === null
  const ownerLabel = agent?.ownerLabel || target.ownerLabel || target.owner
  const title = agent?.title || target.title || t("untitled")
  const via =
    target.via.kind === "leader"
      ? t("sharedViewViaLeader", { group: target.via.groupName })
      : t("sharedViewViaShared", { owner: ownerLabel })
  const updatedAt = agent ? Date.parse(agent.updatedAt) : NaN
  const rows: Array<[string, string]> = [
    [t("sharedDetailsOwner"), ownerLabel],
    [t("sharedDetailsAccess"), via],
  ]
  if (gone) rows.push([t("sharedDetailsStatus"), t("sharedViewGone")])
  else if (!agent) rows.push([t("sharedDetailsStatus"), t("sharedViewLoading")])
  else {
    rows.push([t("sharedDetailsStatus"), t(SHARED_STATE_KEYS[agent.state])])
    if (Number.isFinite(updatedAt) && info)
      rows.push([
        t("sharedDetailsUpdated"),
        formatTimeAgo(updatedAt, info.fetchedAt, locale),
      ])
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
      <section
        data-shared-session-details=""
        className="min-w-0 space-y-2 rounded-lg border border-border p-3"
      >
        <div className="min-w-0">
          <h3 className="break-words font-medium">{title}</h3>
          <p className="text-[0.75rem] text-muted-foreground">
            {t("sharedViewReadOnly")}
          </p>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.8125rem]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[0.75rem] text-muted-foreground">
          {t("sharedViewSessionDetails")}
        </p>
      </section>
    </div>
  )
}
