"use client"

// CoTeam 的会话分享（#1235 第 2 行）：在主区域只读查看同事的会话。
//
// 不新增标签页：`SharedSessionHost` 包在会话面板的内容外面，打开时只读视图
// 盖在上面，下面的会话照旧挂着（只是看不见、不能聚焦），收起后原样还在、
// 不重连。点侧栏里自己的会话、点任何标签、切到别的标签，视图就收起。
//
// 内容只来自 `entries`：打开时 `after` 给 -1，之后每 3 秒带上次最后一条的
// `seq` 增量拉；页面不可见时不拉，回到可见时马上补一次。`not_found`（对方
// 取消了分享、或者我已经不在这个组里）清空内容、不再拉。
//
// 这里没有任何能给对方智能体发话、停止、批准的控件。谁能看由服务端判断。
// 输入框的位置是留言输入（第 5 行），右侧一栏是这个会话的留言线程；每条记录
// 旁边能「对这条留言」。留言不会发给对方的智能体。
// 正文：提问、回复、思考、工具记录四种块都走现成的 markdown 渲染（带净化），
// 别人会话里的 HTML 不会原样插进页面。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Check, Eye, Link2, X } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { MessageResponse } from "@/components/ai-elements/message"
import { ConversationCornerReserve } from "@/components/layout/conversation-corner-reserve"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useOptionalWorkspaceActions } from "@/contexts/workspace-context"
import {
  TEAM_SIGNED_OUT_CODE,
  teamEntries,
  toCoworkTeamError,
  type TeamAgentInfo,
  type TeamEntry,
} from "@/lib/cowork/team"
import { formatTimeAgo } from "@/lib/relative-time"
import { cn, copyTextToClipboard } from "@/lib/utils"
import {
  CommentComposer,
  CommentOnEntryButton,
  CommentsSidebar,
  entryPreview,
  useSessionComments,
} from "@/components/cowork/session-comments"
import {
  useCoworkTeamStore,
  type SharedSessionTarget,
} from "@/stores/cowork-team-store"
import { useTabStore } from "@/stores/tab-store"

/** 只读视图多久增量拉一次。 */
export const SHARED_VIEW_POLL_MS = 3_000

/** 门户上这个会话的地址；没有门户地址时是 null（不画「复制链接」）。 */
export function sharedSessionPortalLink(
  portalUrl: string | null,
  owner: string,
  id: string
): string | null {
  const base = portalUrl?.trim().replace(/\/+$/, "")
  if (!base) return null
  return `${base}/s/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`
}

/**
 * 点到这些就收起只读视图：侧栏里自己的会话、标签栏里的标签。鼠标看
 * pointerdown；键盘回车、空格激活只发 click（激活本来就选中的那个时，活动
 * 标签也不变），所以 click 也看。
 */
const FOLD_ON_POINTER = "[data-conversation-id], [data-tab-id]"

/**
 * 会话面板内容的外壳：没在看同事的会话时原样画 children；在看时 children
 * 照旧挂着但藏起来，上面盖只读视图。
 */
export function SharedSessionHost({ children }: { children: ReactNode }) {
  const viewing = useCoworkTeamStore((s) => (s.available ? s.viewing : null))
  const close = useCoworkTeamStore((s) => s.closeSharedSession)
  const open = viewing !== null
  const openCount = useCoworkTeamStore((s) => s.openCount)
  const route = useOptionalWorkbenchRoute()
  const workspace = useOptionalWorkspaceActions()
  const openConversations = route?.openConversations
  const activateConversationPane = workspace?.activateConversationPane

  // 每次打开（换看另一个、开着时再点同一条也算）都先回到会话区域：停在
  // 自动化这类整页功能上时切回会话工作区；文件区铺满时放下它（和侧栏点
  // 自己的会话时一样），不然视图被盖在下面，看起来像点了没反应。
  useEffect(() => {
    if (!open) return
    openConversations?.()
    activateConversationPane?.()
  }, [open, openCount, openConversations, activateConversationPane])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest(FOLD_ON_POINTER)) close()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("click", onPointerDown, true)
    // 键盘切标签、新建会话这些不经过点击的，看当前标签变没变。
    const unsubscribe = useTabStore.subscribe((state, prev) => {
      if (state.activeTabId !== prev.activeTabId) close()
    })
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("click", onPointerDown, true)
      unsubscribe()
    }
  }, [open, close])

  return (
    <>
      <div
        className={cn(
          "h-full min-h-0",
          // 和「文件铺满区域」盖住会话时一样：不卸载、不改尺寸，只是不画。
          open && "conversation-tab-hidden invisible"
        )}
        inert={open || undefined}
      >
        {/* 下面会话里挂到 body 上的抽屉（子会话查看等）不在这个子树里，
            靠这个标记一起藏起来，不然会盖在只读视图上。 */}
        <OverlayHostHiddenProvider hidden={open}>
          {children}
        </OverlayHostHiddenProvider>
      </div>
      {viewing && (
        <SharedSessionView
          // 每点一次（再点同一条也算）重新挂一次：对方取消后又重新分享时，
          // 再点就重新拉、恢复轮询，不会一直停在「已取消分享」。
          key={`${viewing.owner}/${viewing.id}/${openCount}`}
          target={viewing}
          onClose={close}
        />
      )}
    </>
  )
}

