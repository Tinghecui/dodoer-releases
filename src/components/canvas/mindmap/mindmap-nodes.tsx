"use client"

import { createContext, memo, useContext } from "react"
import {
  BaseEdge,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import {
  ChevronDown,
  ChevronRight,
  FileX2,
  Hand,
  MoreHorizontal,
  Sparkles,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationActivityBadge } from "@/components/conversations/conversation-activity-badge"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { UnreadDot } from "@/components/conversations/sidebar-unread-badge"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  UNOPENABLE_CATEGORY_ID,
  type TaxonomyAssignment,
} from "@/lib/conversation-taxonomy"
import { formatConversationTitle } from "@/lib/conversation-title"
import type { DbConversationSummary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAwaitingUser } from "@/stores/awaiting-user-store"
import { useIsConversationUnread } from "@/stores/conversation-seen-store"
import type { MindMapCategory } from "./mindmap-model"

/** What the nodes can do, provided once by the view instead of riding in
 *  every node's data. */
export interface MindMapActions {
  openConversation: (conversation: DbConversationSummary) => void
  toggleCategory: (categoryId: string) => void
  showMore: (category: MindMapCategory) => void
  moveConversation: (conversationId: number, categoryId: string | null) => void
  fit: () => void
  /** Move targets, depth-first, for the leaf menu. */
  categoryRows: { id: string; name: string; depth: number }[]
  assignmentOf: (conversationId: number) => TaxonomyAssignment | null
  /** The clock the leaves' relative times read (0 before the first tick). */
  now: number
}

const MindMapActionsContext = createContext<MindMapActions | null>(null)
export const MindMapActionsProvider = MindMapActionsContext.Provider

function useActions(): MindMapActions {
  const actions = useContext(MindMapActionsContext)
  if (!actions) throw new Error("mind map nodes need MindMapActionsProvider")
  return actions
}

/** The map grows one way: every edge leaves its parent on the right and
 *  enters its child on the left. Invisible: the map is not edited by wiring. */
function Handles() {
  const hidden =
    "!pointer-events-none !h-px !w-px !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0"
  return (
    <>
      <Handle
        id="s"
        type="source"
        position={Position.Right}
        className={hidden}
      />
      <Handle
        id="t"
        type="target"
        position={Position.Left}
        className={hidden}
      />
    </>
  )
}

/**
 * Every node's root. React Flow turns pointer events off on a node that is
 * neither selectable nor draggable (none here are), and that would leave the
 * buttons inside dead; turning them back on below its wrapper keeps the
 * wrapper itself inert, so panning over the map still works.
 */
const NODE_ROOT = "canvas-board-units pointer-events-auto h-full w-full"

/** The map's quiet greys, darkest at the root: a logic chart in one ink. */
const ROOT_FILL =
  "bg-neutral-300 text-neutral-900 dark:bg-neutral-600 dark:text-neutral-50"
const CATEGORY_FILL =
  "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-50"
const LEAF_FILL =
  "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"

// ── root ────────────────────────────────────────────────────────────────────

export interface MindMapRootData extends Record<string, unknown> {
  label: string
  total: number
}
export type MindMapRootNode = Node<MindMapRootData, "mmRoot">

export const MindMapRoot = memo(function MindMapRoot({
  data,
}: NodeProps<MindMapRootNode>) {
  const t = useTranslations("MindMap")
  const { fit } = useActions()
  return (
    <div className={NODE_ROOT}>
      <Handles />
      <button
        type="button"
        data-mindmap-root
        onClick={fit}
        title={t("fitView")}
        className={cn(
          "nodrag flex h-full w-full flex-col items-center justify-center rounded-xl px-5 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-sky-400",
          ROOT_FILL
        )}
      >
        <span className="max-w-full truncate text-lg font-semibold leading-tight">
          {data.label}
        </span>
        <span className="text-xs leading-tight opacity-60">
          {t("conversationCount", { count: data.total })}
        </span>
      </button>
    </div>
  )
})

// ── category ────────────────────────────────────────────────────────────────

export interface MindMapCategoryData extends Record<string, unknown> {
  category: MindMapCategory
  label: string
  /** Just brought into view from a conversation's breadcrumb. */
  focused?: boolean
}
export type MindMapCategoryNode = Node<MindMapCategoryData, "mmCategory">

