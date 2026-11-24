"use client"

// CoTeam 的会话留言（#1235 第 5 行）：
// - 只读看同事会话时：底部的留言输入（不会发给对方的智能体）和右侧的留言栏；
// - 自己的会话：顶栏的「留言」入口（有新留言时写「留言（N 条新）」）、右侧
//   留言栏，每条留言上「交给我的智能体」把它放进这个会话的排队区。
//
// 留言只在这几个时候拉一次 `comments`（不另起轮询）：打开留言栏或只读视图时、
// 自己发了或删了一条之后、`summary` 每次轮询回来这个会话还有未读留言时（条数
// 和上次一样也重拉）。拉到之后调一次 `comments_seen`。不算我未读的留言（比如
// 只读视图里别人写给主人的）不会触发重拉，要重新打开才看到。
//
// 别人写的字（留言正文、名字、记录开头）一律按纯文字画。交给智能体的文字只来自
// 主人点的那一条留言，前面加一行固定的来源说明；留言不会自己进智能体。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Bot,
  Check,
  CornerDownRight,
  MessageSquare,
  Trash2,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { create } from "zustand"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  TEAM_SIGNED_OUT_CODE,
  teamCommentAdd,
  teamCommentDelete,
  teamCommentForwarded,
  teamComments,
  teamCommentsSeen,
  teamSessionId,
  toCoworkTeamError,
  type TeamComment,
  type TeamCommentsPage,
  type CoworkTeamSummary,
} from "@/lib/cowork/team"
import { noteTeamError, teamErrorText } from "@/lib/cowork/team-errors"
import {
  loadMessageInputDraft,
  saveMessageInputDraft,
} from "@/lib/message-input-draft"
import { cn } from "@/lib/utils"
import {
  useCoworkTeamAvailable,
  useCoworkTeamStore,
} from "@/stores/cowork-team-store"

// ─── 交给智能体的文字 ───────────────────────────────────────────────────────

/**
 * 交给智能体的那条消息：固定的来源说明、空一行、留言原文（#1230 定的固定
 * 说明，给智能体看，不随界面语言变）。
 */
export function forwardedCommentText(
  authorLabel: string,
  body: string
): string {
  return `以下是同事 ${authorLabel} 在这个会话上的留言，由我转给你：\n\n${body}`
}

// ─── 自己会话的留言栏开没开、哪些已经交给了智能体 ─────────────────────────

interface OwnCommentsState {
  /** 打开着留言栏的自己的会话（契约里的会话号）；没开是 null。 */
  openFor: string | null
  /** 这次打开期间已经交给智能体的留言：`<会话号>/<留言 id>`。 */
  forwarded: Record<string, true>
  open: (id: string) => void
  close: () => void
  markForwarded: (id: string, commentId: string) => void
  reset: () => void
}

export const useOwnCommentsStore = create<OwnCommentsState>((set) => ({
  openFor: null,
  forwarded: {},
  open: (id) => set({ openFor: id }),
  close: () => set((s) => (s.openFor ? { openFor: null } : {})),
  markForwarded: (id, commentId) =>
    set((s) => ({
      forwarded: { ...s.forwarded, [`${id}/${commentId}`]: true },
    })),
  reset: () => set({ openFor: null, forwarded: {} }),
}))

/** 收件箱等处用：打开自己某个会话的留言栏（会话本身由调用方切过去）。 */
export function openOwnSessionComments(conversationId: unknown): void {
  const id = teamSessionId(conversationId)
  if (id) useOwnCommentsStore.getState().open(id)
}

/** `summary` 里这个会话还有几条未读留言。 */
function unreadIn(
  summary: CoworkTeamSummary | null,
  owner: string,
  id: string,
  mine: boolean
): number {
  const sessions = summary?.commentUnread.sessions ?? []
  const hit = sessions.find(
    (x) => x.id === id && (mine ? x.mine : x.owner === owner)
  )
  return hit?.count ?? 0
}

/** `summary` 里这个会话还有几条未读留言。 */
function useUnreadCount(owner: string, id: string, mine: boolean): number {
  return useCoworkTeamStore((s) => unreadIn(s.summary, owner, id, mine))
}