function timeOf(raw: string): number {
  const at = Date.parse(raw)
  return Number.isFinite(at) ? at : 0
}

function SharedSessionView({
  target,
  onClose,
}: {
  target: SharedSessionTarget
  onClose: () => void
}) {
  const t = useTranslations("CoworkTeam")
  const locale = useLocale()
  const portalUrl = useCoworkTeamStore((s) => s.status?.portalUrl ?? null)
  const [entries, setEntries] = useState<TeamEntry[]>([])
  const [agent, setAgent] = useState<TeamAgentInfo | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [gone, setGone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 「几分钟前」的参照时间：每次拉到时更新（不在渲染时读时钟）。
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  const { owner, id } = target
  const comments = useSessionComments(owner, id, false)
  const setCommentTarget = comments.setTarget

  useEffect(() => {
    let alive = true
    let after = -1
    let inFlight = false
    let stopped = false
    const pull = () => {
      if (stopped || inFlight) return
      if (typeof document !== "undefined" && document.hidden) return
      inFlight = true
      teamEntries(owner, id, after).then(
        (page) => {
          inFlight = false
          if (!alive) return
          const fresh = page.entries
            .filter((entry) => entry.seq > after)
            .sort((a, b) => a.seq - b.seq)
          if (fresh.length > 0) {
            after = fresh[fresh.length - 1].seq
            setEntries((prev) => [...prev, ...fresh])
          }
          setAgent(page.agent)
          setLoaded(true)
          setError(null)
          setNow(Date.now())
        },
        (err: unknown) => {
          inFlight = false
          if (!alive) return
          const e = toCoworkTeamError(err)
          // 登录过期：store 已经收起入口，视图跟着关掉。
          if (e.code === TEAM_SIGNED_OUT_CODE) return
          if (e.code === "not_found") {
            stopped = true
            setEntries([])
            setAgent(null)
            setGone(true)
            return
          }
          setError(e.message || e.code)
        }
      )
    }
    pull()
    const timer = setInterval(pull, SHARED_VIEW_POLL_MS)
    const onVisibility = () => {
      if (!document.hidden) pull()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [owner, id])

  // 停在底部时，新内容进来跟着滚到底；往上翻着看时不打扰。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [entries])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  const ownerLabel = agent?.ownerLabel || target.ownerLabel || owner
  const title = agent?.title || target.title || t("untitled")
  const updatedAt = agent ? timeOf(agent.updatedAt) : 0
  const link = sharedSessionPortalLink(portalUrl, owner, id)
  const viaText =
    target.via.kind === "leader"
      ? t("sharedViewViaLeader", { group: target.via.groupName })
      : t("sharedViewViaShared", { owner: ownerLabel })
  const barText = [
    t("sharedViewReadOnly"),
    t("sharedViewSessionOf", { owner: ownerLabel }),
    viaText,
  ].join(" · ")

  const handleCopy = useCallback(() => {
    if (!link) return
    void copyTextToClipboard(link).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    })
  }, [link])

  return (
    <div
      data-shared-session-view={`${owner}/${id}`}
      role="region"
      aria-label={barText}
      className="absolute inset-0 z-20 flex flex-col bg-background ws-transparent-bg"
    >
      <header
        data-shared-session-bar=""
        className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-2"
      >
        {/* #1401：这一行落在窗口左上、右上角的浮动工具栏下面，像会话顶栏一样
            给它们留出位置，复制链接和关闭叉号才点得到。 */}
        <div className="flex min-w-0 items-center gap-2">
          <ConversationCornerReserve side="left" line={false} />
          <Eye
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-[0.75rem] text-muted-foreground">
            {barText}
          </span>
          {updatedAt > 0 && (
            <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
              {t("sharedViewUpdated", {
                ago: formatTimeAgo(updatedAt, now, locale),
              })}
            </span>
          )}
          {link && (
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.75rem] text-muted-foreground outline-none hover:bg-[var(--g-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copied ? (
                <Check aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {copied ? t("sharedViewLinkCopied") : t("sharedViewCopyLink")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("sharedViewClose")}
            title={t("sharedViewClose")}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-[var(--g-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          <ConversationCornerReserve side="right" line={false} />
        </div>
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="min-w-0 truncate text-[0.875rem] font-medium">
            {title}
          </h2>
          <span className="min-w-0 truncate text-[0.6875rem] text-muted-foreground">
            {t("sharedViewHint", { owner: ownerLabel })}
          </span>
        </div>
        {agent?.state === "waiting" && (
          <p
            data-shared-session-waiting=""
            className="text-[0.75rem] text-amber-600 dark:text-amber-400"
          >
            {t("sharedViewWaiting", { owner: ownerLabel })}
          </p>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
              {gone && (
                <p
                  data-shared-session-gone=""
                  className="py-8 text-center text-[0.8125rem] text-muted-foreground"
                >
                  {t("sharedViewGone")}
                </p>
              )}
              {!gone && error !== null && (
                <p className="break-words text-[0.75rem] text-destructive">
                  {t("sharedLoadFailed", { message: error })}
                </p>
              )}
              {!gone && !loaded && error === null && (
                <p className="py-8 text-center text-[0.8125rem] text-muted-foreground">
                  {t("sharedViewLoading")}
                </p>
              )}
              {!gone && loaded && entries.length === 0 && (
                <p className="py-8 text-center text-[0.8125rem] text-muted-foreground">
                  {t("sharedViewEmpty")}
                </p>
              )}
              {entries.map((entry) => (
                <div key={entry.seq} className="group/entry relative">
                  <SharedEntry entry={entry} />
                  <div className="absolute -top-1 end-0 opacity-0 group-hover/entry:opacity-100 focus-within:opacity-100">
                    <CommentOnEntryButton
                      onClick={() =>
                        setCommentTarget({
                          kind: "entry",
                          seq: entry.seq,
                          preview: entryPreview(entry.text),
                        })
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          {!gone && (
            <div className="shrink-0 border-t border-border">
              <div className="mx-auto w-full max-w-3xl px-4 py-3">
                <CommentComposer
                  api={comments}
                  placeholder={t("commentPlaceholder", { owner: ownerLabel })}
                />
              </div>
            </div>
          )}
        </div>
        {!gone && <CommentsSidebar api={comments} />}
      </div>
    </div>
  )
}

function SharedEntry({ entry }: { entry: TeamEntry }) {
  const t = useTranslations("CoworkTeam")
  switch (entry.kind) {
    case "user":
      return (
        <div data-shared-entry="user" className="flex justify-end">
          <div
            dir="auto"
            className="max-w-[85%] break-words rounded-2xl bg-muted px-3 py-2 text-[0.875rem]"
          >
            <MessageResponse>{entry.text}</MessageResponse>
          </div>
        </div>
      )
    case "assistant":
      return (
        <div data-shared-entry="assistant" className="text-[0.875rem]">
          <MessageResponse>{entry.text}</MessageResponse>
        </div>
      )
    case "thought":
      return (
        <div
          data-shared-entry="thought"
          className="border-s-2 border-border ps-3 text-[0.8125rem] text-muted-foreground"
        >
          <div className="mb-1 text-[0.6875rem] font-medium">
            {t("sharedViewThought")}
          </div>
          <MessageResponse>{entry.text}</MessageResponse>
        </div>
      )
    case "tool":
      return (
        <div
          data-shared-entry="tool"
          className="rounded-md bg-muted/50 px-3 py-1.5 text-[0.75rem] text-muted-foreground"
        >
          <div className="mb-0.5 text-[0.6875rem] font-medium">
            {t("sharedViewTool")}
          </div>
          <div className="break-words">
            <MessageResponse>{entry.text}</MessageResponse>
          </div>
        </div>
      )
  }
}
