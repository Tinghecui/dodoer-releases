"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { useSearchParams } from "next/navigation"
import { House, Laptop, MonitorCloud, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppToaster } from "@/components/ui/app-toaster"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { RemoteWorkspaceManageDialog } from "@/components/layout/remote-workspace-manage-dialog"
import { useRemoteWorkspaceConnections } from "@/hooks/use-remote-workspace-connections"
import { PRODUCT_NAME } from "@/lib/cowork/brand"
import { useCoworkText } from "@/lib/cowork/i18n"
import {
  initialMainWindowView,
  readMainWindowView,
  reloadWindow,
  rememberMainWindowView,
  type MainWindowView,
} from "@/lib/cowork/start-page"
import { listRemoteWorkspaceConnections } from "@/lib/remote-workspace"
import { localDaemonInfo } from "@/lib/transport/local-daemon"

/** Leaves the local workspace for the start page; null where there is none. */
const BackToStartContext = createContext<(() => void) | null>(null)

/**
 * Cowork fork. The desktop app's main window opens on the start page
 * ({@link StartHome}: the local workspace, the saved servers, the ways to add
 * one) or straight on the local workspace, as `lib/cowork/start-page.ts`
 * decides and remembers. Remote workspace windows (`remoteConnectionId` in
 * the URL) and the web build (no `window.__CODEG_LOCAL_DAEMON__`) render the
 * workspace as always. Without a local daemon (`CODEG_DESKTOP_DAEMON=client`)
 * the start page is all the main window has.
 *
 * Inside `RemoteConnectionGate`, which already reads the search params, so
 * this renders on the client only and `window.__CODEG_LOCAL_DAEMON__` is there
 * to read on the first render.
 */
export function StartGate({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams()
  const remoteWindow = searchParams.get("remoteConnectionId") !== null
  const daemon = localDaemonInfo()
  if (remoteWindow || !daemon) return <>{children}</>
  return (
    <MainWindowStart hasLocalDaemon={daemon.mode !== "client"}>
      {children}
    </MainWindowStart>
  )
}

function MainWindowStart({
  hasLocalDaemon,
  children,
}: {
  hasLocalDaemon: boolean
  children: ReactNode
}) {
  const [view, setView] = useState<MainWindowView | null>(() =>
    initialMainWindowView(hasLocalDaemon, readMainWindowView(), null)
  )

  // Nothing remembered: the start page only when there is a server to offer.
  useEffect(() => {
    if (view !== null) return
    let cancelled = false
    listRemoteWorkspaceConnections()
      .then(
        (saved) => saved.length,
        // Cannot tell: the local workspace, as before the start page.
        () => 0
      )
      .then((saved) => {
        if (!cancelled) {
          setView(initialMainWindowView(hasLocalDaemon, null, saved))
        }
      })
    return () => {
      cancelled = true
    }
  }, [hasLocalDaemon, view])

  useEffect(() => {
    if (view === "local") rememberMainWindowView("local")
  }, [view])

  // A reload rather than unmounting the workspace: its providers disconnect
  // the local agents when they unmount, while a reload leaves them running in
  // the daemon for the workspace to pick up again, as after ⌘R.
  const backToStart = useCallback(() => {
    rememberMainWindowView("start")
    reloadWindow()
  }, [])

  if (view === null) return null
  if (view === "start") {
    return (
      <StartHome
        onOpenLocal={hasLocalDaemon ? () => setView("local") : undefined}
      />
    )
  }
  return (
    <BackToStartContext.Provider value={backToStart}>
      {children}
    </BackToStartContext.Provider>
  )
}

/**
 * Quick actions' "Back to start page", in the main window's local workspace
 * only (nothing elsewhere: a remote window has no start page).
 */
export function BackToStartMenuItem() {
  const t = useCoworkText()
  const backToStart = useContext(BackToStartContext)
  if (!backToStart) return null
  return (
    <DropdownMenuItem onSelect={backToStart}>
      <House />
      {t("backToStart")}
    </DropdownMenuItem>
  )
}

/**
 * The start page. On top, the local workspace (`onOpenLocal`; absent without
 * a local daemon). Below, the saved connections (the list is reloaded
 * whenever the window comes to the front: the portal's one-click link adds
 * one from outside this window), each opening in its own window, the
 * connection manager to add or edit servers, and how to get connected
 * through Cowork.
 */
export function StartHome({ onOpenLocal }: { onOpenLocal?: () => void }) {
  const t = useCoworkText()
  const { connections, refresh, open } = useRemoteWorkspaceConnections()
  const [manageOpen, setManageOpen] = useState(false)

  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh])

  const handleManageChange = useCallback(
    (next: boolean) => {
      setManageOpen(next)
      if (!next) void refresh()
    },
    [refresh]
  )

  return (
    <div className="flex h-screen flex-col items-center justify-center overflow-y-auto bg-background p-6 text-sm">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-semibold">{t("startTitle")}</h1>
          <p className="text-muted-foreground">{t("startIntro")}</p>
        </div>

        {onOpenLocal ? (
          <section
            aria-labelledby="start-local"
            className="space-y-3 rounded-md border p-4"
          >
            <div className="flex items-start gap-3">
              <Laptop
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 space-y-1">
                <h2 id="start-local" className="font-medium">
                  {t("startLocalTitle")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t("startLocalHint", { product: PRODUCT_NAME })}
                </p>
              </div>
            </div>
            <Button className="w-full" onClick={onOpenLocal}>
              {t("startLocalOpen")}
            </Button>
          </section>
        ) : (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            {t("startNoLocal")}
          </p>
        )}

        <section aria-labelledby="start-saved" className="space-y-2">
          <h2
            id="start-saved"
            className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            <MonitorCloud aria-hidden="true" className="size-3.5" />
            {t("startSaved")}
          </h2>
          {connections.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-muted-foreground">
              {t("startEmpty")}
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {connection.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {connection.base_url}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => open(connection.id)}
                  >
                    {t("startOpen")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setManageOpen(true)}
          >
            <Settings2 />
            {t("startManage")}
          </Button>
        </section>

        <p className="text-xs text-muted-foreground">{t("startPortalHint")}</p>
      </div>

      <RemoteWorkspaceManageDialog
        open={manageOpen}
        onOpenChange={handleManageChange}
        onChanged={() => void refresh()}
      />
      {/* The workspace's toaster is not mounted here; the connection hook and
          the updater still toast. */}
      <AppToaster position="bottom-right" closeButton />
    </div>
  )
}
