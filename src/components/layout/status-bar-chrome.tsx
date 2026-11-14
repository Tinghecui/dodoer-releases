"use client"

/**
 * The person's own Chrome, at the foot of the sidebar
 * (`docs/agent-chrome.md`): whether the app is connected to it, and which web
 * pages it has open.
 *
 * The glyph is the state — green while connected, pulsing while Chrome's
 * dialog waits for an answer, plain otherwise — because "is the app still
 * attached to my browser?" is the one thing here a person should be able to
 * see without opening anything.
 *
 * The tab list is the person's alone: a title and a host name per tab, and
 * no agent is told of any of it. Each tab can be handed to agents from here —
 * to read, or to read and act — which puts that one tab in the browser
 * registry agents are served from, under the same id; its level is read back
 * from the built-in browser's tab states, where every other shared tab's is.
 * Any tab can be brought to the front from here, for the person to look at or
 * take over.
 *
 * The switch at the top lets this window's agents use the person's Chrome
 * (`chrome::lending`): the pages they open go to a Chrome window kept for
 * them, and are marked as theirs in the list. It is remembered per scope —
 * one for every local window, one per remote window — and told to the
 * backend again when the app starts, which keeps it only in memory.
 *
 * Desktop only (Chrome is on the computer the app runs on), and only once the
 * person has connected on this computer at least once: first connecting takes
 * the instructions on the settings page, which is where a person who has
 * never heard of it starts.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUpRight,
  Bot,
  ChevronDown,
  Chrome,
  Globe,
  Settings2,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import {
  NEEDS_PASTE,
  PROBLEM_KEYS,
} from "@/components/settings/chrome-connect-settings"
import { openSettingsWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  browserWorkspaceTabId,
  useBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import {
  AGENT_OWNER_PREFIX,
  chromeActivate,
  chromeAgents,
  chromeAgentsScope,
  chromeConnect,
  chromeDisconnect,
  chromeSetAgents,
  chromeShare,
  chromeStatus,
  chromeTabs,
  subscribeChromeStatus,
  subscribeChromeTabs,
  type ChromeStatus,
  type ChromeTab,
} from "@/lib/browser/chrome-api"
import type { GrantLevel } from "@/lib/browser/types"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { isDesktop } from "@/lib/platform"
import { cn } from "@/lib/utils"

/** The mark the browser uses for "an agent can reach this". */
const AGENT_MARK = "text-violet-600 dark:text-violet-400"

/** Set the first time this computer's app connects to Chrome. */
export const CONNECTED_BEFORE_KEY = "chrome:connected-before"

function connectedBefore(): boolean {
  try {
    return localStorage.getItem(CONNECTED_BEFORE_KEY) === "1"
  } catch {
    return false
  }
}

/** Where a scope's switch is remembered across restarts: the backend keeps
 *  it only for as long as the app runs. */
export function agentsKey(scope: string): string {
  return `chrome:agents:${scope}`
}

function rememberedAgents(scope: string): boolean {
  try {
    return localStorage.getItem(agentsKey(scope)) === "1"
  } catch {
    return false
  }
}

function rememberAgents(scope: string, on: boolean) {
  try {
    localStorage.setItem(agentsKey(scope), on ? "1" : "0")
  } catch {
    // Without storage the switch lasts until the app quits.
  }
}

function rememberConnected() {
  try {
    localStorage.setItem(CONNECTED_BEFORE_KEY, "1")
  } catch {
    // Without storage the glyph shows only while connected.
  }
}

export function StatusBarChrome({ className }: { className?: string }) {
  if (!isDesktop()) return null
  return <ChromeItem className={className} />
}