/**
 * 这个会话有未读留言时返回那一次的 `summary`（每次轮询都是新对象），没有时是
 * null。拉到留言后已经标了已读，下一次轮询还说有未读，就是又来了新的——哪怕
 * 条数和上次一样，也要重拉。
 */
function useUnreadSummary(
  owner: string,
  id: string,
  mine: boolean
): CoworkTeamSummary | null {
  return useCoworkTeamStore((s) =>
    unreadIn(s.summary, owner, id, mine) > 0 ? s.summary : null
  )
}

// ─── 拉留言、发留言 ─────────────────────────────────────────────────────────

/** 正在对哪条记录、或回复哪条留言写。 */
export type CommentTarget =
  | { kind: "entry"; seq: number; preview: string }
  | { kind: "reply"; commentId: string; authorLabel: string }

/** 发送或删除留言失败：哪一种、错误码（显示时按它写人话）。 */
interface CommentActionError {
  kind: "add" | "delete"
  code: string
}

interface SessionCommentsApi {
  /** 这个会话留言框的草稿存哪（带上当前团队账号，见 commentDraftKey），切走再回来、刷新后还在。 */
  draftKey: string
  page: TeamCommentsPage | null
  /** 拉留言失败的错误码；没出错是 null。 */
  error: string | null
  target: CommentTarget | null
  setTarget: (target: CommentTarget | null) => void
  add: (body: string) => Promise<boolean>
  addError: CommentActionError | null
  sending: boolean
  remove: (commentId: string) => void
}

/** 留言草稿属于哪个团队账号：门户地址 + 我的账号名。 */
export interface CommentDraftViewer {
  name: string
  portalUrl: string | null
}

/**
 * 留言草稿的键。前缀不用 `draft:`：那是新会话草稿的前缀，清理孤儿草稿时
 * 只扫它，留言草稿不能被顺手删掉。键里带上当前团队账号（门户地址和我的
 * 账号名）：同一台机器换了账号，就算会话的 owner/id 一样，也看不到上一个
 * 账号没发的留言，不会被误发到别的账号的会话里。
 */
export function commentDraftKey(
  viewer: CommentDraftViewer,
  owner: string,
  id: string
): string {
  const account = `${encodeURIComponent(viewer.portalUrl ?? "")}|${encodeURIComponent(viewer.name)}`
  return `comment:${account}:${owner}/${id}`
}

/**
 * 一个会话的留言：挂上时拉一次、之后每次 `summary` 轮询回来这个会话还有未读
 * 就再拉一次，拉到后调 `comments_seen`。`mine` = 这是我自己的会话。
 */