export const MindMapCategoryPill = memo(function MindMapCategoryPill({
  data,
}: NodeProps<MindMapCategoryNode>) {
  const t = useTranslations("MindMap")
  const { toggleCategory } = useActions()
  const { category, label, focused } = data
  const top = category.depth === 1
  const unopenable = category.id === UNOPENABLE_CATEGORY_ID
  const hasChildren =
    category.children.length > 0 ||
    category.leaves.length > 0 ||
    category.hiddenLeaves > 0
  const rule =
    category.rule ?? t(unopenable ? "unopenableRule" : "unclassifiedRule")
  return (
    <div className={NODE_ROOT}>
      <Handles />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-mindmap-category={category.id}
            data-collapsed={category.collapsed ? "true" : undefined}
            aria-expanded={hasChildren ? !category.collapsed : undefined}
            aria-label={t("toggleCategory", { name: label })}
            onClick={() => toggleCategory(category.id)}
            className={cn(
              "nodrag flex h-full w-full items-center gap-1.5 rounded-lg px-3 text-left outline-none transition-[box-shadow,background-color] hover:shadow-md focus-visible:ring-2 focus-visible:ring-sky-400",
              unopenable
                ? "border border-dashed border-neutral-400 bg-transparent text-muted-foreground dark:border-neutral-500"
                : CATEGORY_FILL,
              !top && !unopenable && "bg-neutral-200/70 dark:bg-neutral-700/70",
              focused &&
                "ring-2 ring-sky-400 ring-offset-2 ring-offset-background"
            )}
            data-focused={focused ? "true" : undefined}
          >
            {hasChildren &&
              (category.collapsed ? (
                <ChevronRight
                  className="size-3.5 shrink-0 opacity-70"
                  aria-hidden="true"
                />
              ) : (
                <ChevronDown
                  className="size-3.5 shrink-0 opacity-50"
                  aria-hidden="true"
                />
              ))}
            {unopenable && (
              <FileX2 className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate leading-tight",
                top ? "text-sm font-semibold" : "text-[13px] font-medium"
              )}
            >
              {label}
            </span>
            <span className="shrink-0 rounded-full bg-black/[0.07] px-1.5 text-[11px] font-semibold tabular-nums leading-[18px] dark:bg-white/10">
              {category.total}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-sm">
          <p className="font-semibold">{label}</p>
          <p className="mt-0.5 whitespace-pre-wrap opacity-90">{rule}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  )
})

// ── conversation leaf ───────────────────────────────────────────────────────

export interface MindMapLeafData extends Record<string, unknown> {
  conversation: DbConversationSummary
}
export type MindMapLeafNode = Node<MindMapLeafData, "mmLeaf">

function SourceMark({ assignment }: { assignment: TaxonomyAssignment | null }) {
  if (assignment?.source === "jev")
    return (
      <Sparkles className="size-3 shrink-0 text-amber-500" aria-hidden="true" />
    )
  if (assignment?.source === "manual")
    return <Hand className="size-3 shrink-0 text-sky-500" aria-hidden="true" />
  return null
}

