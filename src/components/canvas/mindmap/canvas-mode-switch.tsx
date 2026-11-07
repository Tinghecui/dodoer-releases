"use client"

import { Network, LayoutGrid } from "lucide-react"
import { useTranslations } from "next-intl"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  useMindMapViewStore,
  type CanvasMode,
} from "@/stores/mindmap-view-store"

/** jenny fork: the canvas route's two views — the conversation mind map and
 *  the free-form canvas boards. */
export function CanvasModeSwitch() {
  const t = useTranslations("MindMap")
  const mode = useMindMapViewStore((s) => s.mode)
  const setMode = useMindMapViewStore((s) => s.setMode)
  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as CanvasMode)}>
      <TabsList className="h-8">
        <TabsTrigger
          value="mindmap"
          className="gap-1.5 px-2.5 text-xs"
          data-canvas-mode="mindmap"
        >
          <Network className="size-3.5" aria-hidden="true" />
          {t("viewMindMap")}
        </TabsTrigger>
        <TabsTrigger
          value="boards"
          className="gap-1.5 px-2.5 text-xs"
          data-canvas-mode="boards"
        >
          <LayoutGrid className="size-3.5" aria-hidden="true" />
          {t("viewBoards")}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
