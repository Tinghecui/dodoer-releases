"use client"

/**
 * "Sites agents can't use", a row of the "My own Chrome" card
 * (`docs/agent-chrome.md` 13.3): the sites agents are kept off in the
 * person's Chrome, whoever opened the tab.
 *
 * The default list in the groups the backend gives it (mail, accounts,
 * payments, banks, exchanges), one chip a site: a solid chip is kept off, a
 * dashed, struck-through one the person let go of; a click turns it over. A
 * switch a group lets the whole group go or keeps it all off again, and the
 * person's own sites sit in a group of their own with the box to add one. A
 * switch by the title pauses the list (agents may use every site, the list
 * kept as it is) until the person turns it back on. Nothing asks first: the
 * person decided on 2026-11-16 that every click takes effect at once. Every
 * change is the backend's (it keeps the list and lets go of a tab agents have
 * on a site now kept off); what it answers is what the row shows.
 *
 * A change made in another window — the switch in the sidebar's Chrome panel
 * most of all — reaches this row as `browser://chrome-sites`, so an open
 * settings page never shows a pause that is no longer so.
 *
 * An older app answers with neither groups nor the pause: its defaults show
 * as one "Default list" group, and there is no pause switch.
 */

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Plus, ShieldBan, X } from "lucide-react"
import { toast } from "sonner"

import { SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import {
  chromeSetSites,
  chromeSites,
  normalizeSite,
  subscribeChromeSites,
  type ChromeSiteEdits,
  type ChromeSiteGroup,
  type ChromeSites,
} from "@/lib/browser/chrome-sites"
import { cn } from "@/lib/utils"

type DraftProblem = "invalid" | "duplicate"

/** The group the person's own sites are in; not one of the backend's. */
const MINE = "mine"
/** The one group an older app's flat default list is shown as. */
const DEFAULTS = "defaults"
/** Open at first; the rest start folded. */
const OPEN_AT_FIRST = ["mail", "accounts"]

const GROUP_LABELS = {
  mail: "sitesGroupMail",
  accounts: "sitesGroupAccounts",
  payments: "sitesGroupPayments",
  banks: "sitesGroupBanks",
  exchanges: "sitesGroupExchanges",
  [MINE]: "sitesGroupMine",
  [DEFAULTS]: "sitesGroupDefaults",
} as const

function isKnownGroup(id: string): id is keyof typeof GROUP_LABELS {
  return Object.prototype.hasOwnProperty.call(GROUP_LABELS, id)
}

export function ChromeSitesSettings() {
  const t = useTranslations("ChromeSettings")
  const [sites, setSites] = useState<ChromeSites | null>(null)
  const [draft, setDraft] = useState("")
  const [problem, setProblem] = useState<DraftProblem | null>(null)
  const [open, setOpen] = useState<string[]>(OPEN_AT_FIRST)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    let off: (() => void) | null = null
    // A change made elsewhere (the sidebar's Chrome panel, another settings
    // window) comes as an event; it is newer than the answer to a question
    // asked before it.
    let heard = false
    void subscribeChromeSites((next) => {
      heard = true
      if (!cancelled) setSites(next)
    })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe()
        else off = unsubscribe
      })
      .catch(() => {})
    chromeSites()
      .then((current) => {
        if (!cancelled && !heard) setSites(current)
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(t("sitesFailed", { message: toErrorMessage(error) }))
        }
      })
    return () => {
      cancelled = true
      off?.()
    }
  }, [t])

  if (!sites) return null

  const groups: ChromeSiteGroup[] = sites.groups ?? [
    { id: DEFAULTS, sites: sites.defaults },
  ]
  /** Whether the app knows of the pause at all. */
  const canPause = typeof sites.paused === "boolean"
  const paused = sites.paused === true

  const groupLabel = (id: string) =>
    isKnownGroup(id) ? t(GROUP_LABELS[id]) : id

  /** Send the edits; the pause goes only when it is what changes. */
  const save = async (edits: ChromeSiteEdits): Promise<boolean> => {
    setSaving(true)
    try {
      setSites(await chromeSetSites(edits))
      return true
    } catch (error) {
      toast.error(t("sitesFailed", { message: toErrorMessage(error) }))
      return false
    } finally {
      setSaving(false)
    }
  }

  const setAllowed = (allowed: string[]) =>
    void save({ blocked: sites.blocked, allowed })

  const toggleSite = (site: string) =>
    setAllowed(
      sites.allowed.includes(site)
        ? sites.allowed.filter((entry) => entry !== site)
        : [...sites.allowed, site]
    )

  /** On keeps the whole group off; off lets all of it go. */
  const setGroupBlocked = (group: ChromeSiteGroup, block: boolean) =>
    setAllowed(
      block
        ? sites.allowed.filter((entry) => !group.sites.includes(entry))
        : [
            ...sites.allowed,
            ...group.sites.filter((site) => !sites.allowed.includes(site)),
          ]
    )

  const setPaused = (pause: boolean) =>
    void save({ blocked: sites.blocked, allowed: sites.allowed, paused: pause })

  const add = async () => {
    const site = normalizeSite(draft)
    if (!site) {
      setProblem("invalid")
      return
    }
    const alreadyKept =
      sites.blocked.includes(site) ||
      (sites.defaults.includes(site) && !sites.allowed.includes(site))
    if (alreadyKept) {
      setProblem("duplicate")
      return
    }
    // A default entry the person let go of comes back by being added; the
    // backend takes it off `allowed` and keeps it as a default.
    if (
      await save({ blocked: [...sites.blocked, site], allowed: sites.allowed })
    ) {
      setDraft("")
    }
  }

  const remove = (site: string) =>
    void save({
      blocked: sites.blocked.filter((entry) => entry !== site),
      allowed: sites.allowed,
    })

  const toggleOpen = (id: string) =>
    setOpen((shown) =>
      shown.includes(id)
        ? shown.filter((entry) => entry !== id)
        : [...shown, id]
    )

  const header = (
    id: string,
    count: number,
    allowedCount: number,
    control?: ReactNode
  ) => {
    const shown = open.includes(id)
    return (
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-expanded={shown}
          onClick={() => toggleOpen(id)}
        >
          {shown ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium text-foreground">{groupLabel(id)}</span>
          <span className="text-muted-foreground">
            {t("sitesGroupCount", { count })}
          </span>
          {allowedCount > 0 ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="text-amber-600 dark:text-amber-400">
                {allowedCount === count
                  ? t("sitesGroupAllowedAll")
                  : t("sitesGroupAllowedSome", { count: allowedCount })}
              </span>
            </>
          ) : null}
        </button>
        {control}
      </div>
    )
  }

  return (
    <SettingRow
      icon={ShieldBan}
      title={t("sitesTitle")}
      description={t("sitesHint")}
      className="max-w-2xl"
      control={
        canPause ? (
          <div className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                paused
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground"
              )}
            >
              {paused ? t("sitesPausedLabel") : t("sitesBlockingLabel")}
            </span>
            <Switch
              checked={!paused}
              disabled={saving}
              aria-label={t("sitesPauseSwitch")}
              onCheckedChange={(on) => setPaused(!on)}
            />
          </div>
        ) : undefined
      }
    >
      <div className="space-y-2 text-xs">
        {paused ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
            {t("sitesPausedNotice")}
          </p>
        ) : null}
        {/* Paused, the list stays in sight but nothing in it can be pressed:
            a disabled fieldset disables every control inside it. */}
        <fieldset
          disabled={paused}
          className={cn(
            "min-w-0 divide-y rounded-md border",
            paused && "opacity-50"
          )}
        >
          {groups.map((group) => {
            const allowedCount = group.sites.filter((site) =>
              sites.allowed.includes(site)
            ).length
            const blocking = allowedCount < group.sites.length
            const label = groupLabel(group.id)
            return (
              <section
                key={group.id}
                aria-label={label}
                className="space-y-2 p-2.5"
              >
                {header(
                  group.id,
                  group.sites.length,
                  allowedCount,
                  group.sites.length > 0 ? (
                    <Switch
                      checked={blocking}
                      disabled={saving}
                      aria-label={t("sitesGroupSwitch", { group: label })}
                      onCheckedChange={(on) => setGroupBlocked(group, on)}
                    />
                  ) : undefined
                )}
                {open.includes(group.id) ? (
                  <div className="flex flex-wrap gap-1.5 pl-5">
                    {group.sites.map((site) => {
                      const allowed = sites.allowed.includes(site)
                      return (
                        <button
                          key={site}
                          type="button"
                          disabled={saving}
                          aria-pressed={!allowed}
                          title={t(
                            allowed
                              ? "sitesChipAllowedHint"
                              : "sitesChipBlockedHint"
                          )}
                          className={cn(
                            "rounded-md border px-2 py-0.5 font-mono transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed",
                            allowed
                              ? "border-dashed border-amber-500/60 bg-transparent text-amber-600 line-through dark:text-amber-400"
                              : "border-border bg-muted text-foreground hover:bg-muted/70"
                          )}
                          onClick={() => toggleSite(site)}
                        >
                          {site}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </section>
            )
          })}

          <section aria-label={groupLabel(MINE)} className="space-y-2 p-2.5">
            {header(MINE, sites.blocked.length, 0)}
            {open.includes(MINE) ? (
              <div className="space-y-2 pl-5">
                {sites.blocked.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {sites.blocked.map((site) => (
                      <span
                        key={site}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-muted py-0.5 pr-1 pl-2 font-mono"
                      >
                        {site}
                        <button
                          type="button"
                          className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                          disabled={saving}
                          title={t("sitesRemove", { site })}
                          aria-label={t("sitesRemove", { site })}
                          onClick={() => remove(site)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <form
                  className="flex items-start gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void add()
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <Input
                      id="chrome-sites-add"
                      value={draft}
                      onChange={(event) => {
                        setDraft(event.target.value)
                        if (problem) setProblem(null)
                      }}
                      placeholder={t("sitesPlaceholder")}
                      aria-label={t("sitesAddLabel")}
                      aria-invalid={problem ? true : undefined}
                      className="h-8 bg-background font-mono text-xs"
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                    />
                    {problem ? (
                      <p className="mt-1 text-destructive">
                        {t(
                          problem === "duplicate"
                            ? "sitesDuplicate"
                            : "sitesInvalid"
                        )}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    className="bg-background"
                    disabled={saving || !draft.trim()}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("sitesAdd")}
                  </Button>
                </form>
              </div>
            ) : null}
          </section>
        </fieldset>
      </div>
    </SettingRow>
  )
}
