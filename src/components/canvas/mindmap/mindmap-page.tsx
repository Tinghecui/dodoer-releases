"use client"

import { useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import { formatDistance } from "date-fns"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  CircleHelp,
  Hand,
  Loader2,
  Maximize,
  Moon,
  Network,
  Search,
  Sparkles,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listUnopenableConversations } from "@/lib/api"
import { dateFnsLocale } from "@/lib/date-fns-locale"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import type { FolderDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  useConversationTaxonomyStore,
  useConversationTaxonomySync,
} from "@/stores/conversation-taxonomy-store"
import { useMindMapViewStore } from "@/stores/mindmap-view-store"
import { useTabStore } from "@/stores/tab-store"
import {
  WorkbenchStripPortal,
  WorkbenchStripScope,
  useWorkbenchStripTarget,
} from "@/components/workbench/workbench-strip-slot"
import { useNow } from "../canvas-board-list"
import { isCanvasEligible } from "../canvas-model"
import { CanvasModeSwitch } from "./canvas-mode-switch"
import {
  buildMindMapTree,
  foldSetFor,
  mindMapProjects,
  projectConversations,
} from "./mindmap-model"

/** React Flow stays out of the first-paint chunk, as on the canvas. */
const MindMapView = dynamic(() => import("./mindmap-view"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
    </div>
  ),
})

/** The project `folderId` belongs to: itself, or the root of a worktree. */
function projectOf(
  allFolders: readonly FolderDetail[],
  folderId: number | null
): FolderDetail | null {
  if (folderId == null) return null
  const f = allFolders.find((x) => x.id === folderId)
  const root =
    f?.parent_id != null ? allFolders.find((x) => x.id === f.parent_id) : f
  return root && root.kind !== "chat" ? root : null
}

/**
 * jenny fork: the canvas route's conversation mind map — one project's
 * conversations sorted into its categories, XMind-style. The categories come
 * from the nightly Codex reorganization; Jev places new conversations during
 * the day; a conversation can be moved by hand from its menu.
 */
