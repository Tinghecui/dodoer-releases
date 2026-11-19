"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  workTaskCleanup,
  workTaskDelete,
  workTaskWorktreeDirty,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * 删除这个任务的 worktree 会丢掉几个没提交的文件。`enabled` 为 false 时不问，
 * 返回 null；问不到（接口报错）也是 null，界面照旧，删除时由后端拦下。
 *
 * 后端在没有「丢弃」许可时会拒绝删除有未提交文件的 worktree，而任务的正常
 * 产出往往就是没提交的文件——所以要在用户勾选删除时先说清楚。
 */
export function useWorktreeDirtyCount(
  taskId: number | null,
  enabled: boolean
): number | null {
  const [state, setState] = useState<{
    key: string
    count: number
  } | null>(null)
  const key = enabled && taskId != null ? String(taskId) : null

  useEffect(() => {
    if (key == null || taskId == null) return
    let cancelled = false
    workTaskWorktreeDirty(taskId)
      .then((count) => {
        if (!cancelled) setState({ key, count })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [key, taskId])

  return key != null && state?.key === key ? state.count : null
}

/**
 * 勾了「同时删除 worktree」以后的提示和「同时丢弃这些改动」勾选框。没有未提交
 * 文件（或还没查到）时什么都不显示。
 */
export function WorktreeDiscardOption({
  count,
  checked,
  onCheckedChange,
}: {
  count: number | null
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const t = useTranslations("Tasks")
  if (count == null || count <= 0) return null
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-sm">
      <p className="text-amber-700 dark:text-amber-400">
        {t("worktreeUncommittedWarning", { count })}
      </p>
      <Label className="text-sm font-normal">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
        />
        {t("worktreeDiscardChanges")}
      </Label>
    </div>
  )
}

/**
 * 清理失败、原因是 worktree 里还有没提交的文件时，「重试」永远过不去：
 * 这个按钮给一条出路，点了先弹确认，写明会丢几个文件、无法恢复，确认后
 * 带着丢弃许可重新清理。没有未提交文件时不显示（那种失败重试就够了）。
 *
 * `deleteTask`：这次清理失败是删除任务时被拦下的（`failed_delete`），按钮
 * 就接着做原来的删除——worktree 和任务一起删，删完调 `onDeleted`。
 *
 * 卡片整个是可点的（打开详情），这里的点击——包括确认框里的，React 的事件
 * 会穿过 portal 冒泡——都不能冒上去。
 */
export function TaskDiscardCleanupButton({
  taskId,
  size = "sm",
  className,
  deleteTask = false,
  onDeleted,
}: {
  taskId: number
  size?: "xs" | "sm"
  className?: string
  deleteTask?: boolean
  onDeleted?: () => void
}) {
  const t = useTranslations("Tasks")
  const count = useWorktreeDirtyCount(taskId, true)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (count == null || count <= 0) return null
  const label = deleteTask
    ? t("actionDiscardAndDeleteTask")
    : t("actionDiscardAndDeleteWorktree")

  const confirm = async () => {
    setBusy(true)
    try {
      if (deleteTask) {
        await workTaskDelete(taskId, true, true)
        setOpen(false)
        onDeleted?.()
      } else {
        await workTaskCleanup(taskId, true)
        setOpen(false)
      }
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span
      className={cn("inline-flex", className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Button
        type="button"
        variant="outline"
        size={size}
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" />
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTask
                ? t("discardTaskConfirmTitle")
                : t("discardWorktreeConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTask
                ? t("discardTaskConfirmBody", { count })
                : t("discardWorktreeConfirmBody", { count })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                // 等清理结束再关：失败时 toast 报错，框留着可以再点。
                e.preventDefault()
                void confirm()
              }}
            >
              {label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  )
}
