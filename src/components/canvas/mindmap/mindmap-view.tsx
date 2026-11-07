"use client"

import "@xyflow/react/dist/style.css"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
} from "@xyflow/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { assignConversationCategory } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  UNCLASSIFIED_CATEGORY_ID,
  UNOPENABLE_CATEGORY_ID,
  type ConversationTaxonomy,
} from "@/lib/conversation-taxonomy"
import type { DbConversationSummary } from "@/lib/types"
import { useConversationTaxonomyStore } from "@/stores/conversation-taxonomy-store"
import { useMindMapViewStore } from "@/stores/mindmap-view-store"
import { useNow } from "../canvas-board-list"
import {
  layoutMindMap,
  mindMapNodeId,
  type MindMapLayoutNode,
} from "./mindmap-layout"
import {
  buildMindMapTree,
  categoryMenuRows,
  LEAF_LIMIT_STEP,
  liveAssignment,
  type MindMapCategory,
} from "./mindmap-model"
import {
  MINDMAP_EDGE_TYPES,
  MINDMAP_NODE_TYPES,
  MindMapActionsProvider,
  type MindMapActions,
} from "./mindmap-nodes"

export interface MindMapViewProps {
  projectLabel: string
  conversations: readonly DbConversationSummary[]
  taxonomy: ConversationTaxonomy | null
  /** Conversations that would open empty; folded away at the end. */
  unopenable: ReadonlySet<number>
  query: string
  /** Bumped by the page to ask for a fit (expand all, collapse all, the fit
   *  button). A new project fits on its own. */
  fitSignal: number
  projectKey: number
}

const NODE_TYPE = {
  root: "mmRoot",
  category: "mmCategory",
  conversation: "mmLeaf",
  more: "mmMore",
} as const

function toFlowNode(
  n: MindMapLayoutNode,
  label: (c: MindMapCategory) => string,
  focusedId: string | null = null
): Node {
  const base = {
    id: n.id,
    type: NODE_TYPE[n.kind],
    position: { x: n.x, y: n.y },
    width: n.width,
    height: n.height,
    draggable: false,
    selectable: false,
    connectable: false,
  }
  switch (n.kind) {
    case "category":
      return {
        ...base,
        data: {
          category: n.category!,
          label: label(n.category!),
          focused: n.category!.id === focusedId,
        },
      }
    case "conversation":
      return {
        ...base,
        data: { conversation: n.conversation! },
      }
    case "more":
      return { ...base, data: { category: n.moreOf! } }
    default:
      return base as Node
  }
}

/**
 * The conversation mind map of one project, drawn with React Flow: laid out
 * by `layoutMindMap` (nothing here is dragged — the tree is the layout),
 * panned and zoomed like the canvas.
 */
export default function MindMapView(props: MindMapViewProps) {
  return (
    <ReactFlowProvider>
      <TooltipProvider delayDuration={350}>
        <MindMapFlow {...props} />
      </TooltipProvider>
    </ReactFlowProvider>
  )
}

