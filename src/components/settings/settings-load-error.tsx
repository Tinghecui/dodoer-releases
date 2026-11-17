"use client"

import { CircleAlert, RotateCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

/**
 * Cowork fork: 设置页的列表没加载出来时用它替掉列表和空状态（#438），
 * 说清楚失败了、为什么，给「重试」。版式照任务、自动化页（#339）。
 * 不能和「尚未配置……」这类空状态一起显示，否则看着像真的一条都没有。
 */
export function SettingsLoadError({
  message,
  onRetry,
  title,
}: {
  message: string
  onRetry: () => void
  title?: string
}) {
  const t = useTranslations("SettingsLoadError")
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center"
    >
      <CircleAlert className="size-8 text-destructive/70" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title ?? t("title")}</p>
        {message && (
          <p className="max-w-sm break-words text-xs text-muted-foreground">
            {message}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={onRetry}
      >
        <RotateCw className="size-3.5" aria-hidden="true" />
        {t("retry")}
      </Button>
    </div>
  )
}
