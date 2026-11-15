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
 * Under it, the switch for running agents' own code in the tabs they may act
 * on (`ChromeEvalPanelSwitch`, `docs/agent-chrome.md` 13.5), with its risk
 * spelled out; the same switch is on the settings page.
 *
 * In a remote window the switch also turns this computer's browser tools on
 * (`lendBrowserSwitch`): the server's agents reach Chrome through the tabs
 * the app lends, and the app lends none while its own switch is off.
 *
 * Under each tab an agent has been at, the last thing it did there, and the
 * whole record a click away (`chrome::activity`, `docs/agent-chrome.md`
 * 13.4): kept by the backend for as long as the connection lasts, asked for
 * when the panel opens and again on every `browser://agent-activity`. A line
 * says which field an input went into, never what was typed, and of a
 * password field only that it was one. A line of running code has the code
 * behind a disclosure of its own.
 *
 * Desktop only (Chrome is on the computer the app runs on), and there from
 * the start: the switch is in this panel, so hiding the glyph until the first
 * connection left a person told to "open the Chrome panel" with nothing to
 * open (2026-11-14). The panel connects, and links to the settings page for
 * the instructions a first connection may need.
 */

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronRight,
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
import { ChromeEvalPanelSwitch } from "@/components/settings/chrome-eval-switch"
import { useMinuteNow } from "@/hooks/use-minute-now"
import { openSettingsWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  browserWorkspaceTabId,
  useBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import {
  AGENT_OWNER_PREFIX,
  chromeActivate,
  chromeActivity,
  chromeAgents,
  chromeAgentsScope,
  chromeConnect,
  chromeDisconnect,
  chromeSetAgents,
  chromeShare,
  chromeStatus,
  chromeTabs,
  subscribeAgentActivity,
  subscribeChromeStatus,
  subscribeChromeTabs,
  type ChromeActivityEntry,
  type ChromeStatus,
  type ChromeTab,
} from "@/lib/browser/chrome-api"
import type { AgentAction, GrantLevel } from "@/lib/browser/types"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { lendBrowserSwitch } from "@/lib/cowork/remote-browser"
import { isDesktop } from "@/lib/platform"
import { formatTimeAgo } from "@/lib/relative-time"
import { cn } from "@/lib/utils"

/** The mark the browser uses for "an agent can reach this". */
const AGENT_MARK = "text-violet-600 dark:text-violet-400"

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

/** Agents on a server reach Chrome through the tabs this app lends it, which
 *  takes the app's own browser tools being on. Nothing to do in a local
 *  window; a failure leaves the switch as it is, to be seen in the list of
 *  computers. */
function lendBrowser() {
  lendBrowserSwitch("browser").catch((error) => {
    console.error("[StatusBarChrome] failed to lend the browser:", error)
  })
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
  const [activity, setActivity] = useState<
    Record<string, ChromeActivityEntry[]>
  >({})
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
      .then((on) => {
        if (on) lendBrowser()
        settle(on)
      })
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

  // What agents did, while the panel is open on a connected Chrome: asked
  // once, then again whenever an agent reaches for a tab. Answers come back
  // in the order asked, so the last one standing is the newest.
  useEffect(() => {
    if (!open || state !== "connected") return
    let cancelled = false
    let off: (() => void) | null = null
    const refresh = () => {
      chromeActivity()
        .then((next) => {
          if (!cancelled) setActivity(next)
        })
        .catch(() => {})
    }
    void subscribeAgentActivity(refresh)
      .then((unsubscribe) => {
        if (cancelled) unsubscribe()
        else off = unsubscribe
      })
      .catch(() => {})
    refresh()
    return () => {
      cancelled = true
      off?.()
    }
  }, [open, state])

  const share = async (tabId: string, level: GrantLevel) => {
    try {
      await chromeShare(tabId, level)
    } catch (error) {
      toast.error(t("shareFailed", { message: toErrorMessage(error) }))
    }
  }

  const switchAgents = async (on: boolean) => {
    try {
      const now = await chromeSetAgents(on)
      setAgents(now)
      rememberAgents(scope, on)
      if (now) lendBrowser()
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

        <ChromeEvalPanelSwitch open={open} />

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
                    activity={activity[tab.id] ?? EMPTY}
                    ownScope={scope}
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

const EMPTY: ChromeActivityEntry[] = []

/** One of Chrome's open pages, with what agents may do there and the way to
 *  change it — or, for a page an agent opened, the mark that says so — and
 *  what agents have done there. */
function ChromeTabRow({
  tab,
  activity,
  ownScope,
  onShare,
  onJump,
}: {
  tab: ChromeTab
  /** Oldest first. */
  activity: ChromeActivityEntry[]
  ownScope: string
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
    <li className="px-2 py-1.5">
      <div className="flex items-center gap-2">
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
      </div>
      {activity.length > 0 ? (
        <ChromeTabActivity
          activity={activity}
          ownScope={ownScope}
          tabHost={tab.host}
        />
      ) : null}
    </li>
  )
}

/** The panel's words for each action, and for one aimed at a named field or
 *  button. */
const ACTION_KEYS = {
  read: "activity.action.read",
  click: "activity.action.click",
  hover: "activity.action.hover",
  type: "activity.action.type",
  press: "activity.action.press",
  select: "activity.action.select",
  capture: "activity.action.capture",
  console: "activity.action.console",
  eval: "activity.action.eval",
  open: "activity.action.open",
  navigate: "activity.action.navigate",
  dialog: "activity.action.dialog",
  close: "activity.action.close",
  upload: "activity.action.upload",
  download: "activity.action.download",
} as const satisfies Record<AgentAction, string>

const ACTION_ON_KEYS = {
  click: "activity.actionOn.click",
  hover: "activity.actionOn.hover",
  type: "activity.actionOn.type",
  press: "activity.actionOn.press",
  select: "activity.actionOn.select",
  upload: "activity.actionOn.upload",
  download: "activity.actionOn.download",
} as const satisfies Partial<Record<AgentAction, string>>

type Translate = ReturnType<typeof useTranslations<"ChromeSettings">>

/** "clicked “Submit”", "typed into the password field", "read the page
 *  (refused)". */
function describeActivity(t: Translate, entry: ChromeActivityEntry): string {
  const onKey =
    entry.target && entry.action in ACTION_ON_KEYS
      ? ACTION_ON_KEYS[entry.action as keyof typeof ACTION_ON_KEYS]
      : null
  const target = entry.target
  const what =
    onKey && target && target.kind !== "code"
      ? t(onKey, {
          target:
            target.kind === "password"
              ? t("activity.password")
              : t("activity.named", { name: target.name }),
        })
      : t(ACTION_KEYS[entry.action])
  if (entry.outcome === "refused") return t("activity.refused", { what })
  if (entry.outcome === "failed") return t("activity.failed", { what })
  return what
}

/** Whose agent: this computer's, the server this window works on, or
 *  another window's server. */
function scopeLabel(t: Translate, scope: string, ownScope: string): string {
  if (scope === "local") return t("activity.scopeLocal")
  if (scope === ownScope) return t("activity.scopeThisServer")
  return t("activity.scopeOtherServer")
}

/** The last thing agents did on a tab, and the whole record behind a
 *  disclosure, newest first. */
function ChromeTabActivity({
  activity,
  ownScope,
  tabHost,
}: {
  activity: ChromeActivityEntry[]
  ownScope: string
  tabHost: string
}) {
  const t = useTranslations("ChromeSettings")
  const locale = useLocale()
  const [expanded, setExpanded] = useState(false)
  const now = useMinuteNow()
  const newestFirst = [...activity].reverse()
  const latest = newestFirst[0]
  if (!latest) return null
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="mt-0.5 pl-5.5">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-1 text-left text-3xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((was) => !was)}
      >
        <Chevron className="size-3 shrink-0" />
        <span className="min-w-0 truncate">
          {t("activity.latest", {
            time: formatTimeAgo(latest.at, now, locale),
            what: describeActivity(t, latest),
          })}
        </span>
      </button>
      {expanded ? (
        <ol
          aria-label={t("activity.title")}
          className="mt-1 max-h-40 space-y-0.5 overflow-y-auto"
        >
          {newestFirst.map((entry, index) => (
            <li
              key={`${entry.at}-${index}`}
              className={cn(
                "text-3xs",
                entry.outcome === "done"
                  ? "text-muted-foreground"
                  : "text-amber-600 dark:text-amber-400"
              )}
            >
              <span className="tabular-nums">
                {formatTimeAgo(entry.at, now, locale)}
              </span>
              {" · "}
              {scopeLabel(t, entry.scope, ownScope)}
              {" · "}
              {describeActivity(t, entry)}
              {entry.host && entry.host !== tabHost ? ` · ${entry.host}` : null}
              {entry.target?.kind === "code" ? (
                <ActivityCode code={entry.target.code} />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** The code an agent ran, behind its own disclosure: up to 4000
 *  characters, too much to show on every line. */
function ActivityCode({ code }: { code: string }) {
  const t = useTranslations("ChromeSettings")
  const [shown, setShown] = useState(false)
  return (
    <>
      {" · "}
      <button
        type="button"
        aria-expanded={shown}
        className="underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => setShown((was) => !was)}
      >
        {shown ? t("activity.hideCode") : t("activity.showCode")}
      </button>
      {shown ? (
        <pre className="mt-0.5 max-h-32 overflow-auto rounded border bg-muted/50 p-1 font-mono text-3xs whitespace-pre-wrap break-all text-foreground">
          {code}
        </pre>
      ) : null}
    </>
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
