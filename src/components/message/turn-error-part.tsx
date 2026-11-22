"use client"

import { createContext, useContext } from "react"
import { CircleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { getAgentLabel } from "@/lib/custom-agents"
import { useCoworkText } from "@/lib/cowork/i18n"
import { useCachedCoworkInfo } from "@/lib/cowork/info"
import {
  isSignInFailureText,
  openAgentSignIn,
  signInViaPortal,
} from "@/lib/cowork/sign-in"
import type { AgentType, TurnErrorKind } from "@/lib/types"

/**
 * Cowork fork: the transcript's agent, provided by `MessageListView`, so a
 * failure line deep in the thread can name it (a context for the same reason
 * as `ModelLabelContext`). Null where nothing provides it.
 */
const TurnErrorAgentContext = createContext<AgentType | null>(null)

export const TurnErrorAgentProvider = TurnErrorAgentContext.Provider

/**
 * Cowork 加的（#1120）：连接断了的那一轮的「重试」——重新连上智能体，再把这一轮
 * 的消息发一次。由会话面板给，只在对话最后一行正是这种失败、眼下能重试时
 * 不是 null；别的地方（只读的查看器、子任务）不给，就不画按钮。
 * `lineId` 是对话最后那一行失败的轮次 id：只有那一行画按钮，更早的同类失败行
 * 不画（点了重发的是最后那一轮的消息）。
 */
const TurnErrorRetryContext = createContext<{
  lineId: string
  retry: () => void
} | null>(null)

export const TurnErrorRetryProvider = TurnErrorRetryContext.Provider

/**
 * Cowork 加的（#1120 返工）：这一行失败是哪一轮（轮次 id），由消息列表给；
 * 不知道的（列表以外的地方）是 null，不画「重试」。
 */
const TurnErrorLineContext = createContext<string | null>(null)

export const TurnErrorLineProvider = TurnErrorLineContext.Provider

/**
 * A turn that FAILED, in the agent's own words ("stream disconnected before
 * completion: …", "API Error: 503 …"), as one muted line where the reply would
 * have been — never as a reply bubble, which would put the error in the
 * model's mouth. Live it is the failure the adapter reported; reopened, the
 * record the agent wrote of it.
 *
 * Cowork fork (#159): a record that says the agent is not signed in ("Not
 * logged in · Please run /login") reads as the sentence the live turn showed —
 * the localized "sign in again, then resend" — with the agent's words kept in
 * the tooltip, and a link to where the agent signs in (#158).
 *
 * Cowork 加的（#1120）：连接断了的失败（`kind` 是 `connection_lost`，底下的
 * CLI 被杀、崩了）同样换成本地化的说明，原话放进悬停提示，后面一个「重试」
 * （见 `TurnErrorRetryContext`）。
 */
export function TurnErrorPart({
  message,
  kind,
}: {
  message: string
  kind?: TurnErrorKind | null
}) {
  const t = useTranslations("Folder.chat.messageList")
  const tErrors = useTranslations("Folder.chat.acpConnections")
  const tFailure = useTranslations("Folder.chat.sessionFailure")
  const coworkT = useCoworkText()
  const coworkInfo = useCachedCoworkInfo()
  const agentType = useContext(TurnErrorAgentContext)
  const retryLine = useContext(TurnErrorRetryContext)
  const lineId = useContext(TurnErrorLineContext)
  const retry =
    retryLine != null && lineId != null && retryLine.lineId === lineId
      ? retryLine.retry
      : null
  const agent = agentType != null ? getAgentLabel(agentType) : null
  const lost = kind === "connection_lost"
  const signIn = !lost && agent != null && isSignInFailureText(message)
  const portal = signIn && signInViaPortal(agentType, coworkInfo)
  const shown = lost
    ? coworkT("turnFailedConnectionLost", {
        agent: agent ?? coworkT("turnFailedTheAgent"),
      })
    : agent == null || !signIn
      ? message
      : portal
        ? coworkT("turnFailedAuthRequiredPortal", { agent })
        : tErrors("backendErrors.turnFailedAuthRequired", { agent })
  return (
    <div
      role="note"
      data-testid="turn-error"
      className="flex items-start gap-1.5 text-xs text-muted-foreground"
    >
      <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive/70" />
      <p
        className="min-w-0 whitespace-pre-wrap wrap-break-word"
        title={signIn || lost ? message : undefined}
      >
        {t("turnFailed", { message: shown })}
        {signIn && (
          <>
            {" "}
            <button
              type="button"
              data-turn-error-sign-in=""
              onClick={() => openAgentSignIn(agentType)}
              className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
            >
              {portal ? coworkT("signInViaPortal") : tFailure("action.login")}
            </button>
          </>
        )}
        {lost && retry && (
          <>
            {" "}
            <button
              type="button"
              data-turn-error-retry=""
              onClick={retry}
              className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
            >
              {coworkT("turnFailedRetry")}
            </button>
          </>
        )}
      </p>
    </div>
  )
}
