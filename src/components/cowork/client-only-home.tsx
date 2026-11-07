"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useSearchParams } from "next/navigation"
import { Download, MonitorCloud, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppToaster } from "@/components/ui/app-toaster"
import { RemoteWorkspaceManageDialog } from "@/components/layout/remote-workspace-manage-dialog"
import { useRemoteWorkspaceConnections } from "@/hooks/use-remote-workspace-connections"
import { PRODUCT_NAME } from "@/lib/cowork/brand"
import { useCoworkText } from "@/lib/cowork/i18n"
import { openUrl } from "@/lib/platform"
import { isClientOnlyApp } from "@/lib/transport/local-daemon"

/**
 * Where the full edition (with a daemon of its own) is published. The
 * client-only edition is what Cowork hands out; someone who wants a workspace
 * on their own machine installs the other one from the same place.
 */
export const FULL_EDITION_DOWNLOAD_URL =
  "https://github.com/Tinghecui/dodoer-releases/releases/latest"

/**
 * Cowork fork (daemon/client split, step 3). In the client-only edition of the
 * app the local window has no daemon behind it, so instead of the workspace
 * (which would ask a daemon that is not there for its folders, conversations,
 * settings…) it shows {@link ClientOnlyHome}: the saved remote workspaces,
 * each a click away, and the ways to add one. A remote workspace window is
 * untouched: it is bound to a server (`remoteConnectionId` in its URL) and
 * renders the workspace as in any edition.
 *
 * Inside `RemoteConnectionGate`, which already reads the search params, so
 * this renders on the client only and `window.__CODEG_LOCAL_DAEMON__` is there
 * to read on the first render.
 */
export function ClientOnlyGate({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams()
  const remoteWindow = searchParams.get("remoteConnectionId") !== null
  if (!remoteWindow && isClientOnlyApp()) {
    return <ClientOnlyHome />
  }
  return <>{children}</>
}

/**
 * The client-only edition's local window. Lists the saved connections (the
 * list is reloaded whenever the window comes to the front: the portal's
 * one-click link adds one from outside this window), opens one in its own
 * window, and opens the connection manager to add or edit servers. Says how
 * to get connected through Cowork, and where the full edition is for anyone
 * who wanted a workspace on this machine.
 */
export function ClientOnlyHome() {
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
    <div className="flex h-screen flex-col items-center justify-center bg-background p-6 text-sm">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-2 text-center">
          <MonitorCloud
            aria-hidden="true"
            className="mx-auto size-8 text-muted-foreground"
          />
          <h1 className="text-lg font-semibold">{t("clientHomeTitle")}</h1>
          <p className="text-muted-foreground">
            {t("clientHomeIntro", { product: PRODUCT_NAME })}
          </p>
        </div>

        <section aria-labelledby="client-home-saved" className="space-y-2">
          <h2
            id="client-home-saved"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t("clientHomeSaved")}
          </h2>
          {connections.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-muted-foreground">
              {t("clientHomeEmpty")}
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
                  <Button size="sm" onClick={() => open(connection.id)}>
                    {t("clientHomeOpen")}
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
            {t("clientHomeManage")}
          </Button>
        </section>

        <div className="space-y-2 text-xs text-muted-foreground">
          <p>{t("clientHomePortalHint")}</p>
          <p>
            {t("clientHomeFullEdition", { product: PRODUCT_NAME })}{" "}
            <button
              type="button"
              className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
              onClick={() => void openUrl(FULL_EDITION_DOWNLOAD_URL)}
            >
              <Download aria-hidden="true" className="size-3" />
              {t("clientHomeFullEditionLink")}
            </button>
          </p>
        </div>
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