export function useSessionComments(
  owner: string,
  id: string,
  mine: boolean
): SessionCommentsApi {
  const [page, setPage] = useState<TeamCommentsPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTargetState] = useState<CommentTarget | null>(null)
  const [addError, setAddError] = useState<CommentActionError | null>(null)
  const [sending, setSending] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const unreadSummary = useUnreadSummary(owner, id, mine)
  const seenSummary = useRef(unreadSummary)
  const alive = useRef(true)
  // 发送那一刻的目标；发送期间用户改选了别的，成功后不能把新选的清掉。
  const targetRef = useRef<CommentTarget | null>(null)
  const setTarget = useCallback((next: CommentTarget | null) => {
    targetRef.current = next
    setTargetState(next)
  }, [])

  // 轮询到这个会话还有未读（新的一次 summary）就重拉；挂上时那一次不算，
  // 下面的 effect 本来就会拉。
  useEffect(() => {
    if (unreadSummary === seenSummary.current) return
    seenSummary.current = unreadSummary
    if (unreadSummary) setReloadKey((k) => k + 1)
  }, [unreadSummary])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!owner || !id) return
    let current = true
    teamComments(owner, id, 0).then(
      (next) => {
        if (!current) return
        setPage(next)
        setError(null)
        void teamCommentsSeen(owner, id).catch(() => {})
      },
      (err: unknown) => {
        if (!current) return
        const e = toCoworkTeamError(err)
        if (e.code === TEAM_SIGNED_OUT_CODE) return
        setError(noteTeamError("comments", e))
      }
    )
    return () => {
      current = false
    }
    // reloadKey：自己发删之后、轮询到新留言时重新拉（只更新留言栏和提示）。
  }, [owner, id, reloadKey])

  const add = useCallback(
    async (body: string) => {
      const text = body.trim()
      if (!text) return false
      setSending(true)
      setAddError(null)
      const sentTarget = target
      const options: { seq?: number; replyTo?: string } = {}
      if (sentTarget?.kind === "entry") options.seq = sentTarget.seq
      if (sentTarget?.kind === "reply") options.replyTo = sentTarget.commentId
      try {
        await teamCommentAdd(owner, id, text, options)
        if (!alive.current) return true
        // 只清掉这次发出去的目标；发送期间改选的新目标留着。
        if (targetRef.current === sentTarget) setTarget(null)
        setReloadKey((k) => k + 1)
        return true
      } catch (err) {
        if (alive.current) {
          const e = toCoworkTeamError(err)
          setAddError({ kind: "add", code: noteTeamError("comment_add", e) })
        }
        return false
      } finally {
        if (alive.current) setSending(false)
      }
    },
    [owner, id, target, setTarget]
  )

  const remove = useCallback(
    (commentId: string) => {
      teamCommentDelete(owner, id, commentId).then(
        () => {
          if (alive.current) setReloadKey((k) => k + 1)
        },
        (err: unknown) => {
          if (!alive.current) return
          const e = toCoworkTeamError(err)
          setAddError({
            kind: "delete",
            code: noteTeamError("comment_delete", e),
          })
        }
      )
    },
    [owner, id]
  )

  const viewerName = useCoworkTeamStore((s) => s.status?.me.name ?? "")
  const viewerPortal = useCoworkTeamStore((s) => s.status?.portalUrl ?? null)
  const draftKey = commentDraftKey(
    { name: viewerName, portalUrl: viewerPortal },
    owner,
    id
  )
  return {
    draftKey,
    page,
    error,
    target,
    setTarget,
    add,
    addError,
    sending,
    remove,
  }
}

// ─── 留言列表 ───────────────────────────────────────────────────────────────

function byTime(a: TeamComment, b: TeamComment): number {
  const at = Date.parse(a.createdAt) || 0
  const bt = Date.parse(b.createdAt) || 0
  return at - bt
}

/** 顶层留言按时间排，回复挂在它下面；父留言已经没了的回复当顶层。 */
export function commentThreads(
  comments: TeamComment[]
): { comment: TeamComment; replies: TeamComment[] }[] {
  const ids = new Set(comments.map((c) => c.id))
  const tops = comments
    .filter((c) => !c.parentId || !ids.has(c.parentId))
    .sort(byTime)
  return tops.map((comment) => ({
    comment,
    replies: comments.filter((c) => c.parentId === comment.id).sort(byTime),
  }))
}

function CommentItem({
  comment,
  reply,
  onReply,
  onDelete,
  forward,
}: {
  comment: TeamComment
  reply: boolean
  onReply?: () => void
  onDelete: () => void
  forward?: ReactNode
}) {
  const t = useTranslations("CoworkTeam")
  const author = comment.former
    ? `${comment.authorLabel} ${t("commentFormer")}`
    : comment.authorLabel
  return (
    <li
      data-comment-id={comment.id}
      className={cn("flex flex-col gap-1", reply && "ms-4")}
    >
      {!reply && comment.anchor && (
        <p
          data-comment-anchor=""
          className="truncate border-s-2 border-border ps-2 text-[0.6875rem] text-muted-foreground"
        >
          {t("commentAnchor", { text: comment.anchor })}
        </p>
      )}
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-[0.75rem] font-medium">
          {author}
        </span>
      </div>
      <p
        data-comment-body=""
        dir="auto"
        className="whitespace-pre-wrap break-words text-[0.8125rem]"
      >
        {comment.body}
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {onReply && (
          <button
            type="button"
            onClick={onReply}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.6875rem] text-muted-foreground hover:bg-[var(--g-hover)] hover:text-foreground"
          >
            <CornerDownRight aria-hidden="true" className="h-3 w-3" />
            {t("commentReply")}
          </button>
        )}
        {comment.canDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.6875rem] text-muted-foreground hover:bg-[var(--g-hover)] hover:text-destructive"
          >
            <Trash2 aria-hidden="true" className="h-3 w-3" />
            {t("commentDelete")}
          </button>
        )}
        {forward}
      </div>
    </li>
  )
}

