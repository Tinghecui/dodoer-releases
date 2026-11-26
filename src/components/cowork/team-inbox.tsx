"use client"

// CoTeam 的收件箱（#1235 第 6 行）：侧栏顶部铃铛右边一个按钮，带未读数；
// 点开是一条流：新分享、我的会话上的新留言、对我留言的回复、被加入组的提示。
// 铃铛本身（按会话动态排序的开关）不动。
//
// 未读数 = 新分享数 + 未读留言数 + 未处理的进组提示数，全部来自 `summary`。
// 留言、回复、进组提示的条目直接用 `summary` 里的；新分享的说明和标题要从
// `shared` 拿：只在收件箱打开时拉，开着期间每来一次新的 `summary` 再拉（不自己
// 另起轮询）。团队功能不可用时按钮不画，什么请求都不发。
//
// 点一条：分享 → 主区域只读打开并调 `shared_seen`；自己会话的留言 → 切到那个
// 会话、打开留言栏并调 `comments_seen`；别人会话里的回复 → 只读打开那个会话并调
// `comments_seen`。每条可以单独标已读，也可以全部标已读；进组提示是「知道了」，
// 调 `group_notice_dismiss`。标完先在本地把 `summary` 的数字减掉，下一次轮询
// 再以服务端为准。别人写的字（名字、标题、说明）一律按纯文字画。

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, CheckCheck, Inbox } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { formatBadgeCount } from "@/components/conversations/sidebar-unread-badge"
import {
  TEAM_SIGNED_OUT_CODE,
  teamCommentsSeen,
  teamGroupNoticeDismiss,
  teamShared,
  teamSharedSeen,
  teamView,
  toCoworkTeamError,
  type CoworkTeamSummary,
  type TeamCommentUnreadSession,
  type TeamGroupNotice,
  type TeamGroupRef,
  type TeamSharedItem,
} from "@/lib/cowork/team"
import type { DbConversationSummary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"
import {
  openSharedItem,
  type SharedSessionTarget,
  useCoworkTeamAvailable,
  useCoworkTeamStore,
} from "@/stores/cowork-team-store"
import { openOwnSessionComments } from "./session-comments"
import { sortSharedItems } from "./shared-with-me-list"

/** 收件箱的未读数：新分享数 + 未读留言数 + 未处理的进组提示数。 */
export function teamInboxUnread(summary: CoworkTeamSummary | null): number {
  if (!summary) return 0
  return (
    summary.sharedNew +
    summary.commentUnread.total +
    summary.groupNotices.length
  )
}

export type TeamInboxFilter = "all" | "shares" | "comments" | "groups"

const FILTERS: readonly TeamInboxFilter[] = [
  "all",
  "shares",
  "comments",
  "groups",
]

const FILTER_LABEL_KEYS = {
  all: "inboxFilterAll",
  shares: "inboxFilterShares",
  comments: "inboxFilterComments",
  groups: "inboxFilterGroups",
} as const satisfies Record<TeamInboxFilter, string>

type InboxEntry =
  | { kind: "share"; key: string; item: TeamSharedItem }
  | { kind: "comment"; key: string; session: TeamCommentUnreadSession }
  | { kind: "reply"; key: string; session: TeamCommentUnreadSession }
  | { kind: "group"; key: string; notice: TeamGroupNotice }

function sessionKey(x: { owner: string; id: string }): string {
  return `${x.owner}/${x.id}`
}

function matchesFilter(entry: InboxEntry, filter: TeamInboxFilter): boolean {
  if (filter === "all") return true
  if (filter === "shares") return entry.kind === "share"
  if (filter === "comments")
    return entry.kind === "comment" || entry.kind === "reply"
  return entry.kind === "group"
}

/**
 * 本地改一下 store 里的 `summary`（标了已读之后先把数字减掉）。返回写进去的
 * 那个对象，收件箱靠它认出「这是自己改的，不用重拉分享列表」。
 */
function patchSummary(
  patch: (summary: CoworkTeamSummary) => CoworkTeamSummary
): CoworkTeamSummary | null {
  const store = useCoworkTeamStore.getState()
  const summary = store.summary
  if (!summary) return null
  const next = patch(summary)
  store.setSummary(next)
  return useCoworkTeamStore.getState().summary === next ? next : null
}

/**
 * 别人会话里给我的回复：我是怎么看得到这个会话的，决定只读条写「由对方分享」
 * 还是「你是××组长」。分享列表（含已看过的）里有它就是分享来的；没有、而我
 * 当组长，就是组长身份：只当一个组的组长直接用那个组，好几个组时查一遍各组
 * 的成员，找对方在哪个组（查不出就用第一个组）。既没分享也不是组长时，只可能
 * 是分享来的。分享列表没拉到时，只有查到对方确实在我当组长的组里才写组长身份，
 * 否则按分享来的写。
 */
export async function resolveReplyVia(
  session: { owner: string; id: string },
  sharedList: TeamSharedItem[] | null,
  leaderOf: TeamGroupRef[]
): Promise<SharedSessionTarget["via"]> {
  const list = sharedList ?? (await teamShared().catch(() => null))
  const key = sessionKey(session)
  if (list?.some((x) => sessionKey(x) === key)) return { kind: "shared" }
  if (leaderOf.length === 0) return { kind: "shared" }
  // 分享列表拿到了、里面没有它，又只当一个组的组长：只能是组长身份。
  if (list && leaderOf.length === 1)
    return { kind: "leader", groupName: leaderOf[0].name }
  const views = await Promise.all(
    leaderOf.map((g) => teamView(g.id).catch(() => null))
  )
  const index = views.findIndex((v) =>
    v?.members.some((m) => m.name === session.owner)
  )
  if (index >= 0) return { kind: "leader", groupName: leaderOf[index].name }
  // 分享列表没拿到、也查不出对方在我哪个组里：说不准是不是分享来的，按分享
  // 来的写（只有组长才能写「你是××组长」，不能凭猜）。
  if (!list) return { kind: "shared" }
  return { kind: "leader", groupName: leaderOf[0].name }
}

/** 点到这些就算用户自己换了会话：侧栏里自己的会话、标签栏里的标签。 */
const USER_NAV_TARGETS = "[data-conversation-id], [data-tab-id]"

/**
 * 从现在起盯着用户有没有自己换到别的地方：点了侧栏里的会话或标签、活动标签
 * 变了、又打开了别的只读视图。收件箱要先等一会儿（查访问来源、等会话列表）
 * 才能打开的，等完先看一眼，换过了就不再盖上去、不再抢着切过去。
 */
export function watchUserNavigation(): {
  moved: () => boolean
  stop: () => void
} {
  let moved = false
  const startTab = useTabStore.getState().activeTabId
  const startOpen = useCoworkTeamStore.getState().openCount
  const onPointer = (event: Event) => {
    const target = event.target
    if (target instanceof Element && target.closest(USER_NAV_TARGETS))
      moved = true
  }
  document.addEventListener("pointerdown", onPointer, true)
  document.addEventListener("click", onPointer, true)
  const unsubscribe = useTabStore.subscribe((state, prev) => {
    if (state.activeTabId !== prev.activeTabId) moved = true
  })
  return {
    moved: () =>
      moved ||
      useTabStore.getState().activeTabId !== startTab ||
      useCoworkTeamStore.getState().openCount !== startOpen,
    stop: () => {
      document.removeEventListener("pointerdown", onPointer, true)
      document.removeEventListener("click", onPointer, true)
      unsubscribe()
    },
  }
}

/** 等会话列表最多这么久；再长就当没有。 */
const OWN_CONVERSATION_WAIT_MS = 30_000

/**
 * 收件箱里点了自己会话上的留言：找到这个会话（切过去要它的项目和智能体）。
 * 会话列表还在首次加载时等它回来；加载完了却没有（比如会话是刚建的）就刷新
 * 一次再找。还是没有、等太久、或者等的时候用户自己换到了别处，给 null。
 */
export function waitForOwnConversation(
  conversationId: number
): Promise<DbConversationSummary | null> {
  const find = () =>
    useAppWorkspaceStore
      .getState()
      .conversations.find((c) => c.id === conversationId) ?? null
  const hit = find()
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve) => {
    const nav = watchUserNavigation()
    let refreshed = false
    let finished = false
    const finish = (value: DbConversationSummary | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      unsubscribe()
      unsubscribeTabs()
      nav.stop()
      resolve(value)
    }
    const check = () => {
      if (finished) return
      if (nav.moved()) return finish(null)
      const found = find()
      if (found) return finish(found)
      const state = useAppWorkspaceStore.getState()
      if (!state.conversationsLoaded || state.conversationsLoading) return
      if (refreshed) return finish(null)
      refreshed = true
      void Promise.resolve(state.refreshConversations()).then(check, () =>
        finish(null)
      )
    }
    const timer = setTimeout(() => finish(null), OWN_CONVERSATION_WAIT_MS)
    const unsubscribe = useAppWorkspaceStore.subscribe(check)
    // 用户换标签不一定改会话列表：标签一变也看一眼。
    const unsubscribeTabs = useTabStore.subscribe(check)
    check()
  })
}

