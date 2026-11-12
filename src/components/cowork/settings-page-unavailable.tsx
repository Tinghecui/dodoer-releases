"use client"

import { useCoworkText } from "@/lib/cowork/i18n"

/**
 * What the settings shell shows in place of a page its nav hides for this
 * runtime (`isSettingsPageHidden` in `settings-shell.tsx`) when the page is
 * opened by its address. The page itself is never mounted, so nothing it
 * would load, show or save on its own happens: in a browser the Web service
 * page would otherwise show the server's port and placeholder token and
 * auto-save them back.
 *
 * `managed`: the window is a browser on a server someone else runs, which is
 * why the page is not the visitor's to use.
 */
export function SettingsPageUnavailable({ managed }: { managed: boolean }) {
  const t = useCoworkText()
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center"
    >
      <p className="text-sm font-medium">{t("settingsPageUnavailable")}</p>
      {managed && (
        <p className="text-xs text-muted-foreground">
          {t("settingsPageManaged")}
        </p>
      )}
    </div>
  )
}
