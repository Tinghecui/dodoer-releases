"use client"

/**
 * "Sites agents can't use", a row of the "My own Chrome" card
 * (`docs/agent-chrome.md` 13.3): the sites agents are kept off in the
 * person's Chrome, whoever opened the tab.
 *
 * Two edits to the list the app ships with: sites the person adds, and
 * default entries they let agents use after all. Letting one go is asked
 * about first — an agent would be on that site with the person's sign-ins.
 * Adding, removing and blocking again are not: each of those only keeps
 * agents off more. Every change is the backend's at once (it keeps the list
 * and lets go of a tab agents have on a site now kept off); what it answers
 * is what the row shows.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Plus, ShieldBan, X } from "lucide-react"
import { toast } from "sonner"

import { SettingRow } from "@/components/shared/setting-card"
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
import { Input } from "@/components/ui/input"
import { toErrorMessage } from "@/lib/app-error"
import {
  chromeSetSites,
  chromeSites,
  normalizeSite,
  type ChromeSiteEdits,
  type ChromeSites,
} from "@/lib/browser/chrome-sites"

type DraftProblem = "invalid" | "duplicate"

export function ChromeSitesSettings() {
  const t = useTranslations("ChromeSettings")
  const [sites, setSites] = useState<ChromeSites | null>(null)
  const [draft, setDraft] = useState("")
  const [problem, setProblem] = useState<DraftProblem | null>(null)
  const [showDefaults, setShowDefaults] = useState(false)
  /** The default entry the person asked to let go of, until they answer. */
  const [confirmAllow, setConfirmAllow] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    chromeSites()
      .then((current) => {
        if (!cancelled) setSites(current)
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(t("sitesFailed", { message: toErrorMessage(error) }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [t])

  const stillBlocked = useMemo(
    () =>
      sites
        ? sites.defaults.filter((site) => !sites.allowed.includes(site))
        : [],
    [sites]
  )

  if (!sites) return null

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

  const add = async () => {
    const site = normalizeSite(draft)
    if (!site) {
      setProblem("invalid")
      return
    }
    const alreadyKept =
      sites.blocked.includes(site) || stillBlocked.includes(site)
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

  const blockAgain = (site: string) =>
    void save({
      blocked: sites.blocked,
      allowed: sites.allowed.filter((entry) => entry !== site),
    })

  const allow = async (site: string) => {
    if (
      await save({ blocked: sites.blocked, allowed: [...sites.allowed, site] })
    ) {
      setConfirmAllow(null)
    }
  }

  return (
    <SettingRow
      icon={ShieldBan}
      title={t("sitesTitle")}
      description={t("sitesHint")}
      htmlFor="chrome-sites-add"
    >
      <div className="space-y-3 text-xs">
        <section className="space-y-1.5" aria-label={t("sitesBlockedTitle")}>
          <p className="font-medium text-foreground">
            {t("sitesBlockedTitle")}
          </p>
          {sites.blocked.length === 0 ? (
            <p className="text-muted-foreground">{t("sitesBlockedEmpty")}</p>
          ) : (
            <ul className="space-y-1">
              {sites.blocked.map((site) => (
                <li key={site} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate">{site}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={saving}
                    title={t("sitesRemove", { site })}
                    aria-label={t("sitesRemove", { site })}
                    onClick={() => remove(site)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
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
                    problem === "duplicate" ? "sitesDuplicate" : "sitesInvalid"
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
        </section>

        {sites.allowed.length > 0 ? (
          <section className="space-y-1.5" aria-label={t("sitesAllowedTitle")}>
            <p className="font-medium text-foreground">
              {t("sitesAllowedTitle")}
            </p>
            <ul className="space-y-1">
              {sites.allowed.map((site) => (
                <li key={site} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate">{site}</code>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="bg-background"
                    disabled={saving}
                    aria-label={t("sitesBlockAgainSite", { site })}
                    onClick={() => blockAgain(site)}
                  >
                    {t("sitesBlockAgain")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-ml-2 text-muted-foreground"
            aria-expanded={showDefaults}
            onClick={() => setShowDefaults((shown) => !shown)}
          >
            {showDefaults ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {t("sitesDefaultsTitle", { count: stillBlocked.length })}
          </Button>
          {showDefaults ? (
            <ul className="space-y-1" aria-label={t("sitesDefaultsLabel")}>
              {stillBlocked.map((site) => (
                <li key={site} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate text-muted-foreground">
                    {site}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="bg-background"
                    disabled={saving}
                    aria-label={t("sitesAllowSite", { site })}
                    onClick={() => setConfirmAllow(site)}
                  >
                    {t("sitesAllow")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <AlertDialog
        open={confirmAllow !== null}
        onOpenChange={(open) => {
          if (!saving && !open) setConfirmAllow(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sitesAllowConfirmTitle", { site: confirmAllow ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sitesAllowConfirmDescription", { site: confirmAllow ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              {t("cancel")}
            </AlertDialogCancel>
            {/* Stays open until the backend answers, so a failure toast has
                the dialog it belongs to still on screen. */}
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault()
                if (confirmAllow) void allow(confirmAllow)
              }}
            >
              {t("sitesAllowConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingRow>
  )
}
