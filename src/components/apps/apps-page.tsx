"use client"

import { useEffect, useState } from "react"
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { NativeSurfaceBesideRoute } from "@/components/browser/browser-surface-host"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { GLASS_CARD_CLASS, glassClassName } from "@/components/ui/glass"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"
import type { WorkbenchChromeActionsProps } from "@/components/workbench/workbench-content"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { toErrorMessage } from "@/lib/app-error"
import { onTransportReconnect, openUrl, subscribe } from "@/lib/platform"
import type {
  WorkbenchApp,
  WorkbenchAppStatus,
  WorkbenchAppsSnapshot,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  MAX_APPS,
  WORKBENCH_APPS_CHANGED_EVENT,
  WORKBENCH_APPS_STATUS_EVENT,
  appAddressLabel,
  appDisplayState,
  appFromForm,
  appStartable,
  newAppId,
  type AppFormValues,
} from "@/lib/workbench-apps"
import { useWorkbenchAppsStore } from "@/stores/workbench-apps-store"

import {
  applyAppsSnapshot,
  movedApp,
  refreshApps,
  runAppAction,
  saveApps,
  withApp,
  withoutApp,
} from "./app-actions"
import { AppFormDialog } from "./app-form-dialog"
import { AppLogDialog } from "./app-log-dialog"
import { AppPane } from "./app-pane"
import { AppStatusDot } from "./app-status"

/** The route's strip: "Apps", then the app on screen. */
export function AppsPageTitle() {
  const t = useTranslations("Apps")
  const selected = useWorkbenchAppsStore((s) =>
    s.selectedId === null
      ? null
      : (s.apps.find((app) => app.id === s.selectedId) ?? null)
  )
  const status = useWorkbenchAppsStore((s) =>
    selected ? s.statuses[selected.id] : undefined
  )
  return (
    <WorkbenchPageTitle
      title={t("title")}
      trail={
        selected ? (
          <>
            <ChevronRight
              className="size-3 shrink-0 text-muted-foreground/50"
              aria-hidden="true"
            />
            <span className="flex min-w-0 items-center gap-1.5 px-1 text-[0.8125rem] font-medium leading-none">
              <AppStatusDot state={appDisplayState(status)} />
              <span className="truncate">{selected.name}</span>
            </span>
          </>
        ) : null
      }
    />
  )
}

/**
 * jenny fork: the route's button in the window's top-right cluster, where the
 * conversations view has its aux-panel toggle: it folds the app list on the
 * page's right away and back.
 */
export function AppsChromeActions({
  buttonClassName,
  iconClassName,
}: WorkbenchChromeActionsProps) {
  const t = useTranslations("Apps")
  const listOpen = useWorkbenchAppsStore((s) => s.listOpen)
  const toggleList = useWorkbenchAppsStore((s) => s.toggleList)
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        buttonClassName,
        listOpen && "bg-[var(--g-sel)] text-foreground"
      )}
      onClick={toggleList}
      aria-pressed={listOpen}
      title={t("toggleList")}
      aria-label={t("toggleList")}
      data-apps-list-toggle=""
    >
      <PanelRight className={iconClassName} />
    </Button>
  )
}

/**
 * The Apps page, kept mounted once it has been opened.
 *
 * Mounted with the workspace, it keeps the apps' list and statuses current from
 * the start (so the page opens on live states, not a spinner); the page itself
 * is drawn from the first visit on. Every other full-page route is unmounted
 * when another takes its place; this one stays, hidden, for the rest of the
 * session, so its apps' pages do too —
 * the iframes a browser shows them in would otherwise reload on every visit,
 * and the list would flash empty. It sits over the route overlay's page slot
 * (the overlay draws the strip and the background; its page slot is empty for
 * this route) and, hidden, is stopped from painting and taking input and
 * tells every native surface inside that its host is hidden — the same four
 * parts as the kept conversation surface (`KeptMountedSurface` in the
 * workspace layout). Its surfaces are told they are beside the route (shown
 * whatever the route) because this layer decides their visibility itself.
 */
export function AppsRouteLayer() {
  useAppsSync()
  const { routeId } = useWorkbenchRoute()
  const active = routeId === "apps"
  const [visited, setVisited] = useState(active)
  if (active && !visited) setVisited(true)
  if (!visited) return null
  return (
    <OverlayHostHiddenProvider hidden={!active}>
      <div
        data-apps-route-layer=""
        className={cn(
          "absolute inset-x-0 top-[3.25rem] bottom-0 z-40",
          !active && "conversation-tab-hidden invisible"
        )}
        inert={!active || undefined}
      >
        <NativeSurfaceBesideRoute.Provider value={true}>
          <AppsPage />
        </NativeSurfaceBesideRoute.Provider>
      </div>
    </OverlayHostHiddenProvider>
  )
}