export function MindMapPage() {
  const t = useTranslations("MindMap")
  const locale = useLocale()
  const now = useNow()
  const openFolders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  // The folder of the conversation in front of the user. A draft does not
  // count: an empty "new chat" in a default folder says nothing of the work.
  const activeFolderId = useTabStore((s) => {
    const tab = s.rawTabs.find((t) => t.id === s.activeTabId)
    return tab?.conversationId != null ? tab.folderId : null
  })
  const remembered = useMindMapViewStore((s) => s.projectId)
  const setProject = useMindMapViewStore((s) => s.setProject)
  const setCollapsed = useMindMapViewStore((s) => s.setCollapsed)

  const projects = useMemo(() => mindMapProjects(openFolders), [openFolders])
  // A pick from the list holds while the page stays open. Entering the page
  // follows the conversation in front of the user; without one, the project
  // shown last; else the first open project.
  const [picked, setPicked] = useState<number | null>(null)
  const project = useMemo(
    () =>
      projectOf(allFolders, picked) ??
      projectOf(allFolders, activeFolderId) ??
      projectOf(allFolders, remembered) ??
      projects[0] ??
      null,
    [allFolders, picked, activeFolderId, remembered, projects]
  )
  // A project picked from the list may be closed later; keep it pickable.
  const options = useMemo(
    () =>
      project && !projects.some((p) => p.id === project.id)
        ? [project, ...projects]
        : projects,
    [project, projects]
  )

  // The folds are remembered under the project shown, so keep it on record.
  useEffect(() => {
    if (project && project.id !== remembered) setProject(project.id)
  }, [project, remembered, setProject])

  useConversationTaxonomySync(project?.id ?? null)
  const entry = useConversationTaxonomyStore((s) =>
    project ? s.byFolder[project.id] : undefined
  )
  const fetchTaxonomy = useConversationTaxonomyStore((s) => s.fetch)
  const taxonomy = entry?.taxonomy ?? null

  const members = useMemo(
    () =>
      project
        ? projectConversations(project.id, allFolders, conversations)
        : [],
    [project, allFolders, conversations]
  )
  const counts = useMemo(() => {
    const byRoot = new Map<number, number>()
    const rootOf = new Map(allFolders.map((f) => [f.id, f.parent_id ?? f.id]))
    for (const c of conversations) {
      if (!isCanvasEligible(c)) continue
      const root = rootOf.get(c.folder_id)
      if (root != null) byRoot.set(root, (byRoot.get(root) ?? 0) + 1)
    }
    return byRoot
  }, [allFolders, conversations])

  // Which of them would open empty (their session file is gone). Asked again
  // when the project or its conversation count changes; until the answer is
  // in (or if it fails) nothing is folded away.
  const [unopenable, setUnopenable] = useState<{
    projectId: number
    ids: ReadonlySet<number>
  } | null>(null)
  const projectId = project?.id ?? null
  const memberCount = members.length
  useEffect(() => {
    if (projectId == null) return
    let cancelled = false
    listUnopenableConversations(projectId)
      .then((ids) => {
        if (!cancelled) setUnopenable({ projectId, ids: new Set(ids) })
      })
      .catch((err) => {
        console.warn("[mindmap] could not list unopenable conversations", err)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, memberCount])
  const unopenableIds = useMemo<ReadonlySet<number>>(
    () =>
      unopenable && unopenable.projectId === projectId
        ? unopenable.ids
        : new Set(),
    [unopenable, projectId]
  )

  const [query, setQuery] = useState("")
  const [fitSignal, setFitSignal] = useState(0)

  const foldAll = (folded: boolean) => {
    const tree = buildMindMapTree({
      taxonomy,
      conversations: members,
      unopenable: unopenableIds,
    })
    setCollapsed(foldSetFor(tree, folded))
    setFitSignal((n) => n + 1)
  }
  const expandAll = () => foldAll(false)
  const collapseAll = () => foldAll(true)

  const organizedAt = Date.parse(taxonomy?.reorganized_at ?? "")
  // Nothing to say until the map is in.
  const status = !taxonomy
    ? ""
    : Number.isNaN(organizedAt)
      ? t("neverReorganized")
      : t("lastReorganized", {
          time:
            now === 0
              ? new Date(organizedAt).toLocaleString(locale)
              : // Never "in 2 seconds": the server's clock may run a moment ahead.
                formatDistance(Math.min(organizedAt, now), now, {
                  addSuffix: true,
                  locale: dateFnsLocale(locale),
                }),
        })

  if (projects.length === 0 && !project) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader>
          <CanvasModeSwitch />
        </PageHeader>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <Network
            className="size-10 text-muted-foreground/40"
            aria-hidden="true"
          />
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("noProjects")}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-mindmap-page>
      <PageHeader>
        <CanvasModeSwitch />
        <Select
          value={project ? String(project.id) : undefined}
          onValueChange={(v) => {
            setQuery("")
            setPicked(Number(v))
          }}
        >
          <SelectTrigger
            size="sm"
            className="max-w-48 shrink-0 text-xs"
            aria-label={t("project")}
            data-mindmap-project
          >
            <SelectValue placeholder={t("project")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((f) => (
              <SelectItem
                key={f.id}
                value={String(f.id)}
                badge={String(counts.get(f.id) ?? 0)}
                className="text-xs"
              >
                {formatFolderLabelWithAlias(f)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative shrink-0">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="h-8 w-48 pl-8 text-xs"
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={expandAll}
            title={t("expandAll")}
            aria-label={t("expandAll")}
            data-mindmap-expand-all
          >
            <ChevronsUpDown className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={collapseAll}
            title={t("collapseAll")}
            aria-label={t("collapseAll")}
            data-mindmap-collapse-all
          >
            <ChevronsDownUp className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setFitSignal((n) => n + 1)}
            title={t("fitView")}
            aria-label={t("fitView")}
            data-mindmap-fit
          >
            <Maximize className="size-4" />
          </Button>
        </div>
        {/* When the map was last sorted lives in the help card: in the
            window's top strip there is no room to spare for a sentence. */}
        <div className="ml-auto flex shrink-0 items-center">
          <HowItWorks
            status={status}
            summary={taxonomy?.reorganize_summary ?? null}
          />
        </div>
      </PageHeader>

      {entry?.error && (
        <div
          className="flex items-center gap-3 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 truncate">
            {t("loadFailed", { message: entry.error })}
          </span>
          {project && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => void fetchTaxonomy(project.id)}
            >
              {t("retry")}
            </Button>
          )}
        </div>
      )}
      {!entry?.error &&
        taxonomy &&
        taxonomy.categories.length === 0 &&
        members.length > 0 && (
          <div
            className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
            data-mindmap-not-organized
          >
            <Moon className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{t("notOrganized")}</span>
          </div>
        )}

      <div className="relative min-h-0 flex-1">
        {project && members.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            {t("emptyProject")}
          </div>
        ) : project && !taxonomy && !entry?.error ? (
          // Not the map until its categories are in: drawn without them, every
          // conversation would flash under "Unclassified" and be fitted so.
          <div
            className="flex h-full items-center justify-center"
            data-mindmap-loading
          >
            <Loader2
              className="size-5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          </div>
        ) : project ? (
          <>
            <MindMapView
              projectKey={project.id}
              projectLabel={formatFolderLabelWithAlias(project)}
              conversations={members}
              taxonomy={taxonomy}
              unopenable={unopenableIds}
              query={query}
              fitSignal={fitSignal}
            />
            {query.trim() && (
              <NoMatchHint
                query={query}
                members={members}
                taxonomy={taxonomy}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

/** The view's controls: in the window's top strip beside the title on the
 *  desktop, a row of their own on a phone. */
export function PageHeader({ children }: { children: React.ReactNode }) {
  return (
    <WorkbenchStripScope active>
      <PageHeaderRow>{children}</PageHeaderRow>
    </WorkbenchStripScope>
  )
}

function PageHeaderRow({ children }: { children: React.ReactNode }) {
  const inStrip = useWorkbenchStripTarget() != null
  return (
    <WorkbenchStripPortal>
      <div
        data-mindmap-header=""
        className={
          inStrip
            ? "flex min-w-0 flex-1 items-center gap-2 pr-2"
            : "flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
        }
      >
        {children}
      </div>
    </WorkbenchStripPortal>
  )
}

function NoMatchHint({
  query,
  members,
  taxonomy,
}: {
  query: string
  members: Parameters<typeof buildMindMapTree>[0]["conversations"]
  taxonomy: Parameters<typeof buildMindMapTree>[0]["taxonomy"]
}) {
  const t = useTranslations("MindMap")
  const total = useMemo(
    () => buildMindMapTree({ taxonomy, conversations: members, query }).total,
    [taxonomy, members, query]
  )
  if (total > 0) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center">
      <p className="rounded-full bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm ring-1 ring-border">
        {t("noMatches", { query: query.trim() })}
      </p>
    </div>
  )
}

function HowItWorks({
  status,
  summary,
}: {
  status: string
  summary: string | null
}) {
  const t = useTranslations("MindMap")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("howItWorks")}
          title={t("howItWorks")}
        >
          <CircleHelp className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-xs">
        <p className="mb-2 text-sm font-semibold">{t("howItWorks")}</p>
        {status && (
          <p className="mb-2 text-muted-foreground" data-mindmap-status>
            {status}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          <li className="flex gap-2">
            <Moon
              className="mt-0.5 size-3.5 shrink-0 text-indigo-500"
              aria-hidden="true"
            />
            <span>{t("howItWorksNightly")}</span>
          </li>
          <li className="flex gap-2">
            <Sparkles
              className="mt-0.5 size-3.5 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <span>{t("howItWorksJev")}</span>
          </li>
          <li className="flex gap-2">
            <Hand
              className="mt-0.5 size-3.5 shrink-0 text-sky-500"
              aria-hidden="true"
            />
            <span>{t("howItWorksManual")}</span>
          </li>
        </ul>
        {summary && (
          <div className="mt-3 border-t pt-2">
            <p className="font-medium">{t("summaryLabel")}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
              {summary}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
