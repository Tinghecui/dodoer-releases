"use client"

import { useState } from "react"
import { FolderPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { COWORK_BUILD } from "@/lib/cowork/brand"
import { useCoworkText } from "@/lib/cowork/i18n"
import { useCoworkInfo } from "@/lib/cowork/info"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/**
 * Cowork (AI QA #93): the first steps for a workspace with no project yet,
 * under the welcome page's title. A new employee lands on an empty workspace
 * where nothing says "make a project, then talk to an agent".
 *
 * Shown only while the workspace has no folder at all and goes away by itself
 * once the first one is open — no dismiss button (decided with the user).
 * Waits for the folder list to load, so it never flashes for someone who does
 * have projects.
 *
 * The folder dialog outlives the steps: creating the project fills the folder
 * list (and hides the steps) while the dialog is still on its second page, and
 * its "Done" is what lands the user in the new project.
 */
export function GettingStartedCard() {
  const folders = useAppWorkspaceStore((s) => s.folders)
  const hydrated = useAppWorkspaceStore((s) => s.foldersHydrated)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  if (!COWORK_BUILD) return null
  const showSteps = hydrated && folders.length === 0
  if (!showSteps && !folderDialogOpen) return null
  return (
    <>
      {showSteps && (
        <GettingStartedSteps onOpenProject={() => setFolderDialogOpen(true)} />
      )}
      <WorkspaceFolderDialog
        open={folderDialogOpen}
        onOpenChange={setFolderDialogOpen}
      />
    </>
  )
}

function GettingStartedSteps({ onOpenProject }: { onOpenProject: () => void }) {
  const t = useCoworkText()
  const projectsRoot = useCoworkInfo()?.projectsRoot ?? null
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()

  const steps = [
    {
      title: t("gettingStartedProject"),
      // The folder dialog leads with the "new project" form when the server
      // has a projects root (portal mode); otherwise it is a folder browser.
      hint: projectsRoot
        ? t("gettingStartedProjectHint", { root: projectsRoot })
        : t("gettingStartedProjectHintOpen"),
      action: (
        <Button size="sm" className="mt-1.5" onClick={onOpenProject}>
          <FolderPlus className="h-3.5 w-3.5" />
          {t("newOrOpenProject")}
        </Button>
      ),
    },
    { title: t("gettingStartedAgent"), hint: t("gettingStartedAgentHint") },
    {
      title: t("gettingStartedMessage"),
      hint: t("gettingStartedMessageHint", {
        key: formatShortcutLabel(shortcuts.send_message, isMac),
      }),
    },
  ]

  return (
    <section
      data-testid="cowork-getting-started"
      aria-labelledby="cowork-getting-started-title"
      className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3"
    >
      <h2
        id="cowork-getting-started-title"
        className="text-sm font-medium text-foreground"
      >
        {t("gettingStartedTitle")}
      </h2>
      <ol className="mt-2 space-y-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2.5">
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm text-foreground">{step.title}</p>
              <p className="text-xs text-muted-foreground">{step.hint}</p>
              {step.action}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
