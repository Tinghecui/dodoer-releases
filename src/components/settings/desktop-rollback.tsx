"use client"

import { useRef, useState } from "react"
import { Loader2, RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAppUpdate } from "@/components/providers/update-provider"
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
import {
  type AppRollbackTarget,
  getAppRollbackTarget,
  normalizeAppUpdateError,
  usesTauriUpdater,
} from "@/lib/updater"

type Lookup =
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "failed"; message: string }
  | { kind: "found"; target: AppRollbackTarget }

/**
 * The desktop app's "roll back to the previous version", in the software
 * update card. The previous version is the release before the running one;
 * looking it up asks GitHub, so it happens when the dialog opens. That release
 * is downloaded like an update and switched to by the same restart. A release
 * that cannot open this app's database (it lacks a migration this one ran) is
 * shown but not offered.
 */
export function DesktopRollback() {
  const t = useTranslations("SystemSettings")
  const update = useAppUpdate()
  const [open, setOpen] = useState(false)
  const [lookup, setLookup] = useState<Lookup>({ kind: "checking" })
  // Only the latest lookup may land: reopening the dialog starts another one.
  const lookupSeq = useRef(0)

  if (!update || !usesTauriUpdater()) return null
  const { state, hydrated, isBusy, currentVersion, startRollback } = update
  // From a settled lifecycle only, like the server's rollback; and not on a
  // prerelease build (developer builds have no releases to go back to).
  const settled =
    hydrated && (state.status === "idle" || state.status === "error")
  if (!settled || !currentVersion || currentVersion.includes("-")) return null

  const openDialog = () => {
    const seq = ++lookupSeq.current
    setLookup({ kind: "checking" })
    setOpen(true)
    getAppRollbackTarget().then(
      (target) => {
        if (seq !== lookupSeq.current) return
        setLookup(target ? { kind: "found", target } : { kind: "none" })
      },
      (err) => {
        if (seq !== lookupSeq.current) return
        setLookup({
          kind: "failed",
          message: normalizeAppUpdateError(err).rawMessage,
        })
      }
    )
  }

  const target = lookup.kind === "found" ? lookup.target : null
  const blocked = !!target && target.unknownMigrations.length > 0

  let title = t("desktopRollbackTitle")
  let description: string
  if (lookup.kind === "checking") {
    description = t("desktopRollbackChecking")
  } else if (lookup.kind === "none") {
    description = t("desktopRollbackNone", { version: currentVersion })
  } else if (lookup.kind === "failed") {
    description = t("desktopRollbackCheckFailed", { message: lookup.message })
  } else if (blocked) {
    description = t("desktopRollbackBlocked", {
      current: currentVersion,
      version: lookup.target.version,
    })
  } else {
    title = t("desktopRollbackConfirmTitle", { version: lookup.target.version })
    description = t("desktopRollbackConfirmDescription", {
      version: lookup.target.version,
    })
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-muted-foreground/80 text-2xs leading-5">
          {t("desktopRollbackDescription")}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={openDialog}
          disabled={isBusy}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("desktopRollbackButton")}
        </Button>
      </div>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>
              {lookup.kind === "checking" && (
                <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
              )}
              {description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("rollbackCancel")}</AlertDialogCancel>
            {target && !blocked && (
              <AlertDialogAction
                onClick={() => {
                  void startRollback(target.version)
                }}
              >
                {t("desktopRollbackConfirm", { version: target.version })}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
