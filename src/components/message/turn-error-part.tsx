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
import type { AgentType } from "@/lib/types"

/**
 * Cowork fork: the transcript's agent, provided by `MessageListView`, so a
 * failure line deep in the thread can name it (a context for the same reason
 * as `ModelLabelContext`). Null where nothing provides it.
 */
const TurnErrorAgentContext = createContext<AgentType | null>(null)

export const TurnErrorAgentProvider = TurnErrorAgentContext.Provider

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
 */
export function TurnErrorPart({ message }: { message: string }) {
  const t = useTranslations("Folder.chat.messageList")
  const tErrors = useTranslations("Folder.chat.acpConnections")
  const tFailure = useTranslations("Folder.chat.sessionFailure")
  const coworkT = useCoworkText()
  const coworkInfo = useCachedCoworkInfo()
  const agentType = useContext(TurnErrorAgentContext)
  const agent = agentType != null ? getAgentLabel(agentType) : null
  const signIn = agent != null && isSignInFailureText(message)
  const portal = signIn && signInViaPortal(agentType, coworkInfo)
  const shown =
    agent == null || !signIn
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
        title={signIn ? message : undefined}
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
      </p>
    </div>
  )
}
