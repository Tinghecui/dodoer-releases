"use client"

/**
 * The person's own Chrome, bottom-right of the workspace
 * (`docs/agent-chrome.md`): whether the app is connected to it, and which web
 * pages it has open.
 *
 * The glyph is the state — green while connected, pulsing while Chrome's
 * dialog waits for an answer, plain otherwise — because "is the app still
 * attached to my browser?" is the one thing here a person should be able to
 * see without opening anything.
 *
 * The tab list is the person's alone. It is a title and a host name per tab,
 * and nothing in it reaches an agent: Chrome's tabs are not in the browser
 * registry agents are served from. Handing a tab over, jumping to it and
 * pausing agents come to this popover in later steps.
 *
 * Desktop only (Chrome is on the computer the app runs on), and only once the
 * person has connected on this computer at least once: first connecting takes
 * the instructions on the settings page, which is where a person who has
 * never heard of it starts.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Chrome, Globe, Settings2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  NEEDS_PASTE,
  PROBLEM_KEYS,
} from "@/components/settings/chrome-connect-settings"
import { openSettingsWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  chromeConnect,
  chromeDisconnect,
  chromeStatus,
  chromeTabs,
  subscribeChromeStatus,
  subscribeChromeTabs,
  type ChromeStatus,
  type ChromeTab,
} from "@/lib/browser/chrome-api"
import { isDesktop } from "@/lib/platform"
import { cn } from "@/lib/utils"

/** Set the first time this computer's app connects to Chrome. */
export const CONNECTED_BEFORE_KEY = "chrome:connected-before"

function connectedBefore(): boolean {
  try {
    return localStorage.getItem(CONNECTED_BEFORE_KEY) === "1"
  } catch {
    return false
  }
}

function rememberConnected() {
  try {
    localStorage.setItem(CONNECTED_BEFORE_KEY, "1")
  } catch {
    // Without storage the glyph shows only while connected.
  }
}

export function StatusBarChrome() {
  if (!isDesktop()) return null
  return <ChromeItem />
}

function ChromeItem() {
  const t = useTranslations("ChromeSettings")
  const [status, setStatus] = useState<ChromeStatus | null>(null)
  const [tabs, setTabs] = useState<ChromeTab[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const offs: (() => void)[] = []
    const keep = (off: () => void) => {
      if (cancelled) off()
      else offs.push(off)
    }
    // An event is newer than the answer to a question asked before it.
    let heardStatus = false
    let heardTabs = false
    void subscribeChromeStatus((next) => {
      heardStatus = true
      if (!cancelled) setStatus(next)
    })
      .then(keep)
      .catch(() => {})
    void subscribeChromeTabs((next) => {
      heardTabs = true
      if (!cancelled) setTabs(next)
    })
      .then(keep)
      .catch(() => {})
    chromeStatus()
      .then((current) => {
        if (!cancelled && !heardStatus) setStatus(current)
      })
      .catch(() => {})
    chromeTabs()
      .then((current) => {
        if (!cancelled && !heardTabs) setTabs(current)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      for (const off of offs) off()
    }
  }, [])

  const state = status?.state ?? "disconnected"
  const problem = status?.problem ?? null

  useEffect(() => {
    if (state === "connected") rememberConnected()
  }, [state])

  if (state === "disconnected" && !connectedBefore()) return null

  const run = async (action: () => Promise<ChromeStatus>) => {
    try {
      setStatus(await action())
    } catch (error) {
      toast.error(t("failed", { message: toErrorMessage(error) }))
    }
  }

  const statusLine =
    state === "connected"
      ? status?.product
        ? t("statusConnectedTo", { product: status.product })
        : t("statusConnected")
      : state === "waiting"
        ? t("statusWaiting")
        : t("statusDisconnected")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={t("title")}
          title={`${t("title")} · ${statusLine}`}
          className="relative flex items-center transition-colors hover:text-foreground"
        >
          <Chrome
            className={cn(
              "size-3.5",
              state === "connected" && "text-emerald-600 dark:text-emerald-400",
              state === "waiting" && "animate-pulse text-amber-500"
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 gap-2 p-2.5">
        <span className="flex items-center gap-1.5 truncate text-xs font-medium">
          {t("title")}
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
            {t("experimental")}
          </span>
        </span>

        <div className="flex items-center justify-between gap-2">
          <p
            role="status"
            className="min-w-0 truncate text-2xs text-muted-foreground"
          >
            {statusLine}
          </p>
          {state === "connected" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void run(chromeDisconnect)}
            >
              {t("disconnect")}
            </Button>
          ) : state === "waiting" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void run(chromeDisconnect)}
            >
              {t("cancel")}
            </Button>
          ) : (
            <Button size="xs" onClick={() => void run(() => chromeConnect())}>
              {t("connect")}
            </Button>
          )}
        </div>

        {problem ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-2xs text-amber-600 dark:text-amber-400">
            {/* The settings page has the steps and the paste box these
                problems point at; here they would point at nothing. */}
            {problem === "switch-off" || NEEDS_PASTE.has(problem)
              ? t("panelNeedsSettings")
              : t(PROBLEM_KEYS[problem])}
          </div>
        ) : null}

        {state === "connected" ? (
          <div className="overflow-hidden rounded-lg border">
            <div className="px-2 py-1.5">
              <p className="text-2xs font-medium">
                {t("tabsTitle", { count: tabs.length })}
              </p>
              <p className="text-3xs text-muted-foreground">
                {t("tabsHidden")}
              </p>
            </div>
            {tabs.length === 0 ? (
              <p className="border-t px-2 py-1.5 text-3xs text-muted-foreground">
                {t("tabsEmpty")}
              </p>
            ) : (
              <ul className="max-h-64 divide-y overflow-y-auto border-t">
                {tabs.map((tab) => (
                  <li
                    key={tab.id}
                    className="flex items-center gap-2 px-2 py-1.5"
                  >
                    <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-2xs font-medium">
                        {tab.title || tab.host}
                      </span>
                      <span className="block truncate text-3xs text-muted-foreground">
                        {tab.host}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => {
            setOpen(false)
            openSettingsWindow("browser").catch((err) => {
              console.error("[StatusBarChrome] failed to open settings:", err)
            })
          }}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {t("openSettings")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
