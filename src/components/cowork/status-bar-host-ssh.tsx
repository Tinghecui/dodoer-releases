"use client"

/**
 * Lending this computer's shell to the agents of this window's server,
 * at the sidebar foot of a remote workspace, beside the server's name
 * (`docs/host-ssh.md`).
 *
 * A remote window only, and its own item rather than a row of the MCP
 * popover: that popover says which tools the server gives its agents, while
 * this says what this computer hands over — commands run here as the person.
 * It is kept per server, off until the person turns it on, and turning it on
 * always asks first.
 *
 * Always present there (where the system can lend at all), because the point
 * is a passive signal: the glyph carries the violet mark the browser and
 * computer use show for "an agent can reach this" for as long as the
 * computer is lent.
 */

import { useState } from "react"
import { Laptop } from "lucide-react"

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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useRemoteConnection } from "@/contexts/remote-connection-context"
import { toErrorMessage } from "@/lib/app-error"
import {
  runHostSshSelfTest,
  setHostSshLent,
  useHostSsh,
  type HostSshSelfTest,
} from "@/lib/cowork/host-ssh"
import { useCoworkText } from "@/lib/cowork/i18n"
import { cn } from "@/lib/utils"

const AGENT_MARK = "text-violet-600 dark:text-violet-400"
const TROUBLE_TONE = "text-amber-600 dark:text-amber-400"

export function StatusBarHostSsh({ className }: { className?: string }) {
  const t = useCoworkText()
  const { connectionId, status, serverTakes, refresh, adopt } = useHostSsh()
  const server = useRemoteConnection()?.connection?.name ?? ""
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Lending awaits the person's yes. */
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<HostSshSelfTest | null>(null)

  if (connectionId === null || !status?.supported) return null

  const { lent, running } = status
  const trouble = lent && !running

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    setError(null)
    void refresh()
  }

  const apply = async (next: boolean) => {
    setBusy(true)
    setError(null)
    setTest(null)
    try {
      adopt(await setHostSshLent(connectionId, next))
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const selfTest = async () => {
    setTesting(true)
    setTest(null)
    try {
      setTest(await runHostSshSelfTest())
    } catch (e) {
      setTest({ ok: false, tools: [], detail: toErrorMessage(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("hostSshTitle")}
            title={t(lent ? "hostSshTooltipOn" : "hostSshTooltipOff")}
            data-host-ssh-lent={lent ? "true" : "false"}
            className={cn(
              "flex shrink-0 items-center transition-colors",
              trouble
                ? TROUBLE_TONE
                : lent
                  ? AGENT_MARK
                  : "hover:text-foreground",
              className
            )}
          >
            <Laptop className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 gap-2 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">
              {t("hostSshTitle")}
            </span>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium",
                lent
                  ? "bg-violet-500/10 text-violet-600 dark:text-violet-400"
                  : "bg-muted text-muted-foreground"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  lent ? "bg-violet-500" : "bg-muted-foreground/50"
                )}
              />
              {t(lent ? "hostSshLent" : "hostSshNotLent")}
            </span>
          </div>

          <p className="text-2xs text-muted-foreground">
            {t(lent ? "hostSshHintOn" : "hostSshHintOff", { server })}
          </p>

          {!serverTakes && (
            <p
              data-host-ssh-server-not-ready=""
              className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-2xs text-amber-700 dark:text-amber-300"
            >
              {t("hostSshServerNotReady")}
            </p>
          )}

          {(error || (trouble && status.error)) && (
            <div
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs break-words text-red-400"
            >
              {error ?? t("hostSshNotRunning", { detail: status.error ?? "" })}
            </div>
          )}

          {test && (
            <p
              data-host-ssh-test={test.ok ? "ok" : "failed"}
              className={cn(
                "rounded-md border px-2 py-1.5 text-2xs break-words",
                test.ok
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                  : "border-red-500/30 bg-red-500/5 text-red-400"
              )}
            >
              {test.ok
                ? t("hostSshSelfTestOk", {
                    tools: test.tools.join(", ") || t("hostSshSelfTestNoTools"),
                  })
                : t("hostSshSelfTestFailed", { detail: test.detail ?? "" })}
            </p>
          )}

          <Button
            size="sm"
            variant={lent ? "outline" : "default"}
            className="w-full"
            disabled={busy}
            onClick={() => (lent ? void apply(false) : setConfirming(true))}
          >
            {busy
              ? t("hostSshWorking")
              : t(lent ? "hostSshStop" : "hostSshLend")}
          </Button>
          {lent && running && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={testing || busy}
              onClick={() => void selfTest()}
            >
              {t(testing ? "hostSshTesting" : "hostSshSelfTest")}
            </Button>
          )}
        </PopoverContent>
      </Popover>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("hostSshConfirmTitle", { server })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("hostSshConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("hostSshCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                void apply(true)
              }}
            >
              {t("hostSshConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
