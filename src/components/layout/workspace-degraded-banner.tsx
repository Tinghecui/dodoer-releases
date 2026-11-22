"use client"

import { useState } from "react"
import { RefreshCw, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

// 顶部「实时更新不可用」提示条什么时候出现：后端报告监视退回轮询
// （degraded），或者订阅启动 / 补拉失败（health=degraded，列表处显示出错说明
// 和「重试」）。两种情况实时更新都用不了，提示条都要在（#1279）。
export function shouldShowWorkspaceDegradedBanner(state: {
  degraded: boolean
  health: string
}): boolean {
  return state.degraded || state.health === "degraded"
}

interface WorkspaceDegradedBannerProps {
  onRetry?: () => void | Promise<void>
}

export function WorkspaceDegradedBanner({
  onRetry,
}: WorkspaceDegradedBannerProps) {
  const t = useTranslations("Folder.workspaceStatus")
  const [retrying, setRetrying] = useState(false)

  const handleRetry = async () => {
    if (!onRetry || retrying) return
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 text-2xs text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/20 border-b border-amber-300/50 dark:border-amber-800/50"
      role="status"
      aria-live="polite"
      title={t("degradedHint")}
    >
      <TriangleAlert className="size-3.5 mt-0.5 shrink-0" aria-hidden />
      <div className="leading-snug flex-1">
        <span className="font-medium">{t("degradedTitle")}</span>
        <span className="ml-1 text-muted-foreground">{t("degradedHint")}</span>
      </div>
      {onRetry && (
        <Button
          variant="ghost"
          size="xs"
          className="h-5 px-1.5 -my-0.5 shrink-0 text-amber-700 dark:text-amber-400 hover:bg-amber-200/60 dark:hover:bg-amber-900/40"
          onClick={() => {
            void handleRetry()
          }}
          disabled={retrying}
        >
          <RefreshCw
            className={`size-3 ${retrying ? "animate-spin" : ""}`}
            aria-hidden
          />
          <span className="ml-1">{retrying ? t("retrying") : t("retry")}</span>
        </Button>
      )}
    </div>
  )
}