export const MindMapLeaf = memo(function MindMapLeaf({
  data,
}: NodeProps<MindMapLeafNode>) {
  const t = useTranslations("MindMap")
  const locale = useLocale()
  const {
    openConversation,
    moveConversation,
    categoryRows,
    assignmentOf,
    now,
  } = useActions()
  const { conversation } = data
  const title = formatConversationTitle(conversation.title) || t("untitled")
  const assignment = assignmentOf(conversation.id)
  // The same three signals a sidebar row carries: unread (dot and bold
  // title), running or cancelled, else how long ago it last moved.
  const isUnread = useIsConversationUnread(conversation)
  const running = conversation.status === "in_progress"
  const awaiting = useAwaitingUser(conversation.external_id)
  const cancelled = conversation.status === "cancelled"
  const timeLabel =
    now > 0 ? formatRelative(conversation.updated_at, now) : undefined
  const sourceText =
    assignment?.source === "jev"
      ? t("sourceJev", {
          confidence: Math.round((assignment.confidence ?? 0) * 100),
        })
      : assignment?.source === "manual"
        ? t("sourceManual")
        : assignment?.source === "nightly"
          ? t("sourceNightly")
          : t("sourceNone")
  return (
    <div className={cn(NODE_ROOT, "group/leaf")}>
      <Handles />
      <div
        className={cn(
          "flex h-full w-full items-center gap-0.5 rounded-lg pr-0.5 transition-shadow hover:shadow-sm",
          LEAF_FILL
        )}
        data-mindmap-leaf-state={
          running ? "running" : isUnread ? "unread" : undefined
        }
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-mindmap-leaf={conversation.id}
              onClick={() => openConversation(conversation)}
              className="nodrag flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <AgentIcon
                agentType={conversation.agent_type}
                className="size-3.5 shrink-0"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[12.5px] leading-tight",
                  isUnread && "font-semibold"
                )}
              >
                {title}
              </span>
              <SourceMark assignment={assignment} />
              {isUnread && <UnreadDot />}
              <ConversationActivityBadge
                awaiting={awaiting}
                running={running}
                cancelled={cancelled}
                timeLabel={timeLabel}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-md">
            <p className="whitespace-pre-wrap font-medium">{title}</p>
            <p className="mt-0.5 opacity-80">
              {new Date(conversation.updated_at).toLocaleString(locale)} ·{" "}
              {sourceText}
            </p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("leafMenu")}
              data-mindmap-leaf-menu={conversation.id}
              className="nodrag flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 focus-visible:opacity-100 group-hover/leaf:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuItem onSelect={() => openConversation(conversation)}>
              {t("open")}
            </DropdownMenuItem>
            {categoryRows.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{t("moveTo")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                  {categoryRows.map((row) => (
                    <DropdownMenuCheckboxItem
                      key={row.id}
                      checked={assignment?.category_id === row.id}
                      onSelect={() => moveConversation(conversation.id, row.id)}
                      style={{
                        paddingLeft: `${0.5 + (row.depth - 1) * 0.9}rem`,
                      }}
                    >
                      {row.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {assignment?.category_id != null && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => moveConversation(conversation.id, null)}
                >
                  {t("removeFromCategory")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
})

// ── "N more" ────────────────────────────────────────────────────────────────

export interface MindMapMoreData extends Record<string, unknown> {
  category: MindMapCategory
}
export type MindMapMoreNode = Node<MindMapMoreData, "mmMore">

export const MindMapMore = memo(function MindMapMore({
  data,
}: NodeProps<MindMapMoreNode>) {
  const t = useTranslations("MindMap")
  const { showMore } = useActions()
  return (
    <div className={NODE_ROOT}>
      <Handles />
      <button
        type="button"
        data-mindmap-more={data.category.id}
        onClick={() => showMore(data.category)}
        className="nodrag flex h-full w-full items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-400 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground dark:border-neutral-500"
      >
        {t("more", { count: data.category.hiddenLeaves })}
        <ChevronDown className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
})

// ── branch edge ─────────────────────────────────────────────────────────────

export interface MindMapEdgeData extends Record<string, unknown> {
  depth: number
}
export type MindMapEdge = Edge<MindMapEdgeData, "mmBranch">

/** Straight run out of the parent before the curve: siblings fan out from one
 *  shared point just right of it. */
const FORK_PX = 18
/** Straight run into the child after the curve. */
const TAIL_PX = 28

/**
 * The path of one branch: out of the parent to the shared fork, a curve that
 * climbs (or drops) quickly and then eases flat, and a straight run into the
 * child — the logic-chart look.
 */
export function branchPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number
): string {
  const forkX = sourceX + FORK_PX
  const endX = Math.max(forkX + 8, targetX - TAIL_PX)
  const w = endX - forkX
  const c1x = forkX + w * 0.25
  const c1y = sourceY + (targetY - sourceY) * 0.8
  const c2x = forkX + w * 0.45
  return (
    `M ${sourceX} ${sourceY} H ${forkX} ` +
    `C ${c1x} ${c1y}, ${c2x} ${targetY}, ${endX} ${targetY} H ${targetX}`
  )
}

/** One branch in the map's ink, thinning away from the root. */
export const MindMapBranchEdge = memo(function MindMapBranchEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<MindMapEdge>) {
  const depth = data?.depth ?? 3
  return (
    <BaseEdge
      id={id}
      path={branchPath(sourceX, sourceY, targetX, targetY)}
      style={{
        stroke: "var(--foreground)",
        strokeWidth: depth <= 1 ? 2 : depth === 2 ? 1.6 : 1.3,
        opacity: depth <= 1 ? 0.85 : 0.6,
      }}
    />
  )
})

export const MINDMAP_NODE_TYPES = {
  mmRoot: MindMapRoot,
  mmCategory: MindMapCategoryPill,
  mmLeaf: MindMapLeaf,
  mmMore: MindMapMore,
}

export const MINDMAP_EDGE_TYPES = {
  mmBranch: MindMapBranchEdge,
}
