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
 *
 * Lent, it also says whether the macOS permissions a lent shell borrows from
 * the app are in force: an update of the app leaves the switch in System
 * Settings on while the grant behind it no longer matches, and "Fix" clears
 * it and asks again.
 */

import { useCallback, useEffect, useState } from "react"
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
  getHostSshPermissions,
  repairHostSshPermission,
  runHostSshSelfTest,
  setHostSshLent,
  useHostSsh,
  type HostSshPermission,
  type HostSshPermissions,
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
  const [permissions, setPermissions] = useState<HostSshPermissions | null>(
    null
  )
  const [repairing, setRepairing] = useState<HostSshPermission | null>(null)
  const [asked, setAsked] = useState(false)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const watchPermissions = open && !!status?.lent

  const loadPermissions = useCallback(async () => {
    try {
      setPermissions(await getHostSshPermissions())
    } catch {
      // Keep the last answer; opening the panel again asks again.
    }
  }, [])

  // Asked while the panel is open on a lent computer, and again whenever the
  // window comes back to the front — from System Settings, most likely.
  useEffect(() => {
    if (!watchPermissions) return
    void loadPermissions()
    const onFocus = () => void loadPermissions()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [watchPermissions, loadPermissions])

  if (connectionId === null || !status?.supported) return null

  const { lent, running } = status
  const trouble = lent && !running

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    setError(null)
    setPermissionError(null)
    setAsked(false)
    void refresh()
  }

  const repair = async (permission: HostSshPermission) => {
    setRepairing(permission)
    setPermissionError(null)
    setAsked(false)
    try {
      setPermissions(await repairHostSshPermission(permission))
      setAsked(true)
    } catch (e) {
      setPermissionError(toErrorMessage(e))
    } finally {
      setRepairing(null)
    }
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

          {lent && permissions?.applicable && (
            <div
              data-host-ssh-permissions=""
              className="flex flex-col gap-1 rounded-md border px-2 py-1.5"
            >
              <span className="text-2xs font-medium">
                {t("hostSshPermissions")}
              </span>
              {permissions.items.map((item) => (
                <div
                  key={item.permission}
                  data-host-ssh-permission={item.permission}
                  data-granted={item.granted ? "true" : "false"}
                  className="flex min-h-6 items-center justify-between gap-2 text-2xs"
                >
                  <span>
                    {t(
                      item.permission === "screenRecording"
                        ? "hostSshPermScreenRecording"
                        : "hostSshPermAccessibility"
                    )}
                  </span>
                  {item.granted ? (
                    <span className="text-emerald-700 dark:text-emerald-300">
                      {t("hostSshPermGranted")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className={TROUBLE_TONE}>
                        {t("hostSshPermMissing")}
                      </span>
                      {permissions.selfResponsible && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={repairing !== null}
                          onClick={() => void repair(item.permission)}
                        >
                          {t(
                            repairing === item.permission
                              ? "hostSshWorking"
                              : "hostSshPermFix"
                          )}
                        </Button>
                      )}
                    </span>
                  )}
                </div>
              ))}
              <p className="text-3xs text-muted-foreground">
                {t(
                  permissions.selfResponsible
                    ? "hostSshPermHint"
                    : "hostSshPermNotSelf"
                )}
              </p>
              {asked && (
                <p
                  data-host-ssh-permission-asked=""
                  className="text-3xs text-violet-600 dark:text-violet-400"
                >
                  {t("hostSshPermAsked")}
                </p>
              )}
              {permissionError && (
                <p role="alert" className="text-3xs break-words text-red-400">
                  {t("hostSshPermFixFailed", { detail: permissionError })}
                </p>
              )}
            </div>
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
