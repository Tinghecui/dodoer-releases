"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Loader2,
  Play,
  RotateCw,
  Square,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { BrowserTabView } from "@/components/browser/browser-tab-view"
import { WorkbenchStripScope } from "@/components/workbench/workbench-strip-slot"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/app-error"
import { browserReload } from "@/lib/browser/browser-api"
import { useBrowserCapabilities } from "@/lib/browser/use-browser-capabilities"
import { openUrl } from "@/lib/platform"
import { isDesktop } from "@/lib/transport"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import type { WorkbenchApp, WorkbenchAppStatus } from "@/lib/types"
import {
  appAddressLabel,
  appBrowserTab,
  appDisplayState,
  appStartable,
  appSurfaceId,
  type AppDisplayState,
} from "@/lib/workbench-apps"
import { cn } from "@/lib/utils"
import {
  markAppOpened,
  useWorkbenchAppsStore,
} from "@/stores/workbench-apps-store"

import { runAppAction } from "./app-actions"

/**
 * One app's side of the page: its own page once it answers, and until then
 * what is going on with its service and what can be done about it.
 *
 * The page, once shown, stays: kept mounted while another app is on screen
 * (hidden), its native surface alive — so coming back to it is instant and
 * finds it where it was, as a browser tab would be. If the service goes away
 * the page stays too, under a bar saying so, and is reloaded once the service
 * answers again.
 */
export function AppPane({
  app,
  status,
  active,
  onShowLog,
}: {
  app: WorkbenchApp
  status: WorkbenchAppStatus | undefined
  /** This app is the one on screen. */
  active: boolean
  onShowLog: () => void
}) {
  const display = appDisplayState(status)
  const opened = useWorkbenchAppsStore((s) => s.openedIds.includes(app.id))
  const capabilities = useBrowserCapabilities()
  const nativeUnavailable = isDesktop() && capabilities?.available === false
  // The kept page stays mounted under other routes: only the one on screen
  // may put its address bar in the strip.
  const { routeId } = useWorkbenchRoute()

  // The page is shown the first time the address answers while the app is on
  // screen; from then on it is kept.
  useEffect(() => {
    if (active && display === "running" && !nativeUnavailable) {
      markAppOpened(app.id)
    }
  }, [active, display, app.id, nativeUnavailable])

  if (nativeUnavailable) {
    return (
      <div className={cn("h-full", !active && "hidden")}>
        <AppStatusPanel
          app={app}
          display="running"
          status={status}
          onShowLog={onShowLog}
          browserUnavailable
        />
      </div>
    )
  }
  return (
    <div
      data-app-pane={app.id}
      data-app-display={display}
      className={cn("flex h-full min-h-0 flex-col", !active && "hidden")}
    >
      {opened ? (
        <WorkbenchStripScope active={active && routeId === "apps"}>
          <AppPageView app={app} display={display} onShowLog={onShowLog} />
        </WorkbenchStripScope>
      ) : (
        <AppStatusPanel
          app={app}
          display={display}
          status={status}
          onShowLog={onShowLog}
        />
      )}
    </div>
  )
}

/** The app's page in the built-in browser, under a bar when its service has
 *  stopped answering. */
