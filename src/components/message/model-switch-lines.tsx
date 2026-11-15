"use client"

import { ArrowLeftRight, CircleAlert } from "lucide-react"
import { useLocale } from "next-intl"
import { useCoworkText } from "@/lib/cowork/i18n"
import { modelSwitchSentence, modelSwitchTime } from "@/lib/cowork/model-switch"
import type { ModelSwitchInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Cowork fork: settled model switches as lines between a conversation's
 * messages — "Model switched: Opus → Fable (from the next message) · 14:02",
 * or the failure and the model still in use (see `model-switch.ts`). A
 * chrome-less divider like the compaction one: not a message, so no avatar.
 */
export function ModelSwitchLines({
  switches,
}: {
  switches: readonly ModelSwitchInfo[]
}) {
  const t = useCoworkText()
  const locale = useLocale()
  if (switches.length === 0) return null
  return (
    <div className="flex flex-col gap-1 px-1 py-2">
      {switches.map((s) => {
        const sentence = modelSwitchSentence(t, s)
        const time = modelSwitchTime(s.at, locale)
        const failed = s.phase === "failed"
        const Icon = failed ? CircleAlert : ArrowLeftRight
        return (
          <div
            key={s.id}
            role="note"
            data-slot="model-switch-line"
            data-phase={s.phase}
            title={time ? `${sentence} · ${time}` : sentence}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span aria-hidden className="h-px flex-1 bg-border" />
            <span
              className={cn(
                "flex min-w-0 max-w-[85%] items-center gap-1 rounded-full border px-2 py-0.5",
                failed
                  ? "border-destructive/30 bg-destructive/5 text-destructive"
                  : "border-border bg-muted/50"
              )}
            >
              <Icon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{sentence}</span>
              {time ? (
                <span className="shrink-0 tabular-nums opacity-70">
                  · {time}
                </span>
              ) : null}
            </span>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>
        )
      })}
    </div>
  )
}
