"use client"

import { PanelRightClose, PanelRightOpen } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  useWorkspaceActions,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { cn } from "@/lib/utils"

export function FilePanelToggle({
  className,
  iconClassName,
}: {
  className?: string
  iconClassName?: string
}) {
  const t = useTranslations("Folder.folderTitleBar")
  const { mode, hasOpenFiles } = useWorkspaceView()
  const { toggleFilePanel } = useWorkspaceActions()
  if (!hasOpenFiles) return null

  const expanded = mode === "fusion"
  const Icon = expanded ? PanelRightClose : PanelRightOpen
  return (
    <Button
      variant="ghost"
      size="icon"
      data-file-panel-toggle
      aria-expanded={expanded}
      aria-label={t("toggleFilePanel")}
      title={t("toggleFilePanel")}
      className={cn(className, expanded && "bg-accent")}
      onClick={toggleFilePanel}
    >
      <Icon className={iconClassName} />
    </Button>
  )
}
