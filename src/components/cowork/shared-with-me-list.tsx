"use client"

// CoTeam 的会话分享（#1235 第 1 行）：范围切换选「分享给我」时，会话列表的
// 位置换成别人分享给我的会话。
//
// 数据只来自 `shared`：按分享时间新的在前；没看过的行有「新」点，点开后调
// `shared_seen`，点和切换条上的数字一起减。标题筛选只在本地过滤。挂上时拉一
// 次，之后每来一次新的 `summary` 就再拉（跟着 60 秒一次的 summary，不自己另起
// 轮询；新分享数没变也拉，同事取消分享、增减抵消时列表才不会过期）。「几分钟
// 前」每分钟刷新一次。别人写的标题、说明一律按纯文字显示。

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Search } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import {
  TEAM_SIGNED_OUT_CODE,
  teamShared,
  teamSharedSeen,
  teamStateLabelKey,
  toCoworkTeamError,
  type CoworkTeamSummary,
  type TeamSharedItem,
} from "@/lib/cowork/team"
import { noteTeamError, teamErrorText } from "@/lib/cowork/team-errors"
import { formatTimeAgo } from "@/lib/relative-time"
import { cn } from "@/lib/utils"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"

function timeOf(raw: string): number {
  const at = Date.parse(raw)
  return Number.isFinite(at) ? at : 0
}

/** 按分享时间新的在前；时间读不出来的排最后，同时间保持服务端给的顺序。 */
export function sortSharedItems(items: TeamSharedItem[]): TeamSharedItem[] {
  return items
    .map((item, index) => ({ item, index, at: timeOf(item.sharedAt) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ item }) => item)
}

/** 名字的第一个字（按字符算，不会把表情或汉字切成半个）。 */
export function ownerInitial(label: string): string {
  const first = Array.from(label.trim())[0]
  return first ? first.toLocaleUpperCase() : "?"
}

function sameSession(a: TeamSharedItem, b: TeamSharedItem): boolean {
  return a.owner === b.owner && a.id === b.id
}

function sessionKey(item: { owner: string; id: string }): string {
  return `${item.owner}/${item.id}`
}

/** 本地把新分享数减 1，返回写进 store 的那个 summary（不是轮询来的）。 */
function decrementSharedNew(): CoworkTeamSummary | null {
  const store = useCoworkTeamStore.getState()
  const summary = store.summary
  if (!summary) return null
  const next = {
    ...summary,
    sharedNew: Math.max(0, summary.sharedNew - 1),
  }
  store.setSummary(next)
  return useCoworkTeamStore.getState().summary === next ? next : null
}

/** 「几分钟前」多久刷新一次。 */
const CLOCK_TICK_MS = 60_000

