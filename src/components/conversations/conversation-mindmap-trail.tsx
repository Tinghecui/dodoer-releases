"use client"

import { Fragment, useMemo } from "react"
import { ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { categoryPath } from "@/components/canvas/mindmap/mindmap-model"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  useConversationTaxonomyStore,
  useConversationTaxonomySync,
} from "@/stores/conversation-taxonomy-store"
import { useMindMapViewStore } from "@/stores/mindmap-view-store"

/**
 * jenny fork: the conversation's place in its project's mind map, as
 * breadcrumb steps between the folder and the title. A step opens the mind
 * map with that category unfolded and brought into view.
 */
export function ConversationMindMapTrail({
  conversationId,
  folderId,
}: {
  conversationId: number
  folderId: number
}) {
  const t = useTranslations("MindMap")
  // Outside the workbench (a detached view) there is no map to go to.
  const setRoute = useOptionalWorkbenchRoute()?.setRoute
  const focusCategory = useMindMapViewStore((s) => s.focusCategory)
  // The map belongs to the project: a worktree's conversations are its root's.
  const projectId = useAppWorkspaceStore((s) => {
    const folder = s.allFolders.find((f) => f.id === folderId)
    if (!folder || folder.kind === "chat") return null
    return folder.parent_id ?? folder.id
  })
  useConversationTaxonomySync(projectId)
  const taxonomy = useConversationTaxonomyStore((s) =>
    projectId == null ? null : (s.byFolder[projectId]?.taxonomy ?? null)
  )
  const path = useMemo(
    () => categoryPath(taxonomy, conversationId),
    [taxonomy, conversationId]
  )
  if (!setRoute || projectId == null || path.length === 0) return null

  return (
    <>
      {path.map((step, i) => (
        <Fragment key={step.id}>
          <button
            type="button"
            data-mindmap-trail={step.id}
            // Steps give way to the title: each one truncates first.
            className="min-w-0 max-w-40 shrink truncate rounded-md px-1 py-0.5 text-[0.8125rem] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            title={t("showInMindMap", { name: step.name })}
            aria-label={t("showInMindMap", { name: step.name })}
            onClick={() => {
              focusCategory(
                projectId,
                path.slice(0, i + 1).map((s) => s.id)
              )
              setRoute("canvas")
            }}
          >
            {step.name}
          </button>
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
            aria-hidden
          />
        </Fragment>
      ))}
    </>
  )
}
