"use client"

/**
 * The switch "let agents run code in tabs they may act on" for the person's
 * own Chrome (`docs/agent-chrome.md` 13.5), in the Chrome card of the
 * settings page and in the Chrome panel at the sidebar foot.
 *
 * One switch for this computer's Chrome, whichever window shows it, and off
 * until the person turns it on. The backend keeps it only in memory, so it
 * is remembered here (`chrome:eval`) and handed back when the app starts —
 * the way the panel's "let agents use my Chrome" is. Only the app's own
 * shell can change it; no agent tool reaches it.
 *
 * What it lets through is narrow on purpose: tabs handed over to read and
 * act on, never read-only or unshared ones, and never the sensitive sites.
 * What it lets an agent do there is not narrow at all, so the risk is
 * written right under it.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Code2 } from "lucide-react"
import { toast } from "sonner"

import { SettingRow } from "@/components/shared/setting-card"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import { chromeEval, chromeSetEval } from "@/lib/browser/chrome-api"
import { cn } from "@/lib/utils"

/** Where the switch is remembered across restarts. */
export const EVAL_KEY = "chrome:eval"

function remembered(): boolean {
  try {
    return localStorage.getItem(EVAL_KEY) === "1"
  } catch {
    return false
  }
}

function remember(on: boolean) {
  try {
    localStorage.setItem(EVAL_KEY, on ? "1" : "0")
  } catch {
    // Without storage the switch lasts until the app quits.
  }
}

/**
 * The switch as the backend has it — asked on mount and whenever `refresh`
 * changes (another window may have changed it) — with the remembered one
 * handed back first when the backend has lost it to a restart.
 */
function useChromeEval(refresh?: unknown) {
  const t = useTranslations("ChromeSettings")
  const [on, setOn] = useState(false)

  useEffect(() => {
    let cancelled = false
    chromeEval()
      .then((now) => (!now && remembered() ? chromeSetEval(true) : now))
      .then((now) => {
        if (!cancelled) setOn(now)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refresh])

  const change = async (next: boolean) => {
    try {
      const now = await chromeSetEval(next)
      setOn(now)
      remember(now)
    } catch (error) {
      toast.error(t("evalFailed", { message: toErrorMessage(error) }))
    }
  }

  return [on, change] as const
}

/** The row in the settings page's Chrome card. */
export function ChromeEvalSetting() {
  const t = useTranslations("ChromeSettings")
  const [on, change] = useChromeEval()
  return (
    <SettingRow
      icon={Code2}
      title={t("evalSwitch")}
      description={t("evalRisk")}
      htmlFor="chrome-eval"
      control={
        <Switch
          id="chrome-eval"
          checked={on}
          onCheckedChange={(next) => void change(next)}
        />
      }
    />
  )
}

/** The block in the Chrome panel; `open` is the panel's, to ask again each
 *  time it opens. */
export function ChromeEvalPanelSwitch({ open }: { open: boolean }) {
  const t = useTranslations("ChromeSettings")
  const [on, change] = useChromeEval(open)
  return (
    <div className="rounded-lg border px-2 py-1.5">
      <label className="flex items-center justify-between gap-2">
        <span className="text-2xs font-medium">{t("evalSwitch")}</span>
        <Switch checked={on} onCheckedChange={(next) => void change(next)} />
      </label>
      <p
        className={cn(
          "mt-0.5 text-3xs",
          on ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
        )}
      >
        {t("evalRisk")}
      </p>
    </div>
  )
}