export function SharedWithMeList({
  onOpen,
}: {
  /** 点了一行：在主区域打开只读视图。 */
  onOpen?: (item: TeamSharedItem) => void
}) {
  const t = useTranslations("CoworkTeam")
  const locale = useLocale()
  const summary = useCoworkTeamStore((s) => s.summary)
  const [items, setItems] = useState<TeamSharedItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  // 「几分钟前」的参照时间：拉到列表时和每分钟更新一次（不在渲染时读时钟）。
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(true)
  // 挂上时已经拉过的那个 summary，和点开一行时本地减出来的那个：这两个不重拉，
  // 别的（轮询来的）都重拉。
  const seenSummary = useRef(summary)
  // 已经点开、shared_seen 还没回来的行：期间重拉回来的「新」不算数。
  const pendingSeen = useRef(new Set<string>())

  const load = useCallback(() => {
    teamShared().then(
      (list) => {
        if (!mounted.current) return
        const pending = pendingSeen.current
        setItems(
          sortSharedItems(list).map((x) =>
            x.isNew && pending.has(sessionKey(x)) ? { ...x, isNew: false } : x
          )
        )
        setNow(Date.now())
        setError(null)
      },
      (err: unknown) => {
        if (!mounted.current) return
        const e = toCoworkTeamError(err)
        // 登录过期：入口整个收起，这里不用再提示。
        if (e.code === TEAM_SIGNED_OUT_CODE) return
        setError(noteTeamError("shared", e))
      }
    )
  }, [])

  useEffect(() => {
    mounted.current = true
    load()
    return () => {
      mounted.current = false
    }
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

  const visible = useMemo(() => {
    if (!items) return []
    const needle = filter.trim().toLocaleLowerCase()
    if (!needle) return items
    return items.filter((item) =>
      item.title.toLocaleLowerCase().includes(needle)
    )
  }, [items, filter])

  const handleOpen = useCallback(
    (item: TeamSharedItem) => {
      onOpen?.(item)
      if (!item.isNew) return
      setItems((prev) =>
        prev
          ? prev.map((x) => (sameSession(x, item) ? { ...x, isNew: false } : x))
          : prev
      )
      const local = decrementSharedNew()
      if (local) seenSummary.current = local
      const key = sessionKey(item)
      pendingSeen.current.add(key)
      teamSharedSeen(item.owner, item.id).then(
        () => {
          pendingSeen.current.delete(key)
        },
        () => {
          pendingSeen.current.delete(key)
          // 没记上：把点放回去，下一次 summary 会把数字也纠正回来。
          if (!mounted.current) return
          setItems((prev) =>
            prev
              ? prev.map((x) =>
                  sameSession(x, item) ? { ...x, isNew: true } : x
                )
              : prev
          )
        }
      )
    },
    [onOpen]
  )

  return (
    <div
      data-shared-with-me-list=""
      className="flex min-h-0 flex-1 flex-col overflow-hidden pt-1.5"
    >
      <div className="shrink-0 px-2 pb-1">
        <label className="flex h-7 items-center gap-1.5 rounded-[0.625rem] bg-[var(--g-hover)] px-2">
          <Search
            aria-hidden="true"
            className="h-[0.8125rem] w-[0.8125rem] shrink-0 text-muted-foreground"
          />
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("sharedFilterPlaceholder")}
            aria-label={t("sharedFilterPlaceholder")}
            className="h-full min-w-0 flex-1 bg-transparent text-[0.75rem] outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {error !== null && (
          <div className="flex flex-col items-start gap-1 px-2 py-2 text-[0.75rem] text-destructive">
            <span data-shared-error="" className="break-words">
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
        {error === null && items !== null && items.length === 0 && (
          <p className="px-2 py-2 text-[0.75rem] text-muted-foreground">
            {t("sharedEmpty")}
          </p>
        )}
        {items !== null && items.length > 0 && visible.length === 0 && (
          <p className="px-2 py-2 text-[0.75rem] text-muted-foreground">
            {t("sharedNoMatch")}
          </p>
        )}
        <ul className="flex flex-col gap-px">
          {visible.map((item) => {
            const title = item.title || t("untitled")
            const updatedAt = timeOf(item.updatedAt)
            // `waiting` 没带 `awaiting` 只是做完等人看，写「待查看」（#1513）。
            const awaiting = item.awaiting ?? null
            const stateLabel = t(teamStateLabelKey(item.state, awaiting))
            const hover = [
              title,
              t("sharedBy", { owner: item.ownerLabel }),
              item.note,
            ]
              .filter(Boolean)
              .join("\n")
            return (
              <li key={`${item.owner}/${item.id}`}>
                <button
                  type="button"
                  data-shared-session={`${item.owner}/${item.id}`}
                  onClick={() => handleOpen(item)}
                  title={hover}
                  className={cn(
                    "group flex h-[1.9375rem] w-full min-w-0 items-center gap-[0.5rem] rounded-[0.625rem] pl-[0.5rem] pr-[0.375rem] text-left",
                    "text-sidebar-foreground outline-none transition-colors duration-[120ms]",
                    "hover:bg-[var(--g-hover)]",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex h-[1.125rem] w-[1.125rem] shrink-0 items-center justify-center rounded-full bg-primary/15 text-[0.625rem] font-medium leading-none text-primary"
                  >
                    {ownerInitial(item.ownerLabel)}
                  </span>
                  <span className="sr-only">{item.ownerLabel}</span>
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                    {title}
                  </span>
                  {item.isNew && (
                    <span
                      data-shared-new=""
                      // 和会话列表的未读点同一种蓝色。
                      className="inline-flex h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full bg-[var(--st-unread)]"
                    >
                      <span className="sr-only">{t("newBadge")}</span>
                    </span>
                  )}
                  {item.state !== "done" && (
                    <span
                      data-shared-state={item.state}
                      data-shared-awaiting={
                        awaiting ? (awaiting.reason ?? "other") : undefined
                      }
                      title={
                        awaiting?.title
                          ? `${stateLabel} · ${awaiting.title}`
                          : stateLabel
                      }
                      className={cn(
                        "inline-flex h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full",
                        item.state === "running"
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
      </div>
    </div>
  )
}
