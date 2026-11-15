"use client"

/**
 * "Send diagnostics (crashes, hangs, errors)" — the desktop app's own
 * switch for its crash and hang reports (`src-tauri/src/crash_report`) and
 * for the reports of its local workspace: its own daemon and local windows
 * (docs/telemetry.md §5.11). On unless the person turns it off, and it says
 * what is sent, where, and what is not, right under the switch.
 *
 * Desktop-only, but in remote windows too: the switch is the app's, and the
 * calls go to the app, not to the window's server. What a remote window
 * itself reports follows its server, not this switch.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Bug } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import {
  getCrashReportSettings,
  updateCrashReportSettings,
} from "@/lib/cowork/crash-reports"
import { isDesktop } from "@/lib/platform"

export function CrashReportSettingsSection() {
  const t = useTranslations("CrashReportSettings")
  const supported = isDesktop()

  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void (async () => {
      try {
        const settings = await getCrashReportSettings()
        if (!cancelled) setEnabled(settings.enabled)
      } catch (err) {
        console.error("[Settings] load crash report setting failed:", err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [supported])

  const save = useCallback(
    async (next: boolean, prev: boolean) => {
      setSaving(true)
      try {
        const result = await updateCrashReportSettings({ enabled: next })
        setEnabled(result.enabled)
      } catch (err) {
        setEnabled(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  // Hidden until the stored value is known: a switch shown by guess would
  // misstate the person's choice.
  if (!supported || enabled === null) return null

  return (
    <SettingsSection
      icon={Bug}
      title={t("title")}
      description={
        <>
          {t("description")}
          <span className="mt-1 block">{t("whatIsSent")}</span>
          <span className="mt-1 block">{t("whatIsNotSent")}</span>
          <span className="mt-1 block">{t("restartNote")}</span>
        </>
      }
      htmlFor="diagnostics-enabled"
      control={
        <Switch
          id="diagnostics-enabled"
          checked={enabled}
          disabled={saving}
          onCheckedChange={(next) => {
            const prev = enabled
            setEnabled(next)
            void save(next, prev)
          }}
        />
      }
    />
  )
}
