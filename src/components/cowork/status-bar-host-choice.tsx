"use client"

/**
 * Which of the person's computers this workspace's agents use, at the foot
 * of the sidebar (`docs/host-choice.md`).
 *
 * A person may have the desktop app open on two computers, both lending this
 * workspace their browser or their command line. Which one took a call used
 * to be nobody's to see — the one clicked last — so an agent could open its
 * pages on the Mac in the other room. Here it shows: every computer
 * connected, what each lends, and where a browser call and `ssh desktop` go
 * right now; and each can be fixed to one computer, which then takes every
 * call whichever window, browser or phone the person talks from.
 *
 * In a browser and in a remote window of the desktop app, wherever some
 * computer is connected or something is fixed. Not in a local window: its
 * agents are on this computer and use it.
 *
 * The glyph turns amber while something is fixed to a computer that does not
 * lend it now: agents' calls fail until it is back or the person chooses
 * again — never quietly going to another computer, which is what fixing is
 * for.
 */

import { useState } from "react"
import { ChevronDown, Laptop, MonitorSmartphone } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { toErrorMessage } from "@/lib/app-error"
import {
  hostChoiceView,
  setHostChoice,
  useHostDevices,
  type HostCapability,
  type HostDevices,
  type LendingDevice,
} from "@/lib/cowork/host-choice"
import { useCoworkText } from "@/lib/cowork/i18n"
import { cn } from "@/lib/utils"

const AGENT_MARK = "text-violet-600 dark:text-violet-400"
const TROUBLE_TONE = "text-amber-600 dark:text-amber-400"

const CAPABILITIES: HostCapability[] = ["browser", "shell"]

export function StatusBarHostChoice({ className }: { className?: string }) {
  const t = useCoworkText()
  const [open, setOpen] = useState(false)
  const { state, thisDeviceId, adopt } = useHostDevices(open)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!state) return null
  const fixed = CAPABILITIES.some((c) => state.choices[c] !== null)
  if (state.devices.length === 0 && !fixed) return null

  const away = CAPABILITIES.some((c) => hostChoiceView(state, c).away)
  const nameOf = (device: { name: string }) =>
    device.name || t("hostChoiceUnnamed")

  const choose = async (capability: HostCapability, id: string | null) => {
    setBusy(true)
    setError(null)
    try {
      adopt(await setHostChoice(capability, id))
    } catch (e) {
      setError(t("hostChoiceFailed", { message: toErrorMessage(e) }))
    } finally {
      setBusy(false)
    }
  }

  return (
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
          aria-label={t("hostChoiceTitle")}
          title={t(away ? "hostChoiceTooltipAway" : "hostChoiceTitle")}
          data-host-choice-away={away ? "true" : "false"}
          className={cn(
            "flex shrink-0 items-center transition-colors",
            away ? TROUBLE_TONE : "hover:text-foreground",
            className
          )}
        >
          <MonitorSmartphone className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 gap-2 p-2.5">
        <span className="truncate text-xs font-medium">
          {t("hostChoiceTitle")}
        </span>
        <p className="text-2xs text-muted-foreground">{t("hostChoiceIntro")}</p>

        <ul className="flex flex-col divide-y rounded-md border">
          {state.devices.length === 0 && (
            <li className="px-2 py-1.5 text-2xs text-muted-foreground">
              {t("hostChoiceEmpty")}
            </li>
          )}
          {state.devices.map((device) => (
            <DeviceRow
              key={device.key}
              device={device}
              name={nameOf(device)}
              here={device.id !== null && device.id === thisDeviceId}
            />
          ))}
        </ul>

        {CAPABILITIES.map((capability) => (
          <ChoiceRow
            key={capability}
            capability={capability}
            state={state}
            disabled={busy}
            nameOf={nameOf}
            onChoose={(id) => void choose(capability, id)}
          />
        ))}

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
  )
}

/** One connected computer and what it lends. */
function DeviceRow({
  device,
  name,
  here,
}: {
  device: LendingDevice
  name: string
  here: boolean
}) {
  const t = useCoworkText()
  const lends = [
    device.browser && t("hostChoiceLendsBrowser"),
    device.chrome && t("hostChoiceLendsChrome"),
    device.shell && t("hostChoiceLendsShell"),
  ].filter((label): label is string => !!label)
  return (
    <li
      data-host-choice-device={device.key}
      className="flex items-center gap-2 px-2 py-1.5"
    >
      <Laptop className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-xs">
          <span className="truncate">{name}</span>
          {here && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
              {t("hostChoiceThis")}
            </span>
          )}
        </span>
        <span
          className={cn(
            "truncate text-2xs",
            lends.length > 0 ? AGENT_MARK : "text-muted-foreground"
          )}
        >
          {lends.length > 0 ? lends.join(" · ") : t("hostChoiceLendsNothing")}
        </span>
        {device.id === null && (
          <span className="truncate text-3xs text-muted-foreground">
            {t("hostChoiceOld")}
          </span>
        )}
      </span>
    </li>
  )
}

/** What one capability is fixed to, the menu to change it, and where its
 *  calls go now. */
function ChoiceRow({
  capability,
  state,
  disabled,
  nameOf,
  onChoose,
}: {
  capability: HostCapability
  state: HostDevices
  disabled: boolean
  nameOf: (device: { name: string }) => string
  onChoose: (deviceId: string | null) => void
}) {
  const t = useCoworkText()
  const { pinned, now, away } = hostChoiceView(state, capability)
  const label = t(
    capability === "browser" ? "hostChoiceBrowser" : "hostChoiceShell"
  )
  const connected = pinned
    ? state.devices.find((device) => device.id === pinned.id)
    : undefined
  const current = !pinned
    ? t("hostChoiceAuto")
    : connected
      ? nameOf(connected)
      : t("hostChoiceAwayOption", { name: nameOf(pinned) })
  const choosable = state.devices.filter((device) => device.id !== null)

  return (
    <div
      data-host-choice={capability}
      data-away={away ? "true" : "false"}
      className="flex flex-col gap-1 rounded-md border px-2 py-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs">{label}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              aria-label={`${label} · ${current}`}
              className="max-w-40 shrink-0"
            >
              <span className="truncate">{current}</span>
              <ChevronDown className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem
              disabled={!pinned}
              onSelect={() => onChoose(null)}
            >
              {t("hostChoiceAuto")}
            </DropdownMenuItem>
            {choosable.map((device) => (
              <DropdownMenuItem
                key={device.key}
                disabled={pinned?.id === device.id}
                onSelect={() => onChoose(device.id)}
              >
                {nameOf(device)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p
        className={cn(
          "text-2xs",
          away ? TROUBLE_TONE : "text-muted-foreground"
        )}
      >
        {away && pinned
          ? t("hostChoiceAway", { name: nameOf(pinned) })
          : now
            ? t("hostChoiceNow", { name: nameOf(now) })
            : t("hostChoiceNone")}
      </p>
      {!pinned && (
        <p className="text-3xs text-muted-foreground">
          {t(
            capability === "browser"
              ? "hostChoiceAutoBrowserHint"
              : "hostChoiceAutoShellHint"
          )}
        </p>
      )}
    </div>
  )
}
