"use client"

/**
 * The person's devices, at the foot of the sidebar (`docs/devices.md` 8).
 *
 * Every computer that ever connected dodoer to this workspace is in the
 * server's book (`web::host_devices`): online, or since when not, and what
 * each lends now — its command line, its tabs, its Chrome. Each goes by a
 * name the person and the agents call it by; here it can be changed, and a
 * computer that is not connected can be taken out of the book.
 *
 * In a browser and in a remote window of the desktop app, wherever the
 * server keeps a book with something in it. Not in a local window: its
 * agents are on this computer.
 *
 * A remote window on a computer whose name nobody chose yet asks for one,
 * once ([`DeviceNamePrompt`]); skipping keeps the name offered.
 */

import { useEffect, useRef, useState } from "react"
import { useLocale } from "next-intl"
import {
  CircleStop,
  Laptop,
  Monitor,
  MonitorSmartphone,
  Pencil,
  Smartphone,
  Tablet,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { toErrorMessage } from "@/lib/app-error"
import {
  DEVICE_NAME_MAX,
  forgetHostDevice,
  isDeviceName,
  lastSeenText,
  normalizeDeviceName,
  renameHostDevice,
  stopHostDevice,
  useHostDevices,
  type HostDevice,
  type HostDeviceList,
} from "@/lib/cowork/host-devices"
import { useCoworkText, type CoworkTextKey } from "@/lib/cowork/i18n"
import { cn } from "@/lib/utils"

const AGENT_MARK = "text-violet-600 dark:text-violet-400"
const ONLINE_MARK = "bg-emerald-500"
const STOPPED_TONE = "text-amber-600 dark:text-amber-400"

type Text = (key: CoworkTextKey, values?: Record<string, string>) => string

/** Why `name` cannot be device `id`'s, in the window's language; `null` when
 *  it can (as far as the window knows: the server has the last word). */
function nameProblem(
  t: Text,
  list: HostDeviceList,
  id: string,
  name: string
): string | null {
  if (!isDeviceName(name)) return t("devicesNameRule")
  if (list.devices.some((device) => device.id !== id && device.name === name))
    return t("devicesNameTaken", { name })
  return null
}

export function StatusBarDevices({ className }: { className?: string }) {
  const t = useCoworkText()
  const [open, setOpen] = useState(false)
  const { list, thisDeviceId, adopt, canStop } = useHostDevices(open)
  const [error, setError] = useState<string | null>(null)

  if (!list) return null
  const prompt = (
    <DeviceNamePrompt list={list} thisDeviceId={thisDeviceId} adopt={adopt} />
  )
  if (list.devices.length === 0 && list.unnamedHosts === 0) return prompt

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setError(null)
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("devicesTitle")}
            title={t("devicesTitle")}
            className={cn(
              "flex shrink-0 items-center transition-colors hover:text-foreground",
              className
            )}
          >
            <MonitorSmartphone className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 gap-2 p-2.5">
          <span className="truncate text-xs font-medium">
            {t("devicesTitle")}
          </span>
          <p className="text-2xs text-muted-foreground">{t("devicesIntro")}</p>

          <ul className="flex flex-col divide-y rounded-md border">
            {list.devices.length === 0 && (
              <li className="px-2 py-1.5 text-2xs text-muted-foreground">
                {t("devicesEmpty")}
              </li>
            )}
            {list.devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                list={list}
                here={device.id === thisDeviceId}
                canStop={canStop}
                onChanged={(next) => {
                  setError(null)
                  adopt(next)
                }}
                onError={(message) => setError(t("devicesFailed", { message }))}
              />
            ))}
          </ul>

          {list.unnamedHosts > 0 && (
            <p className="text-3xs text-muted-foreground">
              {t("devicesUnnamedHosts", {
                count: String(list.unnamedHosts),
              })}
            </p>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs break-words text-red-400"
            >
              {error}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {prompt}
    </>
  )
}

function KindIcon({ kind }: { kind: string | null }) {
  const Icon =
    kind === "laptop"
      ? Laptop
      : kind === "phone"
        ? Smartphone
        : kind === "tablet"
          ? Tablet
          : Monitor
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />
}