function ChromeItem({ className }: { className?: string }) {
  const t = useTranslations("ChromeSettings")
  const [status, setStatus] = useState<ChromeStatus | null>(null)
  const [tabs, setTabs] = useState<ChromeTab[]>([])
  const [open, setOpen] = useState(false)
  const [agents, setAgents] = useState(false)
  const scope = chromeAgentsScope(getCurrentWindowLabel())

  // The switch as the backend has it; once per app run, the remembered one
  // is handed back to it first.
  useEffect(() => {
    let cancelled = false
    const settle = (on: boolean) => {
      if (!cancelled) setAgents(on)
    }
    chromeAgents()
      .then((on) =>
        !on && rememberedAgents(scope) ? chromeSetAgents(true) : on
      )
      .then(settle)
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [scope])

  // Another window of the same scope may have changed it since.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    chromeAgents()
      .then((on) => {
        if (!cancelled) setAgents(on)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

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

  const share = async (tabId: string, level: GrantLevel) => {
    try {
      await chromeShare(tabId, level)
    } catch (error) {
      toast.error(t("shareFailed", { message: toErrorMessage(error) }))
    }
  }

  const switchAgents = async (on: boolean) => {
    try {
      setAgents(await chromeSetAgents(on))
      rememberAgents(scope, on)
    } catch (error) {
      toast.error(t("agentsFailed", { message: toErrorMessage(error) }))
    }
  }

  const jump = async (tabId: string) => {
    try {
      await chromeActivate(tabId)
    } catch (error) {
      toast.error(t("jumpFailed", { message: toErrorMessage(error) }))
    }
  }

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
          className={cn(
            "relative flex shrink-0 items-center transition-colors hover:text-foreground",
            className
          )}
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
      <PopoverContent side="top" align="start" className="w-80 gap-2 p-2.5">
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

        <div className="rounded-lg border px-2 py-1.5">
          <label className="flex items-center justify-between gap-2">
            <span className="text-2xs font-medium">{t("agentsSwitch")}</span>
            <Switch
              checked={agents}
              onCheckedChange={(on) => void switchAgents(on)}
            />
          </label>
          <p className="mt-0.5 text-3xs text-muted-foreground">
            {agents && state !== "connected"
              ? t("agentsOffline")
              : t("agentsHint")}
          </p>
        </div>

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
                  <ChromeTabRow
                    key={tab.id}
                    tab={tab}
                    onShare={(level) => void share(tab.id, level)}
                    onJump={() => void jump(tab.id)}
                  />
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

/** One of Chrome's open pages, with what agents may do there and the way to
 *  change it — or, for a page an agent opened, the mark that says so. */
function ChromeTabRow({
  tab,
  onShare,
  onJump,
}: {
  tab: ChromeTab
  onShare: (level: GrantLevel) => void
  onJump: () => void
}) {
  const t = useTranslations("ChromeSettings")
  const state = useBrowserTabState(browserWorkspaceTabId(tab.id))
  const level = state?.agentGrant?.level ?? "none"
  const name = tab.title || tab.host
  const openedByAgent =
    state?.ownerWindow.startsWith(AGENT_OWNER_PREFIX) ?? false
  const Icon = openedByAgent ? Bot : Globe
  return (
    <li className="flex items-center gap-2 px-2 py-1.5">
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          level === "none" && !openedByAgent
            ? "text-muted-foreground"
            : AGENT_MARK
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs font-medium">{name}</span>
        <span className="block truncate text-3xs text-muted-foreground">
          {openedByAgent ? `${t("openedByAgent")} · ${tab.host}` : tab.host}
        </span>
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`${t("jumpTo")} · ${name}`}
        title={t("jumpTo")}
        onClick={onJump}
      >
        <ArrowUpRight className="size-3" />
      </Button>
      {openedByAgent ? null : (
        <ChromeShareMenu level={level} name={name} onShare={onShare} />
      )}
    </li>
  )
}

/** Hand a tab of the person's to agents, change the level, or take it
 *  back. */
function ChromeShareMenu({
  level,
  name,
  onShare,
}: {
  level: GrantLevel
  name: string
  onShare: (level: GrantLevel) => void
}) {
  const t = useTranslations("ChromeSettings")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`${t("share")} · ${name}`}
          className={cn(
            level === "read" && AGENT_MARK,
            level === "control" && "text-red-600 dark:text-red-400"
          )}
        >
          {level === "none"
            ? t("share")
            : level === "read"
              ? t("levelRead")
              : t("levelControl")}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem
          disabled={level === "read"}
          onSelect={() => onShare("read")}
        >
          {t("shareRead")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={level === "control"}
          onSelect={() => onShare("control")}
        >
          {t("shareControl")}
        </DropdownMenuItem>
        {level === "none" ? null : (
          <DropdownMenuItem onSelect={() => onShare("none")}>
            {t("stopSharing")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
