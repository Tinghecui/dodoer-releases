"use client"

// CoTeam 的会话分享（#1235 第 1 行）：侧栏功能入口和会话列表之间的范围切换
// 「我的 / 分享给我 / 团队」。
//
// 团队功能不可用时什么都不画（侧栏和原来一样），也不发任何请求；「团队」只有
// 当组长的人有。选中的一档记在本机，刷新后还在；记着「团队」但现在不是组长、
// 或者团队功能不可用时，按「我的」显示（记着的选择不改，回来以后照旧）。

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"

export type TeamScope = "mine" | "shared" | "team"

export const TEAM_SCOPE_STORAGE_KEY = "cowork.team.scope"

export function loadTeamScope(): TeamScope {
  try {
    const raw = window.localStorage.getItem(TEAM_SCOPE_STORAGE_KEY)
    return raw === "shared" || raw === "team" ? raw : "mine"
  } catch {
    return "mine"
  }
}

export function saveTeamScope(scope: TeamScope): void {
  try {
    window.localStorage.setItem(TEAM_SCOPE_STORAGE_KEY, scope)
  } catch {
    // 存不了（隐私模式等）：这次会话里照样能切，只是刷新后回到「我的」。
  }
}

/** 实际显示哪一档：不可用一律「我的」；记着「团队」但已不是组长也回「我的」。 */
export function resolveTeamScope(
  scope: TeamScope,
  available: boolean,
  isLeader: boolean
): TeamScope {
  if (!available) return "mine"
  if (scope === "team" && !isLeader) return "mine"
  return scope
}

/** 侧栏用：实际显示的那一档和切换函数。挂载后才从本机读记着的选择。 */
export function useTeamScope(): {
  scope: TeamScope
  setScope: (scope: TeamScope) => void
} {
  const [stored, setStored] = useState<TeamScope>("mine")
  const available = useCoworkTeamStore((s) => s.available)
  const isLeader = useCoworkTeamStore(
    (s) => (s.status?.leaderOf.length ?? 0) > 0
  )

  useEffect(() => {
    // 挂载后再读本机，免得首屏和静态导出的标记对不上。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStored(loadTeamScope())
  }, [])

  const setScope = useCallback((scope: TeamScope) => {
    setStored(scope)
    saveTeamScope(scope)
  }, [])

  return { scope: resolveTeamScope(stored, available, isLeader), setScope }
}

const SCOPES: readonly TeamScope[] = ["mine", "shared", "team"]

const SCOPE_LABEL_KEYS = {
  mine: "scopeMine",
  shared: "scopeShared",
  team: "scopeTeam",
} as const

export function TeamScopeSwitch({
  scope,
  onChange,
}: {
  scope: TeamScope
  onChange: (scope: TeamScope) => void
}) {
  const t = useTranslations("CoworkTeam")
  const available = useCoworkTeamStore((s) => s.available)
  const isLeader = useCoworkTeamStore(
    (s) => (s.status?.leaderOf.length ?? 0) > 0
  )
  const sharedNew = useCoworkTeamStore((s) => s.summary?.sharedNew ?? 0)

  if (!available) return null

  const scopes = SCOPES.filter((item) => item !== "team" || isLeader)

  return (
    <div className="shrink-0 px-2 pb-1">
      <div
        role="group"
        aria-label={t("scopeLabel")}
        data-team-scope-switch=""
        className="flex h-7 items-center gap-0.5 rounded-[0.625rem] bg-[var(--g-hover)] p-0.5"
      >
        {scopes.map((item) => {
          const selected = item === scope
          const label = t(SCOPE_LABEL_KEYS[item])
          const count = item === "shared" ? sharedNew : 0
          return (
            <button
              key={item}
              type="button"
              data-team-scope={item}
              aria-pressed={selected}
              onClick={() => onChange(item)}
              className={cn(
                "flex h-full min-w-0 flex-1 items-center justify-center gap-1 rounded-[0.5rem] px-1.5",
                "text-[0.75rem] outline-none transition-colors duration-150",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selected
                  ? "bg-background font-medium text-sidebar-foreground shadow-sm"
                  : "text-[var(--ink2)] hover:text-sidebar-foreground"
              )}
            >
              <span className="truncate">{label}</span>
              {count > 0 && (
                <span
                  data-team-scope-count=""
                  className="inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[0.625rem] font-medium leading-none text-primary"
                >
                  {/* 显示实际数量，不封顶成「99+」：完成标准要数字等于新分享数。 */}
                  <span aria-hidden="true">{count}</span>
                  <span className="sr-only">
                    {t("sharedNewCount", { count })}
                  </span>
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