/** One device: its name (which can be changed), where it is, what it
 *  lends, which conversations work on it; its lending can be stopped. */
function DeviceRow({
  device,
  list,
  here,
  canStop,
  onChanged,
  onError,
}: {
  device: HostDevice
  list: HostDeviceList
  here: boolean
  /** The server can stop a device's lending. */
  canStop: boolean
  onChanged: (next: HostDeviceList) => void
  onError: (message: string) => void
}) {
  const t = useCoworkText()
  const locale = useLocale()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(device.name)
  const [problem, setProblem] = useState<string | null>(null)
  const [forgetting, setForgetting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [busy, setBusy] = useState(false)

  const lends = [
    device.shell && t("devicesLendsShell"),
    device.browser && t("devicesLendsBrowser"),
    device.chrome && t("devicesLendsChrome"),
  ].filter((label): label is string => !!label)
  const about = device.computerName || device.model
  const stoppable =
    canStop &&
    device.online &&
    !device.stopped &&
    (device.shell || device.browser)
  const inUse = (device.inUse ?? [])
    .map((c) => c.title || t("devicesUntitled"))
    .join(", ")

  const save = async () => {
    const name = normalizeDeviceName(draft)
    const wrong = nameProblem(t, list, device.id, name)
    if (wrong) {
      setProblem(wrong)
      return
    }
    setBusy(true)
    try {
      onChanged(await renameHostDevice(device.id, name))
      setEditing(false)
      setProblem(null)
    } catch (e) {
      setProblem(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    setBusy(true)
    try {
      onChanged(await forgetHostDevice(device.id))
    } catch (e) {
      onError(toErrorMessage(e))
    } finally {
      setBusy(false)
      setForgetting(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      onChanged(await stopHostDevice(device.id))
    } catch (e) {
      onError(toErrorMessage(e))
    } finally {
      setBusy(false)
      setStopping(false)
    }
  }

  return (
    <li
      data-device={device.id}
      data-online={device.online ? "true" : "false"}
      data-stopped={device.stopped ? "true" : undefined}
      className="flex flex-col gap-1 px-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        <KindIcon kind={device.kind} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-xs">
            <span className="truncate font-mono">{device.name}</span>
            {here && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
                {t("devicesThis")}
              </span>
            )}
          </span>
          {about && (
            <span className="truncate text-3xs text-muted-foreground">
              {about}
            </span>
          )}
        </span>
        {!editing && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("devicesRename")}
            title={t("devicesRename")}
            disabled={busy}
            onClick={() => {
              setDraft(device.name)
              setProblem(null)
              setEditing(true)
            }}
          >
            <Pencil className="size-3" />
          </Button>
        )}
        {stoppable && !editing && !stopping && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("devicesStop")}
            title={t("devicesStop")}
            disabled={busy}
            onClick={() => setStopping(true)}
          >
            <CircleStop className="size-3" />
          </Button>
        )}
        {!device.online && !editing && !forgetting && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("devicesForget")}
            title={t("devicesForget")}
            disabled={busy}
            onClick={() => setForgetting(true)}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5 pl-5.5 text-2xs">
        {device.online ? (
          <>
            <span className={cn("size-1.5 rounded-full", ONLINE_MARK)} />
            <span>{t("devicesOnline")}</span>
            <span className="text-muted-foreground">·</span>
            <span
              className={cn(
                "truncate",
                lends.length > 0 ? AGENT_MARK : "text-muted-foreground"
              )}
            >
              {lends.length > 0 ? lends.join(" · ") : t("devicesLendsNothing")}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            {t("devicesLastSeen", {
              when: lastSeenText(device.lastSeen, locale),
            })}
          </span>
        )}
      </div>

      {device.stopped && (
        <p
          data-device-stopped=""
          className={cn("pl-5.5 text-2xs", STOPPED_TONE)}
        >
          {t("devicesStopped")}
        </p>
      )}

      {inUse && (
        <p
          data-device-in-use=""
          title={inUse}
          className="truncate pl-5.5 text-2xs text-muted-foreground"
        >
          {t("devicesInUse", { titles: inUse })}
        </p>
      )}

      {editing && (
        <form
          className="flex flex-col gap-1 pl-5.5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              aria-label={t("devicesNameLabel")}
              value={draft}
              maxLength={DEVICE_NAME_MAX}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="h-6 font-mono text-xs"
              onChange={(e) => {
                setDraft(e.target.value)
                setProblem(null)
              }}
            />
            <Button type="submit" size="xs" disabled={busy}>
              {t("devicesSave")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setProblem(null)
              }}
            >
              {t("devicesCancel")}
            </Button>
          </div>
          {problem && (
            <p role="alert" className="text-3xs text-red-400">
              {problem}
            </p>
          )}
        </form>
      )}

      {stopping && (
        <div className="flex flex-col gap-1 pl-5.5 text-2xs">
          <span>{t("devicesStopConfirm", { name: device.name })}</span>
          <div className="flex items-center justify-end gap-1">
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={() => void stop()}
            >
              {t("devicesStop")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setStopping(false)}
            >
              {t("devicesCancel")}
            </Button>
          </div>
        </div>
      )}

      {forgetting && (
        <div className="flex items-center gap-1 pl-5.5 text-2xs">
          <span className="min-w-0 flex-1 truncate">
            {t("devicesForgetConfirm", { name: device.name })}
          </span>
          <Button
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() => void forget()}
          >
            {t("devicesForget")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setForgetting(false)}
          >
            {t("devicesCancel")}
          </Button>
        </div>
      )}
    </li>
  )
}

