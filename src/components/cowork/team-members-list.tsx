"use client"

// CoTeam 的会话分享（#1235 第 3 行）：范围切换选「团队」（只有组长有）时，
// 会话列表的位置换成本组成员和他们的会话。
//
// 数据只来自 `team`：组选择（只当一个组的组长时不显示）、状态筛选（全部 /
// 进行中 / 待查看，只按会话的 `state` 在本地过滤）、日期（「今天」不给
// `since`，「最近 7 天」给 7 天前的时间）。下面按成员分层折叠：成员行是头像、
// 名字、「进行中 N · 待查看 N」（数字原样用 `team` 给的），展开是他的会话行，
// 会话的 `waiting` 带 `awaiting` 时才写在等什么，没带的只是做完等人看（#1513），
// 点一行在主区域只读打开（第 2 行的视图，只读条写「你是某组组长」）。
//
// 挂上、换组、换日期时拉一次，之后每来一次新的 `summary` 就再拉（跟着 60 秒
// 一次的 summary，不自己另起轮询）。`team` 回 `not_found` / `forbidden`：已经
// 不是这个组的组长，收起内容并提示。成员名、会话标题一律按纯文字显示。

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronRight } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import {
  TEAM_SIGNED_OUT_CODE,
  teamView,
  toCoworkTeamError,
  teamStateLabelKey,
  type TeamMember,
  type TeamMemberSession,
  type TeamView,
} from "@/lib/cowork/team"
import { noteTeamError, teamErrorText } from "@/lib/cowork/team-errors"
import { formatTimeAgo } from "@/lib/relative-time"
import { cn } from "@/lib/utils"
import {
  useCoworkTeamStore,
  type SharedSessionTarget,
} from "@/stores/cowork-team-store"
import { ownerInitial } from "@/components/cowork/shared-with-me-list"

export type TeamStateFilter = "all" | "running" | "waiting"
export type TeamDateRange = "today" | "week"

const DAY_MS = 24 * 60 * 60_000

/** 「今天」不给 `since`（服务器按当地今天零点算）；「最近 7 天」给 7 天前。 */
export function teamSinceFor(
  range: TeamDateRange,
  now: number
): string | undefined {
  return range === "week" ? new Date(now - 7 * DAY_MS).toISOString() : undefined
}

/** 只按会话的 `state` 过滤。 */
export function filterTeamSessions(
  sessions: TeamMemberSession[],
  filter: TeamStateFilter
): TeamMemberSession[] {
  return filter === "all"
    ? sessions
    : sessions.filter((session) => session.state === filter)
}

/** 这几种错误说明已经不是这个组的组长（或组没了）。 */
const GONE_CODES = new Set(["not_found", "forbidden"])

/** 「几分钟前」多久刷新一次。 */
const CLOCK_TICK_MS = 60_000

const STATE_FILTERS: readonly TeamStateFilter[] = ["all", "running", "waiting"]
const STATE_FILTER_KEYS = {
  all: "teamFilterAll",
  running: "stateRunning",
  waiting: "stateReview",
} as const satisfies Record<TeamStateFilter, string>

const DATE_RANGES: readonly TeamDateRange[] = ["today", "week"]
const DATE_RANGE_KEYS = {
  today: "teamRangeToday",
  week: "teamRangeWeek",
} as const satisfies Record<TeamDateRange, string>

function timeOf(raw: string): number {
  const at = Date.parse(raw)
  return Number.isFinite(at) ? at : 0
}

/** 侧栏用：点了一行，在主区域只读打开它。 */
export function openTeamSession(target: SharedSessionTarget): void {
  useCoworkTeamStore.getState().openSharedSession(target)
}