/** 留言栏里的列表；`renderForward` 给出每条留言上的「交给我的智能体」。 */
export function CommentThreadList({
  api,
  renderForward,
}: {
  api: SessionCommentsApi
  renderForward?: (comment: TeamComment) => ReactNode
}) {
  const t = useTranslations("CoworkTeam")
  const threads = useMemo(
    () => commentThreads(api.page?.comments ?? []),
    [api.page]
  )
  if (api.error !== null && api.page === null) {
    return (
      <p className="break-words text-[0.75rem] text-destructive">
        {t("sharedLoadFailed", { message: teamErrorText(api.error, t) })}
      </p>
    )
  }
  if (api.page === null) {
    return (
      <p className="text-[0.75rem] text-muted-foreground">
        {t("sharedViewLoading")}
      </p>
    )
  }
  if (threads.length === 0) {
    return (
      <p className="text-[0.75rem] text-muted-foreground">
        {t("commentsEmpty")}
      </p>
    )
  }
  return (
    <ul data-comment-list="" className="flex flex-col gap-3">
      {threads.map(({ comment, replies }) => (
        <li key={comment.id} className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            <CommentItem
              comment={comment}
              reply={false}
              onReply={() =>
                api.setTarget({
                  kind: "reply",
                  commentId: comment.id,
                  authorLabel: comment.authorLabel,
                })
              }
              onDelete={() => api.remove(comment.id)}
              forward={renderForward?.(comment)}
            />
            {replies.map((r) => (
              <CommentItem
                key={r.id}
                comment={r}
                reply
                onDelete={() => api.remove(r.id)}
                forward={renderForward?.(r)}
              />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

/**
 * 正挂着的留言框按草稿键登记：发送完成时，同一会话所有挂着的留言框（包括
 * 发送中切走、又重新打开的那个新留言框）都要去掉已发出的那段。
 */
const commentDraftListeners = new Map<
  string,
  Set<(shrink: (cur: string) => string) => void>
>()

/**
 * 正在发的留言按草稿键记数：发送中切走又打开同一会话时，新留言框自己的
 * 「发送中」是空闲的，要靠这里知道上一个还没发完，不能让同一段字再发一次。
 */
const commentSendsInFlight = new Map<string, number>()

function notifyCommentDraft(key: string, shrink: (cur: string) => string) {
  for (const listener of commentDraftListeners.get(key) ?? []) {
    listener(shrink)
  }
}

/**
 * 留言输入：Enter 换行，Ctrl/⌘+Enter 或按钮发送。发失败时文字留着，按错误码
 * 说人话（发送失败「没发出去：」，删除失败「没删掉：」）。
 */
export function CommentComposer({
  api,
  placeholder,
}: {
  api: SessionCommentsApi
  placeholder: string
}) {
  const t = useTranslations("CoworkTeam")
  const draftKey = api.draftKey
  // 没发出去的字按会话存成草稿：只读视图切走会整个卸载，回来要还在。
  const [draft, setDraft] = useState(() => ({
    key: draftKey,
    text: loadMessageInputDraft(draftKey) ?? "",
  }))
  // 同一个输入框换了会话：换成那个会话自己的草稿。
  const current =
    draft.key === draftKey
      ? draft
      : { key: draftKey, text: loadMessageInputDraft(draftKey) ?? "" }
  if (current !== draft) setDraft(current)
  const text = current.text
  const setText = useCallback((key: string, next: (cur: string) => string) => {
    setDraft((prev) => {
      if (prev.key !== key) return prev
      const value = next(prev.text)
      saveMessageInputDraft(key, value)
      return { key, text: value }
    })
  }, [])
  useEffect(() => {
    const listener = (shrink: (cur: string) => string) =>
      setText(draftKey, shrink)
    let set = commentDraftListeners.get(draftKey)
    if (!set) {
      set = new Set()
      commentDraftListeners.set(draftKey, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) commentDraftListeners.delete(draftKey)
    }
  }, [draftKey, setText])
  const sending = api.sending || commentSendsInFlight.has(draftKey)
  const send = useCallback(() => {
    if (api.sending || commentSendsInFlight.has(draftKey) || !text.trim())
      return
    const sent = text
    const key = draftKey
    commentSendsInFlight.set(key, (commentSendsInFlight.get(key) ?? 0) + 1)
    // 让同一会话别的留言框也重画一次，按钮跟着变成不能点。
    notifyCommentDraft(key, (cur) => cur)
    void api.add(sent).then((ok) => {
      const left = (commentSendsInFlight.get(key) ?? 1) - 1
      if (left > 0) commentSendsInFlight.set(key, left)
      else commentSendsInFlight.delete(key)
      if (!ok) {
        // 没发出去：字留着，按钮恢复能点。
        notifyCommentDraft(key, (cur) => cur)
        return
      }
      // 发送期间输入框还能写：只去掉已经发出去的那段，后来写的留着。
      // 已经卸载（切走了）时组件状态不会再更新，直接改存着的草稿；发送中
      // 切走又打开的新留言框已经读进了旧草稿，也要通知它去掉。
      const shrink = (cur: string) => {
        if (cur === sent) return ""
        if (cur.startsWith(sent)) return cur.slice(sent.length).trimStart()
        return cur
      }
      saveMessageInputDraft(key, shrink(loadMessageInputDraft(key) ?? ""))
      notifyCommentDraft(key, shrink)
    })
  }, [api, text, draftKey])
  const target = api.target
  return (
    <div data-comment-composer="" className="flex flex-col gap-1.5">
      {target && (
        <div className="flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted-foreground">
          <span data-comment-target="" className="min-w-0 flex-1 truncate">
            {target.kind === "entry"
              ? t("commentOnEntry", { text: target.preview })
              : t("commentReplyingTo", { name: target.authorLabel })}
          </span>
          <button
            type="button"
            onClick={() => api.setTarget(null)}
            aria-label={t("commentCancelTarget")}
            title={t("commentCancelTarget")}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--g-hover)]"
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => {
            const value = e.target.value
            setText(draftKey, () => value)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={2}
          className="min-h-0 flex-1 resize-none text-[0.8125rem]"
        />
        <Button
          type="button"
          size="sm"
          onClick={send}
          disabled={sending || !text.trim()}
        >
          {t("commentSend")}
        </Button>
      </div>
      {api.addError !== null && (
        <p className="break-words text-[0.75rem] text-destructive">
          {t(
            api.addError.kind === "delete"
              ? "commentDeleteFailed"
              : "commentAddFailed",
            { message: teamErrorText(api.addError.code, t) }
          )}
        </p>
      )}
    </div>
  )
}

/** 只读视图里每条记录旁边的「对这条留言」。 */
export function CommentOnEntryButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations("CoworkTeam")
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("commentOnThisEntry")}
      title={t("commentOnThisEntry")}
      data-comment-on-entry=""
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-[var(--g-hover)] hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
    >
      <MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
  )
}

/** 记录开头：留言输入上方「对这条记录留言：…」用。 */
export function entryPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

// ─── 自己会话：顶栏入口和留言栏 ─────────────────────────────────────────────

/**
 * 自己会话顶栏的「留言」：团队功能可用、会话有数字号时才有；有新留言时写
 * 「留言（N 条新）」。点了打开（再点收起）右侧留言栏。
 */
export function SessionCommentsButton({
  conversationId,
}: {
  conversationId: unknown
}) {
  const t = useTranslations("CoworkTeam")
  const available = useCoworkTeamAvailable()
  const isMobile = useIsMobile()
  const me = useCoworkTeamStore((s) => s.status?.me.name ?? "")
  const id = teamSessionId(conversationId)
  const unread = useUnreadCount(me, id ?? "", true)
  const openFor = useOwnCommentsStore((s) => s.openFor)
  if (!available || !id || isMobile) return null
  const isOpen = openFor === id
  const label =
    unread > 0 ? t("commentsButtonNew", { count: unread }) : t("commentsButton")
  return (
    <button
      type="button"
      data-session-comments-button=""
      aria-pressed={isOpen}
      title={label}
      aria-label={label}
      onClick={() => {
        const store = useOwnCommentsStore.getState()
        if (isOpen) store.close()
        else store.open(id)
      }}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[0.75rem] text-muted-foreground outline-none hover:bg-[var(--g-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        isOpen && "bg-[var(--g-hover)] text-foreground",
        unread > 0 && "text-primary"
      )}
    >
      <MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />
      {unread > 0 && <span>{label}</span>}
    </button>
  )
}

/**
 * 自己会话右侧的留言栏：只在这个会话是当前会话、留言栏对它开着时画。
 * `onForward` 是这个会话的排队区入队（和实时反馈重发用同一个）。
 */
export function OwnSessionComments({
  conversationId,
  isActive,
  onForward,
}: {
  conversationId: unknown
  isActive: boolean
  onForward: (text: string) => void
}) {
  const available = useCoworkTeamAvailable()
  const me = useCoworkTeamStore((s) => s.status?.me.name ?? "")
  const id = teamSessionId(conversationId)
  const openFor = useOwnCommentsStore((s) => s.openFor)
  if (!available || !id || !me || !isActive || openFor !== id) return null
  return <OwnSessionCommentsPanel owner={me} id={id} onForward={onForward} />
}

function OwnSessionCommentsPanel({
  owner,
  id,
  onForward,
}: {
  owner: string
  id: string
  onForward: (text: string) => void
}) {
  const t = useTranslations("CoworkTeam")
  const api = useSessionComments(owner, id, true)
  const forwarded = useOwnCommentsStore((s) => s.forwarded)
  const isOwner = api.page?.isOwner === true

  const forward = useCallback(
    (comment: TeamComment) => {
      const store = useOwnCommentsStore.getState()
      if (store.forwarded[`${id}/${comment.id}`]) return
      // 先记下来再入队：连点两下也只进一次排队区。
      store.markForwarded(id, comment.id)
      onForward(forwardedCommentText(comment.authorLabel, comment.body))
      void teamCommentForwarded(id, comment.id).catch(() => {})
    },
    [id, onForward]
  )

  const renderForward = useCallback(
    (comment: TeamComment) => {
      if (!isOwner) return null
      const done = forwarded[`${id}/${comment.id}`] === true
      return (
        <button
          type="button"
          data-comment-forward=""
          disabled={done}
          onClick={() => forward(comment)}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.6875rem] text-muted-foreground hover:bg-[var(--g-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
        >
          {done ? (
            <Check aria-hidden="true" className="h-3 w-3" />
          ) : (
            <Bot aria-hidden="true" className="h-3 w-3" />
          )}
          {done ? t("commentForwarded") : t("commentForward")}
        </button>
      )
    },
    [isOwner, forwarded, id, forward, t]
  )

  return (
    <CommentsSidebar
      api={api}
      placeholder={t("commentPlaceholderOwn")}
      renderForward={renderForward}
      onClose={() => useOwnCommentsStore.getState().close()}
      className="absolute inset-y-0 end-0 z-30 pt-[var(--glass-top-inset,3.25rem)]"
    />
  )
}

/** 右侧留言栏的外壳：标题、列表，`placeholder` 给了时底部带输入。 */
export function CommentsSidebar({
  api,
  placeholder,
  renderForward,
  onClose,
  className,
}: {
  api: SessionCommentsApi
  placeholder?: string
  renderForward?: (comment: TeamComment) => ReactNode
  onClose?: () => void
  className?: string
}) {
  const t = useTranslations("CoworkTeam")
  return (
    <aside
      data-comments-sidebar=""
      aria-label={t("commentsTitle")}
      className={cn(
        "flex w-72 shrink-0 flex-col border-s border-border bg-background",
        className
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <MessageSquare
          aria-hidden="true"
          className="h-3.5 w-3.5 text-muted-foreground"
        />
        <span className="flex-1 text-[0.8125rem] font-medium">
          {t("commentsTitle")}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("commentsClose")}
            title={t("commentsClose")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--g-hover)] hover:text-foreground"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <CommentThreadList api={api} renderForward={renderForward} />
      </div>
      {placeholder && (
        <div className="shrink-0 border-t border-border p-3">
          <CommentComposer api={api} placeholder={placeholder} />
        </div>
      )}
    </aside>
  )
}