/** One window of the page asks; the sidebar foot can be drawn twice. */
let promptClaimed = false

/** For tests: let the next prompt ask again. */
export function resetDeviceNamePrompt() {
  promptClaimed = false
}

/**
 * Ask, once, for the name of this computer while nobody chose one: what is
 * offered is the server's ([`default_name`] there), skipping keeps it, and
 * either way it is not asked again. Only in the desktop app, on the computer
 * itself — a browser has no computer of its own in the book.
 */
function DeviceNamePrompt({
  list,
  thisDeviceId,
  adopt,
}: {
  list: HostDeviceList
  thisDeviceId: string | null
  adopt: (next: HostDeviceList) => void
}) {
  const t = useCoworkText()
  const mine = list.devices.find((device) => device.id === thisDeviceId)
  const [asking, setAsking] = useState<HostDevice | null>(null)
  /** What the person typed; the name offered until they type. */
  const [typed, setTyped] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const claimedHere = useRef(false)

  useEffect(() => {
    if (!mine || mine.named || claimedHere.current || promptClaimed) return
    promptClaimed = true
    claimedHere.current = true
    setAsking(mine)
  }, [mine])

  if (!asking) return null
  const draft = typed ?? asking.name

  const keep = async (name: string) => {
    setBusy(true)
    try {
      adopt(await renameHostDevice(asking.id, name))
      setAsking(null)
    } catch (e) {
      setProblem(t("devicesFailed", { message: toErrorMessage(e) }))
    } finally {
      setBusy(false)
    }
  }

  const confirm = () => {
    const name = normalizeDeviceName(draft)
    const wrong = nameProblem(t, list, asking.id, name)
    if (wrong) {
      setProblem(wrong)
      return
    }
    void keep(name)
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Closed any other way than the buttons: the name offered stays,
        // and is not asked about again.
        if (!next && !busy) void keep(asking.name)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("devicesNameTitle")}</DialogTitle>
          <DialogDescription>{t("devicesNameBody")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            confirm()
          }}
        >
          <Input
            autoFocus
            aria-label={t("devicesNameLabel")}
            value={draft}
            maxLength={DEVICE_NAME_MAX}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono"
            onChange={(e) => {
              setTyped(e.target.value)
              setProblem(null)
            }}
          />
          {asking.computerName && (
            <p className="text-2xs text-muted-foreground">
              {asking.computerName}
            </p>
          )}
          {problem && (
            <p role="alert" className="text-2xs text-red-400">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void keep(asking.name)}
            >
              {t("devicesNameSkip")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("devicesNameConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