function Segmented<T extends string>({
  label,
  name,
  options,
  value,
  labelOf,
  onChange,
}: {
  label: string
  name: string
  options: readonly T[]
  value: T
  labelOf: (option: T) => string
  onChange: (option: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-6 min-w-0 items-center gap-0.5 rounded-[0.5rem] bg-[var(--g-hover)] p-0.5"
    >
      {options.map((option) => {
        const selected = option === value
        return (
          <button
            key={option}
            type="button"
            {...{ [`data-team-${name}`]: option }}
            aria-pressed={selected}
            onClick={() => onChange(option)}
            className={cn(
              "flex h-full min-w-0 items-center justify-center rounded-[0.375rem] px-1.5",
              "text-[0.6875rem] outline-none transition-colors duration-150",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected
                ? "bg-background font-medium text-sidebar-foreground shadow-sm"
                : "text-[var(--ink2)] hover:text-sidebar-foreground"
            )}
          >
            <span className="truncate">{labelOf(option)}</span>
          </button>
        )
      })}
    </div>
  )
}

export function TeamMembersList({
  onOpen,
}: {
  /** 点了一行会话：在主区域打开只读视图。 */
  onOpen?: (target: SharedSessionTarget) => void
}) {
  const t = useTranslations("CoworkTeam")
  const locale = useLocale()
  const groups = useCoworkTeamStore((s) => s.status?.leaderOf)
  const summary = useCoworkTeamStore((s) => s.summary)
  const [pickedGroup, setPickedGroup] = useState<string | null>(null)
  const [stateFilter, setStateFilter] = useState<TeamStateFilter>("all")
  const [range, setRange] = useState<TeamDateRange>("today")
  const [view, setView] = useState<TeamView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  // 「几分钟前」的参照时间：拉到数据时和每分钟更新一次（不在渲染时读时钟）。
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(true)
  // 每发一次请求加一：换组、换日期后，旧请求晚回来的结果不要。
  const requestId = useRef(0)
  const seenSummary = useRef(summary)

  const groupList = useMemo(() => groups ?? [], [groups])
  // 记着的组已经不在组长名单里了（被撤了组长）：回到第一个。
  const group =
    groupList.find((g) => g.id === pickedGroup) ?? groupList[0] ?? null
  const groupId = group?.id ?? null

  const load = useCallback(() => {
    if (!groupId) return
    const id = ++requestId.current
    teamView(groupId, teamSinceFor(range, Date.now())).then(
      (next) => {
        if (!mounted.current || id !== requestId.current) return
        setView(next)
        setGone(false)
        setError(null)
        setNow(Date.now())
      },
      (err: unknown) => {
        if (!mounted.current || id !== requestId.current) return
        const e = toCoworkTeamError(err)
        // 登录过期：入口整个收起，这里不用再提示。
        if (e.code === TEAM_SIGNED_OUT_CODE) return
        if (GONE_CODES.has(e.code)) {
          // 专门提示照旧优先，原文也记一行方便排查。
          noteTeamError("team", e)
          setView(null)
          setGone(true)
          setError(null)
          return
        }
        setError(noteTeamError("team", e))
      }
    )
  }, [groupId, range])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // 挂上、换组、换日期：清掉旧组的内容再拉。
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setView(null)
    setGone(false)
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    load()
  }, [load])

  useEffect(() => {
    if (summary === seenSummary.current) return
    seenSummary.current = summary
    if (summary) load()
  }, [summary, load])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const toggleMember = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const openSession = useCallback(
    (member: TeamMember, session: TeamMemberSession) => {
      onOpen?.({
        owner: session.owner,
        ownerLabel: member.label,
        id: session.id,
        title: session.title,
        via: {
          kind: "leader",
          groupName: view?.name || group?.name || "",
        },
      })
    },
    [onOpen, view?.name, group?.name]
  )

  if (!group) return null

  return (
    <div
      data-team-members-list=""
      className="flex min-h-0 flex-1 flex-col overflow-hidden pt-1.5"
    >
      <div className="flex shrink-0 flex-col gap-1 px-2 pb-1">
        {groupList.length > 1 && (
          <select
            data-team-group-select=""
            aria-label={t("teamGroupLabel")}
            value={group.id}
            onChange={(event) => setPickedGroup(event.target.value)}
            className="h-7 min-w-0 rounded-[0.625rem] bg-[var(--g-hover)] px-2 text-[0.75rem] text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {groupList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Segmented
            label={t("teamStateFilterLabel")}
            name="state-filter"
            options={STATE_FILTERS}
            value={stateFilter}
            labelOf={(option) => t(STATE_FILTER_KEYS[option])}
            onChange={setStateFilter}
          />
          <Segmented
            label={t("teamRangeLabel")}
            name="range"
            options={DATE_RANGES}
            value={range}
            labelOf={(option) => t(DATE_RANGE_KEYS[option])}
            onChange={setRange}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {gone && (
          <p
            data-team-gone=""
            className="px-2 py-2 text-[0.75rem] text-muted-foreground"
          >
            {t("teamNoLongerLeader")}
          </p>
        )}
        {error !== null && (
          <div className="flex flex-col items-start gap-1 px-2 py-2 text-[0.75rem] text-destructive">
            <span data-team-error="" className="break-words">
              {t("sharedLoadFailed", {
                message: teamErrorText(error, t),
              })}
            </span>
            <button
              type="button"
              onClick={load}
              className="rounded px-1 text-primary underline-offset-2 hover:underline"
            >
              {t("retry")}
            </button>
          </div>
        )}
        {view !== null && view.members.length === 0 && (
          <p className="px-2 py-2 text-[0.75rem] text-muted-foreground">
            {t("teamEmpty")}
          </p>
        )}
        {view !== null && (
          <ul className="flex flex-col gap-px">
            {view.members.map((member) => {
              const open = expanded.has(member.name)
              const sessions = filterTeamSessions(member.sessions, stateFilter)
              return (
                <li key={member.name} data-team-member={member.name}>
                  <button
                    type="button"
                    data-team-member-row=""
                    aria-expanded={open}
                    onClick={() => toggleMember(member.name)}
                    title={member.label}
                    className={cn(
                      "flex h-[1.9375rem] w-full min-w-0 items-center gap-[0.375rem] rounded-[0.625rem] pl-[0.25rem] pr-[0.375rem] text-left",
                      "text-sidebar-foreground outline-none transition-colors duration-[120ms]",
                      "hover:bg-[var(--g-hover)]",
                      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    )}
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "h-[0.8125rem] w-[0.8125rem] shrink-0 text-muted-foreground transition-transform duration-150",
                        open && "rotate-90"
                      )}
                    />
                    <span
                      aria-hidden="true"
                      className="inline-flex h-[1.125rem] w-[1.125rem] shrink-0 items-center justify-center rounded-full bg-primary/15 text-[0.625rem] font-medium leading-none text-primary"
                    >
                      {ownerInitial(member.label)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
                      {member.label}
                    </span>
                    <span
                      data-team-member-counts=""
                      className="shrink-0 text-[0.6875rem] text-muted-foreground"
                    >
                      {t("teamMemberCounts", {
                        running: member.running,
                        waiting: member.waiting,
                      })}
                    </span>
                  </button>
                  {open && (
                    <ul className="flex flex-col gap-px pl-[1.375rem]">
                      {sessions.length === 0 && (
                        <li className="px-2 py-1 text-[0.75rem] text-muted-foreground">
                          {t("teamMemberEmpty")}
                        </li>
                      )}
                      {sessions.map((session) => {
                        const title = session.title || t("untitled")
                        const updatedAt = timeOf(session.updatedAt)
                        const awaiting = session.awaiting ?? null
                        const stateLabel = t(
                          teamStateLabelKey(session.state, awaiting)
                        )
                        return (
                          <li key={`${session.owner}/${session.id}`}>
                            <button
                              type="button"
                              data-team-session={`${session.owner}/${session.id}`}
                              onClick={() => openSession(member, session)}
                              title={title}
                              className={cn(
                                "group flex h-[1.9375rem] w-full min-w-0 items-center gap-[0.5rem] rounded-[0.625rem] pl-[0.5rem] pr-[0.375rem] text-left",
                                "text-sidebar-foreground outline-none transition-colors duration-[120ms]",
                                "hover:bg-[var(--g-hover)]",
                                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                                {title}
                              </span>
                              {session.state !== "done" && (
                                <span
                                  data-team-session-state={session.state}
                                  data-team-session-awaiting={
                                    awaiting
                                      ? (awaiting.reason ?? "other")
                                      : undefined
                                  }
                                  title={
                                    awaiting?.title
                                      ? `${stateLabel} · ${awaiting.title}`
                                      : stateLabel
                                  }
                                  className={cn(
                                    "inline-flex h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full",
                                    session.state === "running"
                                      ? "animate-pulse bg-emerald-500"
                                      : awaiting
                                        ? "bg-amber-500"
                                        : "bg-sky-500"
                                  )}
                                >
                                  <span className="sr-only">{stateLabel}</span>
                                </span>
                              )}
                              {updatedAt > 0 && (
                                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                                  {formatTimeAgo(updatedAt, now, locale)}
                                </span>
                              )}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