function MindMapFlow({
  projectLabel,
  conversations,
  taxonomy,
  unopenable,
  query,
  fitSignal,
  projectKey,
}: MindMapViewProps) {
  const t = useTranslations("MindMap")
  const now = useNow()
  const { fitView, setCenter } = useReactFlow()
  const { openConversations } = useWorkbenchRoute()
  const { openTab } = useTabActions()
  const collapsed = useMindMapViewStore((s) => s.collapsed)
  const leafLimits = useMindMapViewStore((s) => s.leafLimits)
  const toggleCollapsed = useMindMapViewStore((s) => s.toggleCollapsed)
  const showMoreLeaves = useMindMapViewStore((s) => s.showMore)
  const focus = useMindMapViewStore((s) => s.focus)
  const clearFocus = useMindMapViewStore((s) => s.clearFocus)
  // The category a breadcrumb asked for, marked for a moment once in view.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // Opened for a category: React Flow's own first fit would land after the
  // centring and undo it.
  const [openedForFocus] = useState(() => focus != null)

  const tree = useMemo(
    () =>
      buildMindMapTree({
        taxonomy,
        conversations,
        query,
        collapsed,
        leafLimits,
        unopenable,
      }),
    [taxonomy, conversations, query, collapsed, leafLimits, unopenable]
  )

  const categoryLabel = useCallback(
    (c: MindMapCategory) =>
      c.id === UNCLASSIFIED_CATEGORY_ID
        ? t("unclassified")
        : c.id === UNOPENABLE_CATEGORY_ID
          ? t("unopenable")
          : c.name,
    [t]
  )

  const { nodes, edges } = useMemo(() => {
    const layout = layoutMindMap(projectLabel, tree, categoryLabel)
    const flowNodes = layout.nodes.map((n) =>
      n.kind === "root"
        ? {
            ...toFlowNode(n, categoryLabel),
            data: { label: projectLabel, total: tree.total },
          }
        : toFlowNode(n, categoryLabel, focusedId)
    )
    const flowEdges: Edge[] = layout.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: "s",
      targetHandle: "t",
      type: "mmBranch",
      data: { depth: e.depth },
      selectable: false,
      focusable: false,
    }))
    return { nodes: flowNodes, edges: flowEdges }
  }, [tree, projectLabel, categoryLabel, focusedId])

  const fit = useCallback(() => {
    void fitView({ padding: 0.12, maxZoom: 1, duration: 250 })
  }, [fitView])

  // A new project, or the page asking: fit once the nodes are in. Marked
  // done only when the fit runs: a node count that changes first (the folds
  // of the new project arriving) cancels the frame, and the next run retries.
  // A category asked for takes the place of that fit: it is centred instead.
  const lastFit = useRef<string>("")
  useEffect(() => {
    const key = `${projectKey}:${fitSignal}`
    if (focus || lastFit.current === key || nodes.length === 0) return
    const frame = requestAnimationFrame(() => {
      lastFit.current = key
      fit()
    })
    return () => cancelAnimationFrame(frame)
  }, [projectKey, fitSignal, nodes.length, fit, focus])

  // The category being kept in the middle: the map can still reflow after
  // the first centring (late data, the pane getting its size as the route
  // shows), so it is followed until the mark fades or the person moves the
  // map themselves.
  const following = useRef<string | null>(null)
  const centredAt = useRef("")
  const paneWidth = useStore((s) => s.width)
  const paneHeight = useStore((s) => s.height)

  useEffect(() => {
    if (!focus || nodes.length === 0) return
    const known = nodes.some(
      (n) => n.id === mindMapNodeId.category(focus.categoryId)
    )
    const frame = requestAnimationFrame(() => {
      lastFit.current = `${projectKey}:${fitSignal}`
      clearFocus()
      if (!known) {
        // Gone from the map (emptied since): show the whole of it instead.
        fit()
        return
      }
      following.current = focus.categoryId
      centredAt.current = ""
      setFocusedId(focus.categoryId)
    })
    return () => cancelAnimationFrame(frame)
  }, [focus, nodes, projectKey, fitSignal, clearFocus, fit])

  useEffect(() => {
    const id = following.current
    if (id == null || id !== focusedId || !paneWidth || !paneHeight) return
    const target = nodes.find((n) => n.id === mindMapNodeId.category(id))
    if (!target) return
    const x = target.position.x + (target.width ?? 0) / 2
    const y = target.position.y + (target.height ?? 0) / 2
    const at = `${x}:${y}:${paneWidth}:${paneHeight}`
    if (centredAt.current === at) return
    const first = centredAt.current === ""
    centredAt.current = at
    void setCenter(x, y, { zoom: 1, duration: first ? 300 : 150 })
  }, [focusedId, nodes, paneWidth, paneHeight, setCenter])

  useEffect(() => {
    if (focusedId == null) return
    const timer = setTimeout(() => {
      following.current = null
      setFocusedId(null)
    }, 2500)
    return () => clearTimeout(timer)
  }, [focusedId])

  const categoryIds = useMemo(
    () => new Set((taxonomy?.categories ?? []).map((c) => c.id)),
    [taxonomy]
  )

  const actions = useMemo<MindMapActions>(
    () => ({
      openConversation: (conversation) => {
        // The route overlays the workspace: leave it first, or the tab opens
        // out of sight underneath.
        openConversations()
        openTab(
          conversation.folder_id,
          conversation.id,
          conversation.agent_type,
          true,
          conversation.title ?? undefined
        )
      },
      toggleCategory: toggleCollapsed,
      showMore: (category) =>
        showMoreLeaves(category.id, LEAF_LIMIT_STEP, category.leaves.length),
      moveConversation: (conversationId, categoryId) => {
        void assignConversationCategory(conversationId, categoryId)
          .then((next) => useConversationTaxonomyStore.getState().accept(next))
          .catch((err) =>
            toast.error(t("moveFailed", { message: toErrorMessage(err) }))
          )
      },
      fit,
      categoryRows: categoryMenuRows(taxonomy),
      assignmentOf: (id) => liveAssignment(taxonomy, id, categoryIds),
      now,
    }),
    [
      openConversations,
      openTab,
      toggleCollapsed,
      showMoreLeaves,
      fit,
      taxonomy,
      categoryIds,
      t,
      now,
    ]
  )

  return (
    <MindMapActionsProvider value={actions}>
      <div className="canvas-surface h-full w-full" data-mindmap-surface>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={MINDMAP_NODE_TYPES}
          edgeTypes={MINDMAP_EDGE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView={!openedForFocus}
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.08}
          maxZoom={2}
          onlyRenderVisibleElements
          panOnScroll
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          proOptions={{ hideAttribution: true }}
          // Only a person's own pan or zoom carries an event.
          onMoveStart={(event) => {
            if (event) following.current = null
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.5}
            className="canvas-dots"
          />
        </ReactFlow>
      </div>
    </MindMapActionsProvider>
  )
}