function withoutShares(count: number) {
  return (s: CoworkTeamSummary): CoworkTeamSummary => ({
    ...s,
    sharedNew: Math.max(0, s.sharedNew - count),
  })
}

function withoutCommentSession(session: TeamCommentUnreadSession) {
  return (s: CoworkTeamSummary): CoworkTeamSummary => {
    const sessions = s.commentUnread.sessions.filter(
      (x) =>
        !(
          x.id === session.id &&
          x.mine === session.mine &&
          x.owner === session.owner
        )
    )
    const removed = s.commentUnread.sessions.length - sessions.length
    return {
      ...s,
      commentUnread: {
        total: Math.max(
          0,
          s.commentUnread.total - (removed > 0 ? session.count : 0)
        ),
        sessions,
      },
    }
  }
}

function withoutNotice(noticeId: string) {
  return (s: CoworkTeamSummary): CoworkTeamSummary => ({
    ...s,
    groupNotices: s.groupNotices.filter((n) => n.id !== noticeId),
  })
}

export function TeamInbox({
  onOpenOwnSession,
}: {
  /** 切到自己的某个会话（工作界面的数字会话号）；留言栏由收件箱打开。 */
  onOpenOwnSession?: (conversationId: number) => void | Promise<void>
}) {
  const available = useCoworkTeamAvailable()
  if (!available) return null
  return <TeamInboxButton onOpenOwnSession={onOpenOwnSession} />
}

