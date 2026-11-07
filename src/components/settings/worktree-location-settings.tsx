"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { FolderTree, Info, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DirectoryPathInput } from "@/components/shared/directory-path-input"
import { FolderSelect } from "@/components/shared/folder-select"
import { SettingNote } from "@/components/shared/setting-card"
import {
  listOpenFolderDetails,
  workTaskSettingsGet,
  workTaskSettingsGetOwn,
  workTaskSettingsSet,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { FolderDetail, WorkTaskFolderSettings } from "@/lib/types"

/** Sentinel folder id of the global-defaults settings row (backend contract,
 *  same as the task settings dialog). */
const GLOBAL_SCOPE = 0

/** The row a scope reads and writes, and whether a folder scope is only
 *  borrowing it from the global defaults. */
interface ScopeRow {
  settings: WorkTaskFolderSettings
  followsGlobal: boolean
}

/**
 * Where new worktrees are created — the work-task settings' `worktree_root`,
 * edited here because it is no longer only a task setting: the conversation
 * worktrees the branch menu opens land in the same place. Same storage as
 * before (the global row, or a project's own row), so the task engine keeps
 * reading it unchanged.
 *
 * Only `worktree_root` is changed on save; every other task setting in the
 * row is written back as loaded. A project that follows the global defaults
 * gets its own row on save, seeded from the global one — said up front in the
 * hint, because it also stops that project following later global changes.
 */
export function WorktreeLocationSettings() {
  const t = useTranslations("VersionControlSettings")
  const [folders, setFolders] = useState<FolderDetail[]>([])
  const [scope, setScope] = useState(GLOBAL_SCOPE)
  const [row, setRow] = useState<ScopeRow | null>(null)
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )
  const folder = useMemo(
    () =>
      scope === GLOBAL_SCOPE
        ? null
        : (projectFolders.find((f) => f.id === scope) ?? null),
    [projectFolders, scope]
  )

  useEffect(() => {
    let cancelled = false
    listOpenFolderDetails()
      .then((list) => {
        if (!cancelled) setFolders(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async (target: number): Promise<ScopeRow> => {
    const [own, global] = await Promise.all([
      target === GLOBAL_SCOPE
        ? Promise.resolve(null)
        : workTaskSettingsGetOwn(target),
      workTaskSettingsGet(GLOBAL_SCOPE),
    ])
    if (target === GLOBAL_SCOPE) {
      return { settings: global, followsGlobal: false }
    }
    return own
      ? { settings: own, followsGlobal: false }
      : { settings: global, followsGlobal: true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setRow(null)
    load(scope)
      .then((next) => {
        if (cancelled) return
        setRow(next)
        setValue(next.settings.worktree_root ?? "")
      })
      .catch((e) => {
        if (!cancelled)
          toast.error(t("loadFailed", { message: toErrorMessage(e) }))
      })
    return () => {
      cancelled = true
    }
  }, [scope, load, t])

  const saved = row?.settings.worktree_root ?? ""
  const dirty = row != null && value.trim() !== saved.trim()

  const save = async () => {
    if (!row) return
    setSaving(true)
    try {
      await workTaskSettingsSet(scope, {
        ...row.settings,
        // Blank = the default layout; stored as null, like the task dialog
        // always did, never as an empty directory name.
        worktree_root: value.trim() || null,
      })
      const next = await load(scope)
      setRow(next)
      setValue(next.settings.worktree_root ?? "")
      toast.success(t("saveSuccess"))
    } catch (e) {
      toast.error(t("saveFailed", { message: toErrorMessage(e) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <FolderTree className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("worktreeTitle")}</h2>
      </div>
      <p className="text-xs text-muted-foreground leading-5">
        {t("worktreeDescription")}
      </p>

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          {t("worktreeScope")}
        </span>
        <FolderSelect
          variant="field"
          className="h-8 w-60 max-w-none justify-between text-sm"
          folders={projectFolders}
          value={scope === GLOBAL_SCOPE ? null : scope}
          onChange={setScope}
          allLabel={t("worktreeScopeGlobal")}
          onSelectAll={() => setScope(GLOBAL_SCOPE)}
          title={t("worktreeScope")}
        />
      </div>

      <div className="space-y-2">
        <label
          htmlFor="vc-worktree-root"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("worktreeRoot")}
        </label>
        <div className="flex gap-2">
          <DirectoryPathInput
            id="vc-worktree-root"
            value={value}
            onValueChange={setValue}
            disabled={row == null || saving}
            placeholder={t("worktreeRootPlaceholder")}
            browseLabel={t("worktreeRootBrowse")}
            browserTitle={t("worktreeRoot")}
            initialPath={folder?.path ?? undefined}
            className="h-8 flex-1 bg-background font-mono text-xs"
          />
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t("save")
            )}
          </Button>
        </div>
        <p className="text-2xs text-muted-foreground leading-4">
          {t("worktreeRootHint")}
        </p>
        {row?.followsGlobal ? (
          <p className="text-2xs text-muted-foreground leading-4">
            {t("worktreeFollowsGlobal")}
          </p>
        ) : null}
      </div>

      <SettingNote icon={Info}>{t("worktreeSetupNote")}</SettingNote>
    </section>
  )
}
