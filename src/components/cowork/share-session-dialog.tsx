"use client"

// CoTeam 的会话分享（#1235 第 4 行）：自己会话的顶栏「分享」按钮和侧栏右键
// 「分享…」打开的同一个对话框。
//
// 打开时拉一次 `targets`（候选的人和组）和 `shares`（现在分享给了谁）：候选里
// 去掉自己和已经分享过的；能按名字搜。确认发 `share`（勾上的人和组、一句说明），
// 「现在分享给了谁」里逐个取消发带 `target` 的 `unshare`，「全部取消」发不带
// `target` 的 `unshare`。服务端报错时原文显示在对话框里，对话框不关。
//
// 会话刚建好、CoTeam 那边还没收到它时回 `not_found`：提示「刚建好，过几秒再试」，
// 3 秒后自动把同一个操作再做一次（只重试一次）；等重试时用户又做了别的操作，
// 旧的重试作废。人名、组名、说明一律纯文字。手机端不做：不画入口。
//
// 顶栏按钮出现时按会话问一次 `shares`（这次打开期间同一个会话只问一次，不轮询），
// 分享给了别人时按钮上带分享对象个数；对话框里拿到新结果时跟着更新（#1390）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Search, Share2, Users, X } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  TEAM_SIGNED_OUT_CODE,
  teamShare,
  teamShares,
  teamSessionId,
  teamTargets,
  teamUnshare,
  toCoworkTeamError,
  type TeamShare,
  type TeamShareTarget,
  type TeamShares,
  type TeamTargets,
} from "@/lib/cowork/team"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ownerInitial } from "@/components/cowork/shared-with-me-list"
import { useIsMobile } from "@/hooks/use-mobile"
import { noteTeamError, teamErrorText } from "@/lib/cowork/team-errors"
import { cn } from "@/lib/utils"

/** 回 `not_found`（会话刚建好）后多久自动重试一次。 */
export const SHARE_RETRY_MS = 3000

interface Candidate {
  key: string
  target: TeamShareTarget
  label: string
  /** 人的登录名；组是空字符串。 */
  sub: string
  isGroup: boolean
}

function shareKey(share: TeamShare): string {
  return share.type === "user" ? `u:${share.name}` : `g:${share.id}`
}

function shareTarget(share: TeamShare): TeamShareTarget {
  return share.type === "user"
    ? { type: "user", name: share.name }
    : { type: "group", id: share.id }
}

/** 候选：组在前、人在后；去掉自己和已经分享过的。 */
export function shareCandidates(
  targets: TeamTargets,
  shares: TeamShare[],
  me: string
): Candidate[] {
  const shared = new Set(shares.map(shareKey))
  const groups: Candidate[] = targets.groups.map((g) => ({
    key: `g:${g.id}`,
    target: { type: "group", id: g.id },
    label: g.name,
    sub: "",
    isGroup: true,
  }))
  const users: Candidate[] = targets.users
    .filter((u) => u.name !== me)
    .map((u) => ({
      key: `u:${u.name}`,
      target: { type: "user", name: u.name },
      label: u.label,
      sub: u.name,
      isGroup: false,
    }))
  return [...groups, ...users].filter((c) => !shared.has(c.key))
}

// 出错时记错误码，显示时按它写人话，不给员工看服务端原文。
type Notice = { kind: "error"; code: string } | { kind: "justCreated" } | null

