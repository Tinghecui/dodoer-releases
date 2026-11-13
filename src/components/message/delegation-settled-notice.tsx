"use client"

import { useTranslations } from "next-intl"
import { ArrowUpRightIcon, CircleAlert, CircleCheckBig } from "lucide-react"

import { useSessionViewerHost } from "@/components/message/session-viewer-host-context"
import { useDelegationCardModel } from "@/hooks/use-delegation-card-model"
import type { SettledNoticeCandidate } from "@/lib/delegation-settled"

/**
 * Under a finished reply: "sub-task #a68323fc finished after this reply ended
 * — the agent hasn't seen the result", one line per task the reply handed off
 * and never saw end (`settledNoticeCandidates`), drawn only once the task HAS
 * ended — by the same card model the delegation row reads, so the two never
 * disagree. Nothing is drawn for a task still at work, or for one the user
 * canceled (that is not news to them). See `@/lib/delegation-settled`.
 */
export function DelegationSettledNotice({
  candidates,
}: {
  candidates: readonly SettledNoticeCandidate[]
}) {
  return (
    <>
      {candidates.map((candidate) => (
        <SettledLine key={candidate.taskId} candidate={candidate} />
      ))}
    </>
  )
}

function SettledLine({ candidate }: { candidate: SettledNoticeCandidate }) {
  const t = useTranslations("Folder.chat.delegation")
  const viewerHost = useSessionViewerHost()
  const { source, taskId } = candidate
  const model = useDelegationCardModel(source)
  if (!model.hasModel) return null
  const failed = model.status === "err"
  if (model.status !== "ok" && !failed) return null
  if (failed && model.errorCode === "canceled") return null
  const task = `#${taskId.slice(0, 8)}`
  const open =
    viewerHost && model.childConversationId != null
      ? () => viewerHost.open({ kind: "delegation", source })
      : null
  // `ws-msg-scope`: hairlines between messages, as the compaction divider's.
  return (
    <div
      role="status"
      data-testid="delegation-settled-notice"
      data-status={failed ? "failed" : "done"}
      className="ws-msg-scope flex items-center gap-3 px-1 py-2 text-xs text-muted-foreground/80"
    >
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border/70" />
      <div
        className={`flex min-w-0 items-center gap-1.5${failed ? " text-destructive/80" : ""}`}
      >
        {failed ? (
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        ) : (
          <CircleCheckBig aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span dir="auto">
          {t(failed ? "settledErr" : "settledOk", { task })}
        </span>
      </div>
      {open ? (
        <button
          type="button"
          onClick={open}
          className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-muted-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("openDetail")}
          <ArrowUpRightIcon
            aria-hidden="true"
            className="size-3.5 rtl:-scale-x-100"
          />
        </button>
      ) : null}
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border/70" />
    </div>
  )
}
