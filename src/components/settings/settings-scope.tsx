"use client"

// Cowork fork: what a settings window says about which machine it edits —
// the hook the shell and the pages share, and the badge a section carries
// when it is kept somewhere other than where its page is filed.
// See `src/lib/settings-scope.ts`.

import { MonitorCloud, MonitorSmartphone } from "lucide-react"
import { useTranslations } from "next-intl"

import { useRemoteConnection } from "@/contexts/remote-connection-context"
import { cn } from "@/lib/utils"
import { detectEnvironment } from "@/lib/transport/detect"
import { localDaemonInfo } from "@/lib/transport/local-daemon"
import { settingsTargetFor, type SettingsTarget } from "@/lib/settings-scope"

export function useSettingsTarget(): SettingsTarget {
  const remote = useRemoteConnection()?.connection ?? null
  return settingsTargetFor(detectEnvironment(), localDaemonInfo(), remote)
}

/** The daemon's name as the settings window shows it. */
export function useServerLabel(target: SettingsTarget): string {
  const t = useTranslations("SettingsShell.scope")
  switch (target.kind) {
    case "remote":
      return target.serverName ?? t("server")
    case "web":
      return t("server")
    default:
      return t("localServer")
  }
}

/** The app side's name: this computer's app, or this browser. */
export function useAppLabel(target: SettingsTarget): string {
  const t = useTranslations("SettingsShell.scope")
  return target.kind === "web" ? t("thisBrowser") : t("thisApp")
}

/**
 * Says where one section is kept, next to its heading.
 * - `server`: the daemon the window talks to;
 * - `both`: the app and the daemon each keep a copy. Only the local child
 *   setup has two copies to speak of; a remote window sends these to its
 *   server and the embedded daemon is the app, so there it reads as one.
 */
export function SettingScopeBadge({
  scope,
  className,
}: {
  scope: "server" | "both"
  className?: string
}) {
  const t = useTranslations("SettingsShell.scope")
  const target = useSettingsTarget()
  const serverLabel = useServerLabel(target)

  if (target.kind === "embedded" || target.kind === "client") return null

  const both = scope === "both" && target.kind === "child"
  const label = both ? t("both", { server: serverLabel }) : serverLabel
  const Icon = target.kind === "remote" ? MonitorCloud : MonitorSmartphone
  const hint = both
    ? t("bothHint")
    : target.kind === "remote"
      ? t("serverHint", { url: target.serverUrl ?? "" })
      : undefined

  return (
    <span
      className={cn(
        "inline-flex max-w-56 items-center gap-1 rounded-full border px-1.5 py-px text-3xs font-normal text-muted-foreground",
        className
      )}
      title={hint}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}
