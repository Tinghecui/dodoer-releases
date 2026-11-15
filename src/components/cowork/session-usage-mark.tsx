"use client"

// Cowork fork: the mark on a conversation's sidebar row and tab while its
// agent uses one of the person's computers — the browser there (their own
// Chrome, when it is) or its command line (`docs/session-usage-badge.md`).
// Only shown; the devices panel is where lending is stopped.

import { memo } from "react"
import { Chrome, Globe, SquareTerminal, type LucideIcon } from "lucide-react"

import { useCoworkText, type CoworkTextKey } from "@/lib/cowork/i18n"
import { useSessionUsage, type SessionUse } from "@/lib/cowork/session-usage"
import { cn } from "@/lib/utils"

const TONE = "text-sky-600 dark:text-sky-400"

type Text = ReturnType<typeof useCoworkText>

/** The icon and the words for one use. */
export function describeUse(
  use: SessionUse,
  t: Text
): { Icon: LucideIcon; title: string } {
  const named = use.device != null && use.device !== ""
  const values = named ? { name: use.device as string } : undefined
  if (use.kind === "shell") {
    const key: CoworkTextKey = named ? "usageShellOn" : "usageShellHere"
    return { Icon: SquareTerminal, title: t(key, values) }
  }
  if (use.chrome === true) {
    const key: CoworkTextKey = named ? "usageChromeOn" : "usageChromeHere"
    return { Icon: Chrome, title: t(key, values) }
  }
  const key: CoworkTextKey = named ? "usageBrowserOn" : "usageBrowserHere"
  return { Icon: Globe, title: t(key, values) }
}

/**
 * What `conversationId` uses now, one icon per use (the browser before the
 * command line); nothing while it uses nothing. `className` places it in the
 * row or bar it sits in; `iconClassName` sizes the icons to its text.
 */
export const SessionUsageMark = memo(function SessionUsageMark({
  conversationId,
  className,
  iconClassName = "h-3 w-3",
}: {
  conversationId: number | null | undefined
  className?: string
  iconClassName?: string
}) {
  const t = useCoworkText()
  const uses = useSessionUsage(conversationId)
  if (uses.length === 0) return null
  const described = uses.map((use) => ({ use, ...describeUse(use, t) }))
  const title = described.map((d) => d.title).join("\n")
  return (
    <span
      data-session-usage={uses.map((u) => u.kind).join(" ")}
      title={title}
      aria-label={title}
      role="img"
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5",
        TONE,
        className
      )}
    >
      {described.map(({ use, Icon }) => (
        <Icon
          key={`${use.kind}:${use.device ?? ""}`}
          aria-hidden
          className={iconClassName}
        />
      ))}
    </span>
  )
})
