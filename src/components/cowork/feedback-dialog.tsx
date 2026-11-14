"use client"

import { useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useCoworkText } from "@/lib/cowork/i18n"
import {
  isTelemetryOn,
  sendFeedback,
  subscribeTelemetry,
  type FeedbackContext,
} from "@/lib/telemetry"
import { useTabStore } from "@/stores/tab-store"

/** Whether this page sends telemetry (it starts after the first render). */
export function useTelemetryOn(): boolean {
  return useSyncExternalStore(subscribeTelemetry, isTelemetryOn, () => false)
}

/** The conversation in the focused tab, as the report names it. */
function openConversation(): FeedbackContext {
  const { rawTabs, activeTabId } = useTabStore.getState()
  const tab = rawTabs.find((t) => t.id === activeTabId)
  return {
    conversationId: tab?.conversationId ?? null,
    agent: tab?.agentType ?? null,
  }
}

/**
 * "Report a problem" (docs/telemetry.md §5.3): what the user writes goes to
 * Sentry with the open conversation's id; the versions and the connection's
 * state ride along. Offered only while telemetry is on.
 */
export function CoworkFeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useCoworkText()
  const [message, setMessage] = useState("")

  const submit = () => {
    if (sendFeedback(message, openConversation())) {
      toast.success(t("feedbackSent"))
      setMessage("")
      onOpenChange(false)
    } else {
      toast.error(t("feedbackNotSent"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("feedback")}</DialogTitle>
          <DialogDescription>{t("feedbackHint")}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("feedbackPlaceholder")}
          aria-label={t("feedback")}
          rows={6}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("feedbackCancel")}
          </Button>
          <Button disabled={!message.trim()} onClick={submit}>
            {t("feedbackSend")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
