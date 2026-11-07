"use client"

import { useEffect, useRef, useState } from "react"
import { RotateCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { readWorkbenchAppLog } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { WorkbenchApp, WorkbenchAppLog } from "@/lib/types"

/** How often an open log re-reads, so a starting service's output scrolls by. */
const LOG_POLL_MS = 2000

/** The output codeg kept of an app's service: its last few hundred lines, and
 *  where the whole log is on disk. */
export function AppLogDialog({
  app,
  onOpenChange,
}: {
  /** The app whose log is open; null when the dialog is closed. */
  app: WorkbenchApp | null
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("Apps.log")
  return (
    <Dialog open={app !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[48rem]" data-app-log="">
        <DialogHeader>
          <DialogTitle>
            {app ? t("title", { name: app.name }) : null}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {app?.startCommand ?? ""}
          </DialogDescription>
        </DialogHeader>
        {app ? <LogBody appId={app.id} /> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LogBody({ appId }: { appId: string }) {
  const t = useTranslations("Apps.log")
  const [log, setLog] = useState<WorkbenchAppLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)
  // Follow the end while the reader is at it; leave them where they scrolled
  // to otherwise.
  const stickRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    readWorkbenchAppLog(appId).then(
      (next) => {
        if (cancelled) return
        setLog(next)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(toErrorMessage(err))
      }
    )
    const timer = window.setTimeout(() => setTick((n) => n + 1), LOG_POLL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [appId, tick])

  useEffect(() => {
    const el = preRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [log])

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <pre
        ref={preRef}
        data-app-log-lines=""
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="h-80 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap break-all"
      >
        {log === null
          ? null
          : log.lines.length === 0
            ? t("empty")
            : log.lines.join("\n")}
      </pre>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={log?.path}>
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : log?.path ? (
            t("file", { path: log.path })
          ) : null}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5"
          onClick={() => setTick((n) => n + 1)}
        >
          <RotateCw className="size-3.5" />
          {t("refresh")}
        </Button>
      </div>
    </div>
  )
}