function AppPageView({
  app,
  display,
  onShowLog,
}: {
  app: WorkbenchApp
  display: AppDisplayState
  onShowLog: () => void
}) {
  const t = useTranslations("Apps.pane")
  const tab = useMemo(() => appBrowserTab(app), [app])
  // In a browser the page is an iframe through the port bridge, and a new
  // mount is how it loads again; on the desktop the native surface reloads.
  const [mountKey, setMountKey] = useState(0)
  const reload = () => {
    if (isDesktop()) {
      void browserReload(appSurfaceId(app)).catch(() => {})
    } else {
      setMountKey((n) => n + 1)
    }
  }
  const reloadRef = useRef(reload)
  useEffect(() => {
    reloadRef.current = reload
  })
  // Down, then up again: the page lost its server under it, so it gets a
  // fresh load rather than whatever half-state it was left in.
  const wasDownRef = useRef(false)
  useEffect(() => {
    if (display === "running") {
      if (wasDownRef.current) reloadRef.current()
      wasDownRef.current = false
    } else if (display !== "unknown" && display !== "starting") {
      wasDownRef.current = true
    }
  }, [display])

  const down = display !== "running" && display !== "unknown"
  return (
    <>
      {down ? (
        <div
          role="status"
          data-app-down-bar=""
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs"
        >
          {display === "starting" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-600" />
          ) : (
            <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {display === "starting"
              ? t("restarting", { name: app.name })
              : t("disconnected", { address: appAddressLabel(app.url) })}
          </span>
          <AppServiceButtons
            app={app}
            display={display}
            onShowLog={onShowLog}
            size="xs"
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <BrowserTabView key={mountKey} tab={tab} />
      </div>
    </>
  )
}

/** What is going on with an app that has not answered yet, with the actions
 *  that can change that. */
function AppStatusPanel({
  app,
  display,
  status,
  onShowLog,
  browserUnavailable = false,
}: {
  app: WorkbenchApp
  display: AppDisplayState
  status: WorkbenchAppStatus | undefined
  onShowLog: () => void
  browserUnavailable?: boolean
}) {
  const t = useTranslations("Apps.pane")
  const address = appAddressLabel(app.url)
  const startable = appStartable(app)
  const { title, hint } = describe(t, app, display, status, address, startable)
  const busy = display === "starting" || display === "unknown"

  return (
    <div
      data-app-status-panel={display}
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      {browserUnavailable ? (
        <AlertTriangle className="size-10 text-muted-foreground/40" />
      ) : busy ? (
        <Loader2 className="size-10 animate-spin text-muted-foreground/40" />
      ) : display === "failed" || display === "exited" ? (
        <AlertTriangle className="size-10 text-destructive/60" />
      ) : (
        <Square className="size-10 text-muted-foreground/40" />
      )}
      <div className="text-sm font-medium" data-app-status-title="">
        {browserUnavailable ? t("browserUnavailableTitle") : title}
      </div>
      <p className="max-w-md text-xs text-muted-foreground">
        {browserUnavailable ? t("browserUnavailableHint") : hint}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {browserUnavailable ? null : (
          <AppServiceButtons
            app={app}
            display={display}
            onShowLog={onShowLog}
          />
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void openUrl(app.url)}
        >
          <ExternalLink className="size-3.5" />
          {t("openInBrowser")}
        </Button>
      </div>
      <code className="text-[0.6875rem] text-muted-foreground/80">
        {app.url}
      </code>
    </div>
  )
}

type PaneTranslator = ReturnType<typeof useTranslations<"Apps.pane">>

function describe(
  t: PaneTranslator,
  app: WorkbenchApp,
  display: AppDisplayState,
  status: WorkbenchAppStatus | undefined,
  address: string,
  startable: boolean
): { title: string; hint: string } {
  const name = app.name
  const problem = status?.problem
  switch (display) {
    case "unknown":
      return { title: t("checkingTitle", { name }), hint: "" }
    case "starting":
      return {
        title: t("startingTitle", { name }),
        hint: t("startingHint", { address }),
      }
    case "running":
      return { title: t("checkingTitle", { name }), hint: "" }
    case "notAnswering":
      return {
        title: t("notAnsweringTitle", { name }),
        hint: t("notAnsweringHint", { address }),
      }
    case "exited":
      return {
        title: t("exitedTitle", { name }),
        hint:
          problem?.kind === "exited" && problem.code !== null
            ? t("exitedHint", { code: problem.code })
            : t("exitedHintNoCode"),
      }
    case "failed":
      if (problem?.kind === "workingDirMissing") {
        return {
          title: t("cannotStartTitle", { name }),
          hint: t("dirMissingHint", { path: problem.path }),
        }
      }
      if (problem?.kind === "spawnFailed") {
        return {
          title: t("cannotStartTitle", { name }),
          hint: t("spawnFailedHint", { message: problem.message }),
        }
      }
      if (problem?.kind === "gaveUp") {
        return {
          title: t("gaveUpTitle", { name }),
          hint: t("gaveUpHint", { attempts: problem.attempts }),
        }
      }
      return { title: t("cannotStartTitle", { name }), hint: "" }
    case "stopped":
      if (!startable) {
        return {
          title: t("externalTitle", { name }),
          hint: t("externalHint", { address }),
        }
      }
      return app.launch === "manual"
        ? { title: t("manualTitle", { name }), hint: t("manualHint") }
        : { title: t("stoppedTitle", { name }), hint: t("stoppedHint") }
  }
}

/** Start / stop / restart / log, as far as each applies: codeg can only start
 *  an app with a command, and only stop what it started. */
export function AppServiceButtons({
  app,
  display,
  onShowLog,
  size = "sm",
}: {
  app: WorkbenchApp
  display: AppDisplayState
  onShowLog: () => void
  size?: "sm" | "xs"
}) {
  const t = useTranslations("Apps")
  const status = useWorkbenchAppsStore((s) => s.statuses[app.id])
  const [pending, setPending] = useState<string | null>(null)
  const startable = appStartable(app)
  const managed = status?.managed ?? false
  const run = async (action: "start" | "stop" | "restart") => {
    setPending(action)
    try {
      await runAppAction(action, app.id)
    } catch (error) {
      toast.error(t(`toast.${action}Failed`, { name: app.name }), {
        description: toErrorMessage(error),
      })
    } finally {
      setPending(null)
    }
  }
  const buttonClass = size === "xs" ? "h-6 px-2 text-xs" : undefined
  const iconClass = size === "xs" ? "size-3" : "size-3.5"
  const canStart =
    startable &&
    !managed &&
    (display === "stopped" ||
      display === "exited" ||
      display === "failed" ||
      display === "unknown")
  return (
    <>
      {canStart ? (
        <Button
          type="button"
          size="sm"
          className={buttonClass}
          data-app-action="start"
          disabled={pending !== null}
          onClick={() => void run("start")}
        >
          {pending === "start" ? (
            <Loader2 className={cn(iconClass, "animate-spin")} />
          ) : (
            <Play className={iconClass} />
          )}
          {t("actions.start")}
        </Button>
      ) : null}
      {managed ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          data-app-action="restart"
          disabled={pending !== null}
          onClick={() => void run("restart")}
        >
          {pending === "restart" ? (
            <Loader2 className={cn(iconClass, "animate-spin")} />
          ) : (
            <RotateCw className={iconClass} />
          )}
          {t("actions.restart")}
        </Button>
      ) : null}
      {managed ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          data-app-action="stop"
          disabled={pending !== null}
          onClick={() => void run("stop")}
        >
          {pending === "stop" ? (
            <Loader2 className={cn(iconClass, "animate-spin")} />
          ) : (
            <Square className={iconClass} />
          )}
          {t("actions.stop")}
        </Button>
      ) : null}
      {startable ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={buttonClass}
          data-app-action="log"
          onClick={onShowLog}
        >
          <FileText className={iconClass} />
          {t("actions.viewLog")}
        </Button>
      ) : null}
    </>
  )
}
