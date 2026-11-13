"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderPlus, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toErrorMessage } from "@/lib/app-error"
import { useCoworkText } from "@/lib/cowork/i18n"
import {
  coworkCreateProject,
  isProjectExistsError,
  validateProjectName,
} from "@/lib/cowork/info"
import type { FolderDetail } from "@/lib/types"
import { useTabStore } from "@/stores/tab-store"

interface CoworkNewProjectFormProps {
  /** Shown in the hint; projects are created directly under it. */
  projectsRoot: string
  disabled?: boolean
  onCreated: (folder: FolderDetail) => void | Promise<void>
}

/**
 * "New project" in Cowork mode: ask only for a name, let the server create
 * `<projectsRoot>/<name>` and open it. Sits above the regular folder browser.
 */
export function CoworkNewProjectForm({
  projectsRoot,
  disabled,
  onCreated,
}: CoworkNewProjectFormProps) {
  const t = useCoworkText()
  // The dialog's own label for the button that opens the selected folder.
  const tDialog = useTranslations("Folder.workspaceDialog")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (creating || disabled) return
    const issue = validateProjectName(name)
    if (issue) {
      setError(t(issue === "empty" ? "nameEmpty" : "nameInvalid"))
      return
    }
    setError(null)
    setCreating(true)
    try {
      const folder = await coworkCreateProject(name)
      setName("")
      await onCreated(folder)
    } catch (err) {
      // A taken name is not reused: say so, and how to open what is there
      // (the folder browser right below this form starts in the same root).
      setError(
        isProjectExistsError(err)
          ? t("projectExists", { name: name.trim(), next: tDialog("next") })
          : `${t("createFailed")}: ${toErrorMessage(err)}`
      )
    } finally {
      setCreating(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-1.5 rounded-md border border-border p-3"
      data-testid="cowork-new-project"
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <FolderPlus className="h-3.5 w-3.5 shrink-0" />
        {t("newProject")}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          placeholder={t("projectNamePlaceholder")}
          aria-label={t("projectNamePlaceholder")}
          disabled={disabled || creating}
          autoFocus
        />
        <Button type="submit" disabled={disabled || creating || !name.trim()}>
          {creating ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("create")}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : (
        <p className="truncate text-xs text-muted-foreground">
          {t("newProjectHint", { root: projectsRoot })}
        </p>
      )}
      <p className="pt-1 text-xs text-muted-foreground">
        {t("orOpenExisting")}
      </p>
    </form>
  )
}

/**
 * Cowork: land in the project the dialog just opened. The dialog hands every
 * root it opens in this session to `remember` — a project the form created
 * as well as an existing folder picked in the list (#177; it used to be the
 * created ones only, see .cowork/journal/2026-11-13-open-folder-switches.md)
 * — and calls `openIfOpened` when it is closed with "Done": if the folder it
 * ended up on is that one, a new conversation tab is opened on it, so the
 * main area and the title switch to it. A dialog opened to manage an existing
 * folder's links never opens a root, so its "Done" moves nothing.
 */
export function useCoworkOpenedProject(open: boolean) {
  const openNewConversationTab = useTabStore((s) => s.openNewConversationTab)
  const openedIdRef = useRef<number | null>(null)

  // Each time the dialog opens is a new session: forget the last folder.
  useEffect(() => {
    if (open) openedIdRef.current = null
  }, [open])

  const remember = useCallback((folder: FolderDetail) => {
    openedIdRef.current = folder.id
  }, [])

  const openIfOpened = useCallback(
    (root: FolderDetail | null) => {
      const openedId = openedIdRef.current
      openedIdRef.current = null
      if (root && root.id === openedId) {
        openNewConversationTab(root.id, root.path)
      }
    },
    [openNewConversationTab]
  )

  return { remember, openIfOpened }
}
