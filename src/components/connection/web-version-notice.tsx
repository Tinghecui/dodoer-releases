"use client"

import { useEffect, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { subscribe } from "@/lib/platform"
import {
  getRunningServerVersion,
  isOwnServerRestartRunning,
  subscribeOwnServerRestart,
} from "@/lib/updater"
import { hasCodegCredentials } from "@/lib/transport/web-auth"
import {
  getWebConnectionServerSnapshot,
  getWebConnectionSnapshot,
  subscribeWebConnection,
  usesWebTransport,
} from "@/lib/transport/web-connection-store"

export const WEB_VERSION_TOAST_ID = "web-version-changed"

/** Sent by the server when it switched to another release's web files. */
const WEB_ASSETS_CHANGED_EVENT = "web_assets_changed"

interface WebAssetsChangedPayload {
  release?: string | null
}

// Where Next serves the build's scripts and stylesheets from.
const BUILD_FILES_PREFIX = "/_next/"

/**
 * The build file a failure names, if it names one: the element whose load
 * failed, or the chunk URL in the bundler's rejection (a ChunkLoadError).
 */
function failedBuildFile(event: Event): string | null {
  if (event.type === "unhandledrejection") {
    const reason: unknown = (event as PromiseRejectionEvent).reason
    if (!(reason instanceof Error)) return null
    if (reason.name !== "ChunkLoadError") return null
    // Turbopack: "Failed to load chunk /_next/….js from module …"; webpack:
    // "Loading chunk 12 failed.\n(error: https://…/_next/….js)".
    return /\/_next\/[^\s)"']+/.exec(reason.message)?.[0] ?? null
  }
  const target = event.target
  let url: string | null = null
  if (target instanceof HTMLScriptElement) url = target.src
  else if (target instanceof HTMLLinkElement) url = target.href
  if (!url) return null
  try {
    const parsed = new URL(url, window.location.href)
    if (parsed.origin !== window.location.origin) return null
    if (!parsed.pathname.startsWith(BUILD_FILES_PREFIX)) return null
    return parsed.pathname + parsed.search
  } catch {
    return null
  }
}

/**
 * Whether the server no longer has a build file: it answers 404 for a file
 * missing under /_next/. A file that cannot be fetched at all means the
 * server is away, which the connection guard already reports. HEAD, so the
 * service worker (GET only) lets it through to the server.
 */
async function isBuildFileGone(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" })
    return response.status === 404
  } catch {
    return false
  }
}

// Once a page is told its files are gone it stays told: only a reload helps,
// and the version check must not take the notice back.
let pageFilesGone = false

export function resetWebVersionNoticeForTests(): void {
  pageFilesGone = false
}

/**
 * Offers a reload when the server runs a different release than this page.
 *
 * The desktop app restarts into a new release; a browser tab does not. A
 * server upgraded under an open tab goes on answering it, and the tab goes on
 * running the previous release's code, fixes not included, until it is
 * reloaded. Checked when the page loads and each time the connection comes
 * back, which is what a restarted server looks like from here.
 *
 * A release that leaves the server code alone does not restart the server:
 * it switches to the new web files (`cowork_reload_web`) and says so with
 * `web_assets_changed`. This page keeps working as it is; reloading picks up
 * the new interface.
 */
export function WebVersionNotice() {
  const t = useTranslations("WebConnection")
  const state = useSyncExternalStore(
    subscribeWebConnection,
    getWebConnectionSnapshot,
    getWebConnectionServerSnapshot
  )
  // This page's own upgrade or rollback reports its outcome and reloads.
  const ownRestart = useSyncExternalStore(
    subscribeOwnServerRestart,
    isOwnServerRestartRunning,
    () => false
  )

  useEffect(() => {
    if (ownRestart) {
      toast.dismiss(WEB_VERSION_TOAST_ID)
      return
    }
    if (state !== "connected") return
    // The release this page was built from (inlined by next.config.ts). A
    // development build is not one, whatever its version says.
    const pageVersion = process.env.CODEG_APP_VERSION
    if (!pageVersion || process.env.NODE_ENV !== "production") return
    // Without credentials the request would be refused, and a refusal reads
    // as an expired session.
    if (!usesWebTransport() || !hasCodegCredentials()) return
    let cancelled = false
    void getRunningServerVersion().then((serverVersion) => {
      // An older server does not report its version.
      if (cancelled || !serverVersion) return
      if (serverVersion === pageVersion) {
        if (!pageFilesGone) toast.dismiss(WEB_VERSION_TOAST_ID)
        return
      }
      toast(t("versionChangedTitle", { version: serverVersion }), {
        id: WEB_VERSION_TOAST_ID,
        description: t("versionChangedDescription", { version: pageVersion }),
        duration: Infinity,
        action: {
          label: t("reloadPage"),
          onClick: () => window.location.reload(),
        },
      })
    })
    return () => {
      cancelled = true
    }
  }, [state, ownRestart, t])

  useEffect(() => {
    // The desktop window ships its interface with the app, not from here; and
    // this page's own upgrade reports its outcome and reloads.
    if (ownRestart || !usesWebTransport()) return
    let disposed = false
    let unsubscribe: (() => void) | null = null
    void subscribe<WebAssetsChangedPayload>(
      WEB_ASSETS_CHANGED_EVENT,
      (payload) => {
        // A page already missing its files needs a reload; "you can keep
        // working" would take that back.
        if (pageFilesGone) return
        const release = payload?.release
        // The release this page was built from (inlined by next.config.ts).
        const pageRelease = process.env.CODEG_RELEASE_VERSION
        if (!release || !pageRelease || release === pageRelease) return
        toast(t("webAssetsChangedTitle", { version: release }), {
          id: WEB_VERSION_TOAST_ID,
          description: t("webAssetsChangedDescription"),
          duration: Infinity,
          action: {
            label: t("reloadPage"),
            onClick: () => window.location.reload(),
          },
        })
      }
    )
      .then((unsub) => {
        if (disposed) unsub()
        else unsubscribe = unsub
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [ownRestart, t])

  // After an upgrade the server has the new release's build files and not
  // this page's. Code the page has not loaded yet (a dialog, a panel, a
  // route) then fails to load; say so instead of failing without a word.
  // The server keeps the previous web directories' /_next/static/ files
  // after `cowork_reload_web` (static_assets.rs), so this mostly fires after
  // a restart into another release, whose process starts without them.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !usesWebTransport()) return
    const onFailure = (event: Event) => {
      if (pageFilesGone) return
      const url = failedBuildFile(event)
      if (url === null) return
      void isBuildFileGone(url).then((gone) => {
        if (!gone || pageFilesGone) return
        pageFilesGone = true
        toast(t("filesChangedTitle"), {
          id: WEB_VERSION_TOAST_ID,
          description: t("filesChangedDescription"),
          duration: Infinity,
          action: {
            label: t("reloadPage"),
            onClick: () => window.location.reload(),
          },
        })
      })
    }
    // Load errors do not bubble; only a capturing listener hears them.
    window.addEventListener("error", onFailure, true)
    window.addEventListener("unhandledrejection", onFailure)
    return () => {
      window.removeEventListener("error", onFailure, true)
      window.removeEventListener("unhandledrejection", onFailure)
    }
  }, [t])

  return null
}
