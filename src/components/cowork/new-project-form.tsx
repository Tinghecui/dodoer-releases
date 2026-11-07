"use client"

import { useState } from "react"
import { FolderPlus, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toErrorMessage } from "@/lib/app-error"
import { useCoworkText } from "@/lib/cowork/i18n"
import { coworkCreateProject, validateProjectName } from "@/lib/cowork/info"
import type { FolderDetail } from "@/lib/types"

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
      setError(`${t("createFailed")}: ${toErrorMessage(err)}`)
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
