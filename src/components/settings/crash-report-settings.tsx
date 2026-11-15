"use client"

/**
 * "Send desktop crash and hang reports" — the consent for the desktop app's
 * own reports (`src-tauri/src/crash_report`, docs/telemetry.md §5.11). Off
 * until the person turns it on, and it says what is sent, where, and what is
 * not, right under the switch.
 *
 * Desktop-only, but in remote windows too: the switch is the app's, and the
 * calls go to the app, not to the window's server.
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

  // Hidden until the stored value is known: a switch shown "off" by guess
  // would misstate a consent the person may have given.
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
        </>
      }
      htmlFor="crash-reports-enabled"
      control={
        <Switch
          id="crash-reports-enabled"
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