function TeamInboxButton({
  onOpenOwnSession,
}: {
  onOpenOwnSession?: (conversationId: number) => void | Promise<void>
}) {
  const t = useTranslations("CoworkTeam")
  const locale = useLocale()
  const summary = useCoworkTeamStore((s) => s.summary)
  const me = useCoworkTeamStore((s) => s.status?.me.name ?? "")
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<TeamInboxFilter>("all")
  const [shared, setShared] = useState<TeamSharedItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  // 最近一次拉到的完整分享列表（含已看过的），给回复条目判断访问来源用。
  const allShared = useRef<TeamSharedItem[] | null>(null)
  // 已经拉过的那个 summary、和本地标已读时改出来的那些：这些不重拉分享列表。
  const seenSummary = useRef(summary)
  // 已经标了已读、shared_seen 还没回来的分享：期间重拉回来的「新」不算数。
  const pendingSeen = useRef(new Set<string>())
  // 分享列表请求的序号：只认最后发出的那一次，早发晚回的旧列表不再盖上来。
  const sharedSeq = useRef(0)
  // 最后一次分享列表请求还没回来：这时手上的列表（上次打开时拉的）可能是旧的，
  // 全部标已读和回复条目的访问来源都不能拿它当准。
  const sharedPending = useRef(false)
  const unread = teamInboxUnread(summary)

  // 拉一次分享列表，拉到后把列表交给 `onList`（只在这是最后一次请求时）。
  const fetchShared = useCallback(
    (onList?: (list: TeamSharedItem[]) => void) => {
      const seq = ++sharedSeq.current
      sharedPending.current = true
      teamShared().then(
        (list) => {
          if (!mounted.current || seq !== sharedSeq.current) return
          sharedPending.current = false
          allShared.current = list
          onList?.(list)
          const pending = pendingSeen.current
          setShared(
            sortSharedItems(list).filter(
              (x) => x.isNew && !pending.has(sessionKey(x))
            )
          )
          setError(null)
        },
        (err: unknown) => {
          if (!mounted.current || seq !== sharedSeq.current) return
          sharedPending.current = false
          // 这次没拉到，上次的列表也不再当准。
          allShared.current = null
          const e = toCoworkTeamError(err)
          if (e.code === TEAM_SIGNED_OUT_CODE) return
          setError(e.message || e.code)
        }
      )
    },
    []
  )

  const loadShared = useCallback(() => fetchShared(), [fetchShared])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // 打开时拉一次；开着期间轮询来了新的 summary 再拉。
  useEffect(() => {
    if (!open) return
    seenSummary.current = useCoworkTeamStore.getState().summary
    loadShared()
  }, [open, loadShared])

  useEffect(() => {
    if (!open || summary === seenSummary.current) return
    seenSummary.current = summary
    if (summary) loadShared()
  }, [open, summary, loadShared])

  const patch = useCallback(
    (fn: (s: CoworkTeamSummary) => CoworkTeamSummary) => {
      const local = patchSummary(fn)
      if (local) seenSummary.current = local
    },
    []
  )

  const markShareSeen = useCallback(
    (item: TeamSharedItem) => {
      const key = sessionKey(item)
      if (pendingSeen.current.has(key)) return
      pendingSeen.current.add(key)
      setShared((prev) =>
        prev ? prev.filter((x) => sessionKey(x) !== key) : prev
      )
      patch(withoutShares(1))
      const done = () => {
        pendingSeen.current.delete(key)
      }
      teamSharedSeen(item.owner, item.id).then(done, done)
    },
    [patch]
  )

  const markCommentsSeen = useCallback(
    (session: TeamCommentUnreadSession) => {
      patch(withoutCommentSession(session))
      const owner = session.owner || (session.mine ? me : "")
      if (owner) void teamCommentsSeen(owner, session.id).catch(() => {})
    },
    [patch, me]
  )

  const dismissNotice = useCallback(
    (notice: TeamGroupNotice) => {
      patch(withoutNotice(notice.id))
      void teamGroupNoticeDismiss(notice.id).catch(() => {})
    },
    [patch]
  )

  const entries = useMemo((): InboxEntry[] => {
    const list: InboxEntry[] = []
    for (const notice of summary?.groupNotices ?? [])
      list.push({ kind: "group", key: `group:${notice.id}`, notice })
    for (const item of shared ?? [])
      list.push({ kind: "share", key: `share:${sessionKey(item)}`, item })
    for (const session of summary?.commentUnread.sessions ?? []) {
      if (session.count <= 0) continue
      const owner = session.owner || (session.mine ? me : "")
      const kind = session.mine ? "comment" : "reply"
      list.push({
        kind,
        key: `${kind}:${owner}/${session.id}`,
        session,
      })
    }
    return list
  }, [summary, shared, me])

  const visible = entries.filter((entry) => matchesFilter(entry, filter))

  const openEntry = useCallback(
    (entry: InboxEntry) => {
      if (entry.kind === "share") {
        openSharedItem(entry.item)
        markShareSeen(entry.item)
        setOpen(false)
        return
      }
      if (entry.kind === "comment") {
        const id = Number(entry.session.id)
        // 盖着的只读视图先收起，不然切过去的自己的会话被它挡着。
        useCoworkTeamStore.getState().closeSharedSession()
        if (Number.isSafeInteger(id)) void onOpenOwnSession?.(id)
        openOwnSessionComments(id)
        markCommentsSeen(entry.session)
        setOpen(false)
        return
      }
      if (entry.kind === "reply") {
        const s = entry.session
        // 访问来源要先查清（可能要发请求）；期间用户切到了自己的会话、换了
        // 标签或又打开了别的会话，就不再盖上去。
        const nav = watchUserNavigation()
        const leaderOf = useCoworkTeamStore.getState().status?.leaderOf ?? []
        // 分享列表还在拉（比如刚重新打开收件箱）时手上的是旧列表，交给
        // resolveReplyVia 自己现拉一次。
        const known = sharedPending.current ? null : allShared.current
        void resolveReplyVia(s, known, leaderOf).then((via) => {
          const moved = nav.moved()
          nav.stop()
          if (moved) return
          useCoworkTeamStore.getState().openSharedSession({
            owner: s.owner,
            ownerLabel: s.ownerLabel,
            id: s.id,
            title: s.title,
            via,
          })
        })
        markCommentsSeen(s)
        setOpen(false)
      }
    },
    [markShareSeen, markCommentsSeen, onOpenOwnSession]
  )

  const markEntry = useCallback(
    (entry: InboxEntry) => {
      if (entry.kind === "share") markShareSeen(entry.item)
      else if (entry.kind === "group") dismissNotice(entry.notice)
      else markCommentsSeen(entry.session)
    },
    [markShareSeen, dismissNotice, markCommentsSeen]
  )

  const markAll = useCallback(() => {
    for (const entry of entries) markEntry(entry)
    // 分享列表还在加载（包括重新打开后手上还是上次的旧列表）或加载失败时，
    // 新分享不一定都在条目里：现拉一次，把拉到的新分享也逐个标掉，「全部」
    // 才名副其实。
    const sharedNew = useCoworkTeamStore.getState().summary?.sharedNew ?? 0
    const stale = shared === null || error !== null || sharedPending.current
    if (stale && sharedNew > 0) {
      fetchShared((list) => {
        for (const x of list) if (x.isNew) markShareSeen(x)
      })
    }
  }, [entries, markEntry, shared, error, fetchShared, markShareSeen])

  // 几个组长的名字连起来：中日文用顿号，阿拉伯文用阿拉伯逗号，其余用逗号。
  const leadersOf = useCallback(
    (leaders: string[]) => {
      const sep = /^(zh|ja)/.test(locale)
        ? "、"
        : locale.startsWith("ar")
          ? "، "
          : ", "
      return leaders.join(sep)
    },
    [locale]
  )

  const label = t("inboxTitle")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-team-inbox-button=""
          aria-label={
            unread > 0 ? t("inboxButtonUnread", { count: unread }) : label
          }
          title={label}
          className="lg-ib h-6 w-auto min-w-6 shrink-0 gap-0.5 rounded-full px-1 text-[var(--ink2)] hover:bg-[var(--g-hover)] aria-expanded:bg-[var(--g-sel)] dark:hover:bg-[var(--g-hover)]"
        >
          <Inbox aria-hidden="true" className="h-[0.9375rem] w-[0.9375rem]" />
          {unread > 0 && (
            <span
              data-team-inbox-count=""
              aria-hidden="true"
              // 和会话列表的未读数同一种蓝色。
              className="inline-flex h-[0.9375rem] min-w-[0.9375rem] items-center justify-center rounded-full bg-[var(--st-unread)] px-[0.25rem] text-[0.625rem] font-medium leading-none text-white"
            >
              {formatBadgeCount(unread)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-team-inbox=""
        aria-label={label}
        className="w-80 gap-2 p-2"
      >
        <div className="flex items-center gap-2 px-1">
          <span className="flex-1 text-[0.8125rem] font-medium">{label}</span>
          <button
            type="button"
            onClick={markAll}
            // 分享列表没拉到时条目里没有新分享，但数字里有，照样能点。
            disabled={entries.length === 0 && unread === 0}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.6875rem] text-muted-foreground hover:bg-[var(--g-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <CheckCheck aria-hidden="true" className="h-3 w-3" />
            {t("inboxMarkAllRead")}
          </button>
        </div>
        <div
          role="group"
          aria-label={t("inboxFilterLabel")}
          className="flex gap-0.5 px-1"
        >
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={cn(
                "inline-flex h-6 items-center rounded-full px-2 text-[0.6875rem] text-muted-foreground hover:bg-[var(--g-hover)] hover:text-foreground",
                filter === option && "bg-[var(--g-sel)] text-foreground"
              )}
            >
              {t(FILTER_LABEL_KEYS[option])}
            </button>
          ))}
        </div>
        <div className="max-h-[22rem] min-h-0 overflow-y-auto">
          {error !== null && filter !== "comments" && filter !== "groups" && (
            <div className="flex flex-col items-start gap-1 px-2 py-1 text-[0.75rem] text-destructive">
              <span className="break-words">
                {t("sharedLoadFailed", { message: error })}
              </span>
              <button
                type="button"
                onClick={loadShared}
                className="rounded px-1 text-primary underline-offset-2 hover:underline"
              >
                {t("retry")}
              </button>
            </div>
          )}
          {visible.length === 0 && (
            <p className="px-2 py-2 text-[0.75rem] text-muted-foreground">
              {t("inboxEmpty")}
            </p>
          )}
          <ul className="flex flex-col gap-px">
            {visible.map((entry) => (
              <li
                key={entry.key}
                data-inbox-item={entry.key}
                className="group flex min-w-0 items-start gap-1 rounded-[0.625rem] px-1 py-1 hover:bg-[var(--g-hover)]"
              >
                {entry.kind === "group" ? (
                  <>
                    <p className="min-w-0 flex-1 px-1 text-[0.75rem] break-words">
                      {entry.notice.leaders.length > 0
                        ? t("inboxGroupAdded", {
                            group: entry.notice.groupName,
                            leaders: leadersOf(entry.notice.leaders),
                          })
                        : t("inboxGroupAddedNoLeader", {
                            group: entry.notice.groupName,
                          })}
                    </p>
                    <button
                      type="button"
                      onClick={() => markEntry(entry)}
                      className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-[0.6875rem] text-primary hover:bg-[var(--g-hover)]"
                    >
                      {t("inboxGotIt")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      data-inbox-open=""
                      onClick={() => openEntry(entry)}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <InboxEntryText entry={entry} />
                    </button>
                    <button
                      type="button"
                      data-inbox-mark-read=""
                      onClick={() => markEntry(entry)}
                      aria-label={t("inboxMarkRead")}
                      title={t("inboxMarkRead")}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--g-hover)] hover:text-foreground"
                    >
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function InboxEntryText({
  entry,
}: {
  entry: Exclude<InboxEntry, { kind: "group" }>
}) {
  const t = useTranslations("CoworkTeam")
  if (entry.kind === "share") {
    const { item } = entry
    return (
      <>
        <span className="text-[0.6875rem] text-muted-foreground">
          {t("inboxShareFrom", { owner: item.ownerLabel })}
        </span>
        <span dir="auto" className="w-full truncate text-[0.8125rem]">
          {item.title || t("untitled")}
        </span>
        {item.note && (
          <span
            dir="auto"
            className="w-full text-[0.75rem] break-words whitespace-pre-wrap text-muted-foreground"
          >
            {item.note}
          </span>
        )}
      </>
    )
  }
  const { session } = entry
  return (
    <>
      <span className="text-[0.6875rem] text-muted-foreground">
        {entry.kind === "comment"
          ? t("inboxNewComments", { count: session.count })
          : t("inboxReplies", {
              owner: session.ownerLabel,
              count: session.count,
            })}
      </span>
      <span dir="auto" className="w-full truncate text-[0.8125rem]">
        {session.title || t("untitled")}
      </span>
    </>
  )
}
