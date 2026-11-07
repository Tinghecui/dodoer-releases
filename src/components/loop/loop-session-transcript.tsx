"use client"

/**
 * jenny fork: one agent session of a Loop stage, read from the agent's own
 * history and drawn the way a conversation's turns are drawn. Deliberately not
 * `MessageListView`: that one is bound to a conversation row and a live agent
 * connection, and a stage session has neither (see `SubagentSessionDialog`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import { CollapsibleUserMessage } from "@/components/message/collapsible-user-message"
import { CompletedTurnContent } from "@/components/message/completed-turn-content"
import { ContentPartsRenderer } from "@/components/message/content-parts-renderer"
import { DelegationStatusIndexProvider } from "@/components/message/delegation-status-index-context"
import { inProgressToolCallsByTurn } from "@/components/message/subagent-session-dialog"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { adaptMessageTurns } from "@/lib/adapters/ai-elements-adapter"
import { getLoopSessionPage } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { usePageHandoffName } from "@/lib/browser/use-page-handoff-name"
import {
  collectDelegationStatusTasks,
  createDelegationStatusIndexer,
} from "@/lib/delegation-status-index"
import type { AgentType, MessageTurn } from "@/lib/types"

/** A running stage appends all the time; a big file takes seconds to read, so
 *  the next read waits for the last one to come back. */
const LIVE_REFRESH_MS = 5000

interface Shown {
  firstIndex: number
  total: number
  omittedBlocks: number
  turns: MessageTurn[]
}

/** A fresh tail on top of the older turns already paged in. */
export function mergeTail(shown: Shown | null, tail: Shown): Shown {
  if (!shown || tail.firstIndex <= shown.firstIndex) return tail
  return {
    ...tail,
    firstIndex: shown.firstIndex,
    omittedBlocks: shown.omittedBlocks,
    turns: [
      ...shown.turns.slice(0, tail.firstIndex - shown.firstIndex),
      ...tail.turns,
    ],
  }
}

export function LoopSessionTranscript({
  agentType,
  sessionId,
  live,
  isActive,
}: {
  agentType: AgentType
  sessionId: string
  /** Keep re-reading: the session is still being written. */
  live: boolean
  /** The tab shows; a hidden tab doesn't read. */
  isActive: boolean
}) {
  const t = useTranslations("JennyLoop")
  const sharedT = useTranslations("Folder.chat.shared")
  const pageHandoffName = usePageHandoffName()
  const [shown, setShown] = useState<Shown | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const inFlight = useRef(false)

  const readTail = useCallback(
    async (fresh: boolean) => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const page = await getLoopSessionPage(agentType, sessionId, {
          live: fresh,
        })
        setShown((prev) =>
          mergeTail(prev, {
            firstIndex: page.firstIndex,
            total: page.totalTurns,
            omittedBlocks: page.omittedBlocks,
            turns: page.turns,
          })
        )
        setError(null)
      } catch (e) {
        // A read racing the agent's write fails now and then; what is on
        // screen stays, and the next tick very likely succeeds.
        setShown((prev) => {
          if (!prev) setError(toErrorMessage(e))
          return prev
        })
      } finally {
        inFlight.current = false
      }
    },
    [agentType, sessionId]
  )

  useEffect(() => {
    // The first read of this session; every state write lands after its await.
    void readTail(live)
  }, [readTail, live])

  useEffect(() => {
    if (!live || !isActive) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void readTail(true)
    }, LIVE_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [live, isActive, readTail])

  const showOlder = useCallback(async () => {
    if (!shown || shown.firstIndex === 0) return
    setLoadingOlder(true)
    try {
      const page = await getLoopSessionPage(agentType, sessionId, {
        before: shown.firstIndex,
      })
      setShown((prev) =>
        prev
          ? {
              ...prev,
              firstIndex: page.firstIndex,
              omittedBlocks: page.omittedBlocks,
              turns: [...page.turns, ...prev.turns],
            }
          : prev
      )
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setLoadingOlder(false)
    }
  }, [agentType, sessionId, shown])

  const messages = useMemo(
    () =>
      adaptMessageTurns(
        shown?.turns ?? [],
        {
          attachedResources: sharedT("attachedResources"),
          toolCallFailed: sharedT("toolCallFailed"),
          pageHandoffName,
        },
        undefined,
        live ? inProgressToolCallsByTurn(shown?.turns ?? []) : undefined
      ),
    [shown, sharedT, pageHandoffName, live]
  )
  const [indexDelegationStatus] = useState(() =>
    createDelegationStatusIndexer()
  )
  const delegationStatusIndex = useMemo(
    () =>
      indexDelegationStatus(
        messages.map((m) => collectDelegationStatusTasks(m.content))
      ),
    [indexDelegationStatus, messages]
  )

  if (!shown) {
    return error ? (
      <p
        className="px-1 py-2 text-xs text-muted-foreground"
        data-loop-session-unreadable={sessionId}
      >
        {t("sessionUnreadable")}
      </p>
    ) : (
      <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("sessionLoading")}
      </div>
    )
  }
  if (messages.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        {t("sessionEmpty")}
      </p>
    )
  }

  return (
    <DelegationStatusIndexProvider value={delegationStatusIndex}>
      <div className="flex flex-col gap-4" data-loop-session={sessionId}>
        {shown.firstIndex > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 self-center rounded-full text-xs text-muted-foreground"
            disabled={loadingOlder}
            onClick={() => void showOlder()}
          >
            {loadingOlder ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            {t("showEarlierTurns", { count: shown.firstIndex })}
          </Button>
        ) : null}
        {shown.omittedBlocks > 0 ? (
          <p className="self-center text-xs text-muted-foreground">
            {t("stepsOmitted", { count: shown.omittedBlocks })}
          </p>
        ) : null}
        {messages.map((message, i) => {
          const isLast = i === messages.length - 1
          if (message.role === "user") {
            return (
              <Message from="user" key={`${message.id}-${i}`}>
                <MessageContent>
                  <CollapsibleUserMessage parts={message.content} />
                </MessageContent>
              </Message>
            )
          }
          if (message.role === "assistant") {
            return (
              <Message from="assistant" key={`${message.id}-${i}`}>
                <MessageContent>
                  <CompletedTurnContent
                    parts={message.content}
                    durationMs={message.duration_ms}
                    completed={!(live && isLast)}
                  />
                </MessageContent>
              </Message>
            )
          }
          return (
            <ContentPartsRenderer
              key={`${message.id}-${i}`}
              parts={message.content}
              role="system"
            />
          )
        })}
      </div>
    </DelegationStatusIndexProvider>
  )
}