/** Live list and statuses: one read, then the events (and a read again after
 *  the transport reconnects, since events are dropped while it is down). */
function useAppsSync() {
  useEffect(() => {
    let cancelled = false
    const unsubs: Array<() => void> = []
    const keep = (unsub: () => void) => {
      if (cancelled) unsub()
      else unsubs.push(unsub)
    }
    void subscribe<WorkbenchAppStatus[]>(WORKBENCH_APPS_STATUS_EVENT, (list) =>
      useWorkbenchAppsStore.getState().applyStatuses(list)
    ).then(keep)
    void subscribe<WorkbenchAppsSnapshot>(
      WORKBENCH_APPS_CHANGED_EVENT,
      applyAppsSnapshot
    ).then(keep)
    void refreshApps().catch(() => {})
    const offReconnect = onTransportReconnect(() => {
      void refreshApps().catch(() => {})
    })
    return () => {
      cancelled = true
      for (const unsub of unsubs) unsub()
      offReconnect?.()
    }
  }, [])
}

function AppsPage() {
  const t = useTranslations("Apps")
  const apps = useWorkbenchAppsStore((s) => s.apps)
  const statuses = useWorkbenchAppsStore((s) => s.statuses)
  const hydrated = useWorkbenchAppsStore((s) => s.hydrated)
  const loadError = useWorkbenchAppsStore((s) => s.loadError)
  const selectedId = useWorkbenchAppsStore((s) => s.selectedId)
  const openedIds = useWorkbenchAppsStore((s) => s.openedIds)
  const select = useWorkbenchAppsStore((s) => s.select)
  const listOpen = useWorkbenchAppsStore((s) => s.listOpen)
  const isMobile = useIsMobile()
  // `undefined` = closed, `null` = adding a new app.
  const [editing, setEditing] = useState<WorkbenchApp | null | undefined>(
    undefined
  )
  const [deleting, setDeleting] = useState<WorkbenchApp | null>(null)
  const [logApp, setLogApp] = useState<WorkbenchApp | null>(null)

  const save = async (next: readonly WorkbenchApp[]): Promise<boolean> => {
    try {
      await saveApps([...next])
      return true
    } catch (error) {
      toast.error(t("toast.saveFailed"), { description: toErrorMessage(error) })
      return false
    }
  }

  const submitForm = async (values: AppFormValues): Promise<boolean> => {
    const id = editing?.id ?? newAppId()
    const ok = await save(withApp(apps, appFromForm(id, values)))
    if (ok && !editing) select(id)
    return ok
  }

  // The page's own panes: every app opened this session (kept loaded), plus
  // the one on screen.
  const paneIds = new Set(openedIds)
  if (selectedId) paneIds.add(selectedId)

  if (!hydrated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        {loadError ? (
          <>
            <div className="text-sm font-medium">{t("loadFailed")}</div>
            <p className="max-w-md text-xs text-muted-foreground">
              {loadError}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void refreshApps().catch(() => {})}
            >
              <RotateCw className="size-3.5" />
              {t("retry")}
            </Button>
          </>
        ) : (
          <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
        )}
      </div>
    )
  }

  const appList =
    listOpen || isMobile ? (
      // jenny fork: on the desktop the list is a card on the page's right,
      // like the conversations sidebar on the left (same glass, fill and
      // frame), and folds away from the window's top-right button. On a
      // phone it stays the strip above the page.
      <div
        className={cn("shrink-0", !isMobile && "w-60 p-2")}
        data-apps-list=""
      >
        <nav
          aria-label={t("listLabel")}
          className={cn(
            "flex",
            isMobile
              ? "border-b border-border/50"
              : cn(
                  glassClassName({ material: "pane" }),
                  GLASS_CARD_CLASS,
                  "h-full flex-col overflow-hidden rounded-[1.125rem]"
                )
          )}
        >
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 gap-1 p-1.5",
              isMobile ? "overflow-x-auto" : "flex-col overflow-y-auto"
            )}
            role="list"
          >
            {apps.map((app, index) => (
              <AppListItem
                key={app.id}
                app={app}
                status={statuses[app.id]}
                selected={app.id === selectedId}
                first={index === 0}
                last={index === apps.length - 1}
                onSelect={() => select(app.id)}
                onEdit={() => setEditing(app)}
                onDelete={() => setDeleting(app)}
                onMove={(delta) => void save(movedApp(apps, app.id, delta))}
                onShowLog={() => setLogApp(app)}
              />
            ))}
          </div>
          <div
            className={cn(
              "flex shrink-0 items-center border-border/50 p-1.5",
              isMobile ? "border-l" : "border-t"
            )}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "gap-2 text-muted-foreground",
                !isMobile && "w-full justify-start"
              )}
              disabled={apps.length >= MAX_APPS}
              title={
                apps.length >= MAX_APPS
                  ? t("tooMany", { max: MAX_APPS })
                  : undefined
              }
              data-apps-add=""
              onClick={() => setEditing(null)}
            >
              <Plus className="size-3.5" />
              <span className={cn(isMobile && "sr-only")}>{t("add")}</span>
            </Button>
          </div>
        </nav>
      </div>
    ) : null

  return (
    <div
      className={cn("flex h-full min-h-0", isMobile ? "flex-col" : "flex-row")}
      data-apps-page=""
    >
      {isMobile ? appList : null}
      <section className="relative min-h-0 min-w-0 flex-1">
        {apps.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <AppWindow className="size-10 text-muted-foreground/40" />
            <div className="text-sm font-medium">{t("empty")}</div>
            <p className="max-w-sm text-xs text-muted-foreground">
              {t("emptyHint")}
            </p>
            <Button type="button" size="sm" onClick={() => setEditing(null)}>
              <Plus className="size-3.5" />
              {t("add")}
            </Button>
          </div>
        ) : (
          // One pane per opened app, in list order. Only the one on screen
          // is displayed; the others are `display: none` (their pages kept
          // loaded), so they take no room and, unlike an empty positioned
          // box, cannot sit over the shown one and take its clicks.
          apps
            .filter((app) => paneIds.has(app.id))
            .map((app) => (
              <AppPane
                key={app.id}
                app={app}
                status={statuses[app.id]}
                active={app.id === selectedId}
                onShowLog={() => setLogApp(app)}
              />
            ))
        )}
      </section>
      {isMobile ? null : appList}
      <AppFormDialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined)
        }}
        app={editing ?? null}
        onSubmit={submitForm}
      />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("delete.title", { name: deleting?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("form.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-apps-delete-confirm=""
              onClick={() => {
                if (deleting) void save(withoutApp(apps, deleting.id))
              }}
            >
              {t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AppLogDialog
        app={logApp}
        onOpenChange={(open) => {
          if (!open) setLogApp(null)
        }}
      />
    </div>
  )
}

function AppListItem({
  app,
  status,
  selected,
  first,
  last,
  onSelect,
  onEdit,
  onDelete,
  onMove,
  onShowLog,
}: {
  app: WorkbenchApp
  status: WorkbenchAppStatus | undefined
  selected: boolean
  first: boolean
  last: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
  onMove: (delta: number) => void
  onShowLog: () => void
}) {
  const t = useTranslations("Apps")
  const display = appDisplayState(status)
  const startable = appStartable(app)
  const managed = status?.managed ?? false
  const run = (action: "start" | "stop" | "restart") => {
    void runAppAction(action, app.id).catch((error: unknown) => {
      toast.error(t(`toast.${action}Failed`, { name: app.name }), {
        description: toErrorMessage(error),
      })
    })
  }
  const launchLabel = !startable
    ? t("external")
    : app.launch === "auto"
      ? t("launchAuto")
      : t("launchManual")
  return (
    <div
      role="listitem"
      data-app-item={app.id}
      data-selected={selected || undefined}
      className={cn(
        "group relative flex min-w-44 shrink-0 items-center rounded-lg md:min-w-0",
        "transition-colors duration-150 hover:bg-accent/60",
        selected && "bg-accent"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <AppStatusDot state={display} className="mt-1.5" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-medium">
            {app.name}
          </span>
          <span className="block truncate text-[0.6875rem] text-muted-foreground">
            {appAddressLabel(app.url)} · {launchLabel}
          </span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mr-1 size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            title={t("actions.more")}
            aria-label={t("actions.more")}
            data-app-menu={app.id}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {startable && !managed && display !== "running" ? (
            <DropdownMenuItem onSelect={() => run("start")}>
              <Play />
              {t("actions.start")}
            </DropdownMenuItem>
          ) : null}
          {managed ? (
            <>
              <DropdownMenuItem onSelect={() => run("restart")}>
                <RotateCw />
                {t("actions.restart")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run("stop")}>
                <Square />
                {t("actions.stop")}
              </DropdownMenuItem>
            </>
          ) : null}
          {startable ? (
            <DropdownMenuItem onSelect={onShowLog}>
              <FileText />
              {t("actions.viewLog")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => void openUrl(app.url)}>
            <ExternalLink />
            {t("actions.openInBrowser")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            {t("actions.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
            <ArrowUp />
            {t("actions.moveUp")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
            <ArrowDown />
            {t("actions.moveDown")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 />
            {t("actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