export function ShareSessionDialog({
  open,
  onOpenChange,
  sessionId,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 契约里的会话号（十进制字符串，见 `teamSessionId`）。 */
  sessionId: string
  title: string
}) {
  const t = useTranslations("CoworkTeam")
  const me = useCoworkTeamStore((s) => s.status?.me.name ?? "")
  const available = useCoworkTeamStore((s) => s.available)
  const [targets, setTargets] = useState<TeamTargets | null>(null)
  const [shares, setSharesState] = useState<TeamShares | null>(null)
  // 拿到新的分享结果时顺手告诉顶栏的分享按钮分享给了几个对象（#1390）。
  const setShares = useCallback(
    (next: TeamShares) => {
      setSharesState(next)
      useCoworkTeamStore.getState().setShareCount(sessionId, next.shares.length)
    },
    [sessionId]
  )
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const alive = useRef(true)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  /** 等着的自动重试是不是一次「分享」（改勾选、说明只作废这一种）。 */
  const retryIsShare = useRef(false)
  /**
   * 勾选、说明每改一次加一。分享请求发出时记下它，请求回来时变了就不再
   * 自动重试：请求还在路上时改了勾选，等它回 not_found 再挂重试，就会按
   * 用户已经改掉的对象和说明分享出去。
   */
  const shareEdits = useRef(0)

  // 调用方常传每次渲染都新建的关闭回调（顶栏就是）：放进 ref 里用，免得
  // run / load 跟着变、对话框重新加载并把等着的自动重试取消掉。
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (retryTimer.current !== undefined) clearTimeout(retryTimer.current)
    }
  }, [])

  /** 作废等着的自动重试。 */
  const cancelRetry = useCallback(() => {
    if (retryTimer.current !== undefined) {
      clearTimeout(retryTimer.current)
      retryTimer.current = undefined
    }
    retryIsShare.current = false
  }, [])

  /** 用户改了勾选或说明：记一次改动；等着的是一次「分享」的自动重试时作废它。 */
  const cancelShareRetry = useCallback(() => {
    shareEdits.current += 1
    if (retryIsShare.current) cancelRetry()
  }, [cancelRetry])

  /**
   * 跑一个操作；回 `not_found` 且还能重试时，提示「刚建好」并 3 秒后再跑一次。
   * 成功返回 true。登录过期时入口整个收起，这里不再提示。
   */
  const run = useCallback(
    (
      op: () => Promise<void>,
      canRetry: boolean,
      isShare = false
    ): Promise<boolean> => {
      const editsAtStart = shareEdits.current
      const attempt = async (retry: boolean): Promise<boolean> => {
        setBusy(true)
        try {
          await op()
          if (!alive.current) return true
          setNotice(null)
          setBusy(false)
          return true
        } catch (err) {
          if (!alive.current) return false
          const e = toCoworkTeamError(err)
          setBusy(false)
          if (e.code === TEAM_SIGNED_OUT_CODE) {
            onOpenChangeRef.current(false)
            return false
          }
          if (e.code === "not_found") {
            // 专门提示照旧优先，原文也记一行方便排查。
            noteTeamError("share", e)
            setNotice({ kind: "justCreated" })
            // 分享发出以后用户改过勾选或说明：旧的对象不再重试。
            const stale = isShare && shareEdits.current !== editsAtStart
            if (retry && !stale) {
              if (retryTimer.current !== undefined)
                clearTimeout(retryTimer.current)
              retryIsShare.current = isShare
              retryTimer.current = setTimeout(() => {
                retryTimer.current = undefined
                retryIsShare.current = false
                if (alive.current) void attempt(false)
              }, SHARE_RETRY_MS)
            }
            return false
          }
          setNotice({ kind: "error", code: noteTeamError("share", e) })
          return false
        }
      }
      // 新操作一开始，之前等着的自动重试就作废：不然先「全部取消」遇到
      // not_found、接着只取消一个人，3 秒后旧的「全部取消」还会发出去。
      cancelRetry()
      return attempt(canRetry)
    },
    [cancelRetry]
  )

  const load = useCallback(
    () =>
      run(async () => {
        const [nextTargets, nextShares] = await Promise.all([
          teamTargets(),
          teamShares(sessionId),
        ])
        if (!alive.current) return
        setTargets(nextTargets)
        setShares(nextShares)
      }, true),
    [run, sessionId, setShares]
  )

  useEffect(() => {
    if (open && available) void load()
  }, [open, available, load])

  // 团队功能收起了（登录过期、开关关了）：对话框跟着关。
  useEffect(() => {
    if (open && !available) onOpenChange(false)
  }, [open, available, onOpenChange])

  const candidates = useMemo(
    () => (targets ? shareCandidates(targets, shares?.shares ?? [], me) : []),
    [targets, shares, me]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return candidates
    return candidates.filter(
      (c) =>
        c.label.toLocaleLowerCase().includes(needle) ||
        c.sub.toLocaleLowerCase().includes(needle)
    )
  }, [candidates, query])

  // 等自动重试分享时改了勾选或说明：重试会按第一次提交时的对象和说明发，
  // 不能再发出去（会分享给用户已经取消的人），作废它，让用户自己再点分享。
  const toggle = useCallback(
    (key: string) => {
      cancelShareRetry()
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    },
    [cancelShareRetry]
  )

  const picked = useMemo(
    () => candidates.filter((c) => selected.has(c.key)).map((c) => c.target),
    [candidates, selected]
  )

  const handleShare = useCallback(() => {
    if (picked.length === 0 || busy) return
    const trimmed = note.trim()
    // 成功（含 3 秒后自动重试成功）就清空勾选和说明、关掉对话框。
    void run(
      async () => {
        const next = await teamShare(sessionId, picked, trimmed || undefined)
        if (!alive.current) return
        setShares(next)
        setSelected(new Set())
        setNote("")
        onOpenChangeRef.current(false)
      },
      true,
      true
    )
  }, [picked, busy, note, run, sessionId, setShares])

  const handleUnshare = useCallback(
    (target?: TeamShareTarget) => {
      if (busy) return
      void run(async () => {
        const next = await teamUnshare(sessionId, target)
        if (alive.current) setShares(next)
      }, true)
    },
    [busy, run, sessionId, setShares]
  )

  const current = shares?.shares ?? []
  const loaded = targets !== null && shares !== null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-share-session-dialog="" closeLabel={t("dialogClose")}>
        <DialogHeader>
          <DialogTitle>{t("shareDialogTitle")}</DialogTitle>
          <DialogDescription className="break-words">
            {title || t("untitled")}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {t("shareDialogPrivacy")}
        </p>

        {notice ? (
          <p
            role="alert"
            data-share-notice={notice.kind}
            className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {notice.kind === "justCreated"
              ? t("shareJustCreated")
              : teamErrorText(notice.code, t)}
          </p>
        ) : null}

        {!loaded ? (
          <p className="text-xs text-muted-foreground">
            {t("sharedViewLoading")}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("shareSearchPlaceholder")}
                  aria-label={t("shareSearchPlaceholder")}
                  className="pl-8"
                />
              </div>
              <ul
                data-share-candidates=""
                className="max-h-48 overflow-y-auto rounded-lg border"
              >
                {visible.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-muted-foreground">
                    {t("shareNoCandidates")}
                  </li>
                ) : (
                  visible.map((c) => (
                    <li key={c.key}>
                      <label
                        data-share-candidate={c.key}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-[var(--g-hover)]"
                      >
                        <Checkbox
                          checked={selected.has(c.key)}
                          onCheckedChange={() => toggle(c.key)}
                          aria-label={c.label}
                        />
                        <span
                          aria-hidden
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium"
                        >
                          {c.isGroup ? (
                            <Users className="h-3 w-3" />
                          ) : (
                            ownerInitial(c.label)
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {c.label}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {c.isGroup ? t("shareGroupTag") : c.sub}
                        </span>
                      </label>
                    </li>
                  ))
                )}
              </ul>
              <Textarea
                value={note}
                onChange={(e) => {
                  cancelShareRetry()
                  setNote(e.target.value)
                }}
                placeholder={t("shareNotePlaceholder")}
                aria-label={t("shareNotePlaceholder")}
                className="min-h-12"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("shareCurrent")}
                </span>
                {current.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => handleUnshare()}
                  >
                    {t("shareRemoveAll")}
                  </Button>
                ) : null}
              </div>
              {current.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("shareNone")}
                </p>
              ) : (
                <ul data-share-current="" className="flex flex-col gap-1">
                  {current.map((share) => {
                    const label =
                      share.type === "user" ? share.label : share.name
                    return (
                      <li
                        key={shareKey(share)}
                        data-share-entry={shareKey(share)}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {label}
                          {share.type === "group" ? (
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              {t("shareGroupTag")}
                            </span>
                          ) : null}
                        </span>
                        {share.note ? (
                          <span className="min-w-0 max-w-[45%] truncate text-xs text-muted-foreground">
                            {share.note}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleUnshare(shareTarget(share))}
                          aria-label={t("shareRemove", { name: label })}
                          title={t("shareRemove", { name: label })}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--g-hover)] hover:text-foreground disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("shareCancel")}
          </Button>
          <Button
            disabled={!loaded || picked.length === 0 || busy}
            onClick={handleShare}
          >
            {t("shareConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 自己会话顶栏「更多」左边的「分享」按钮。团队功能不可用、会话还没有数字
 * 会话号（草稿）时不画。对话框打开时记下当时的会话：顶栏只有一个、跟着
 * 当前标签页换，对话框开着时切了标签也还是分享原来那个。
 */
export function ShareSessionButton({
  conversationId,
  title,
}: {
  conversationId: number | null
  title: string
}) {
  const t = useTranslations("CoworkTeam")
  const available = useCoworkTeamStore((s) => s.available)
  const sessionId = teamSessionId(conversationId)
  const [target, setTarget] = useState<{ id: string; title: string } | null>(
    null
  )
  // 手机端不做（#1235「不做什么」）：手机上也用这个顶栏，这里不画。
  const isMobile = useIsMobile()
  const show = available && sessionId !== null && !isMobile
  const shareCount = useCoworkTeamStore((s) =>
    sessionId === null ? null : (s.shareCounts[sessionId] ?? null)
  )

  // 按钮出现时问一次这个会话分享给了谁（#1390）：同一个会话这次打开期间只问
  // 一次（切标签回来不重问、不轮询），之后只靠对话框拿到的新结果更新。
  useEffect(() => {
    if (!show || sessionId === null) return
    const store = useCoworkTeamStore.getState()
    if (sessionId in store.shareCounts) return
    store.setShareCount(sessionId, null)
    teamShares(sessionId).then(
      (next) => {
        const now = useCoworkTeamStore.getState()
        // 期间对话框已经拿到更新的结果了，以它为准。
        if (now.shareCounts[sessionId] === null)
          now.setShareCount(sessionId, next.shares.length)
      },
      () => {}
    )
  }, [show, sessionId])

  const shared = typeof shareCount === "number" && shareCount > 0
  const label = shared
    ? t("shareButtonShared", { count: shareCount })
    : t("shareButton")
  return (
    <>
      {show ? (
        <button
          type="button"
          data-share-session-button=""
          className={cn(
            "flex h-7 shrink-0 items-center justify-center rounded-full text-[var(--ink2)] transition-colors hover:bg-[var(--g-hover)] hover:text-foreground",
            shared ? "gap-0.5 px-1.5" : "w-[1.875rem]"
          )}
          aria-label={label}
          title={label}
          onClick={() => setTarget({ id: sessionId, title })}
        >
          <Share2 className="h-4 w-4" />
          {shared ? (
            <span
              data-share-count=""
              aria-hidden
              className="text-[0.6875rem] tabular-nums"
            >
              {shareCount}
            </span>
          ) : null}
        </button>
      ) : null}
      {available && !isMobile && target ? (
        <ShareSessionDialog
          open
          onOpenChange={(o) => {
            if (!o) setTarget(null)
          }}
          sessionId={target.id}
          title={target.title}
        />
      ) : null}
    </>
  )
}
