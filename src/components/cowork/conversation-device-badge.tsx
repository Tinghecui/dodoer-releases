"use client"

// Cowork fork: the button beside a conversation's composer naming the
// device its agent works on (`docs/devices.md` 6.7 and 8), amber while the
// agent cannot go on with it or is waiting for one. Clicked, it lists the
// person's devices to pick this conversation's from: the pick is theirs, so
// the agent does not ask. On a server from before the picker it only shows
// the device; to switch, the person tells the agent.

import { useState } from "react"
import { Check, Laptop, Monitor } from "lucide-react"
import { useLocale } from "next-intl"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useTabStore } from "@/contexts/tab-context"
import { toErrorMessage } from "@/lib/app-error"
import {
  deviceTrouble,
  offersPick,
  useConversationDeviceState,
} from "@/lib/cowork/conversation-device"
import {
  lastSeenText,
  useHostDevices,
  type HostDevice,
} from "@/lib/cowork/host-devices"
import { useCoworkText } from "@/lib/cowork/i18n"
import { cn } from "@/lib/utils"

const TROUBLE_TONE = "text-amber-600 dark:text-amber-400"

function KindIcon({ kind }: { kind: string | null }) {
  const Icon = kind === "laptop" ? Laptop : Monitor
  return <Icon className="size-3.5 shrink-0" />
}

export function ConversationDeviceBadge({ tabId }: { tabId: string | null }) {
  const t = useCoworkText()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  // 数据库里的对话编号：服务器和智能体都按它记设备。新对话的
  // `runtimeConversationId` 是虚拟的负数，不能发给服务器（#332）；
  // 对话还没存进数据库时没有编号，这时不显示按钮。
  const conversationId = useTabStore((s) => {
    const tab = s.tabs.find((x) => x.id === tabId)
    if (!tab || tab.kind !== "conversation") return null
    return tab.conversationId ?? null
  })
  const state = useConversationDeviceState(conversationId)
  if (!state) return null
  const { answer, canPick, pick } = state
  const device = answer.device
  if (!canPick && !device) return null
  if (canPick && !offersPick(answer)) return null

  const trouble = device ? deviceTrouble(device) : null
  const waiting = !device && !!answer.needsPick
  const title = device
    ? trouble === "offline"
      ? t("conversationDeviceOffline", {
          name: device.name,
          when: lastSeenText(device.lastSeen, locale),
        })
      : trouble === "lendsNothing"
        ? t("conversationDeviceLendsNothing", { name: device.name })
        : t(
            canPick
              ? "conversationDeviceWorksOnPick"
              : "conversationDeviceWorksOn",
            { name: device.name }
          )
    : waiting
      ? t("conversationDeviceNeedsPick")
      : t("conversationDevicePickHint")
  const label = device ? device.name : t("conversationDevicePick")
  const markProps = {
    "data-conversation-device": device?.name ?? "",
    "data-trouble": trouble ?? undefined,
    "data-needs-pick": waiting ? "true" : undefined,
    title,
    "aria-label": title,
  }
  const content = (
    <>
      {device ? (
        <KindIcon kind={device.kind} />
      ) : (
        <Monitor className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </>
  )

  if (!canPick) {
    return (
      <span
        {...markProps}
        className={cn(
          "flex min-w-0 max-w-32 items-center gap-1",
          trouble && TROUBLE_TONE
        )}
      >
        {content}
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...markProps}
          className={cn(
            "flex min-w-0 max-w-32 items-center gap-1 transition-colors hover:text-foreground",
            !device && !waiting && "text-muted-foreground",
            (trouble || waiting) && TROUBLE_TONE,
            waiting && "font-medium"
          )}
        >
          {content}
          {waiting && (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 gap-2 p-2.5">
        <DevicePickerMenu
          currentId={device?.id ?? null}
          waiting={waiting}
          onPick={async (id) => {
            await pick(id)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** The person's devices, to pick the conversation's from. Mounted only
 *  while the menu is open, so the book is read only then. */
export function DevicePickerMenu({
  currentId,
  waiting,
  onPick,
}: {
  currentId: string | null
  waiting: boolean
  onPick: (deviceId: string | null) => Promise<void>
}) {
  const t = useCoworkText()
  const { list, thisDeviceId } = useHostDevices(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = async (id: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await onPick(id)
    } catch (e) {
      setError(
        t("conversationDevicePickFailed", { message: toErrorMessage(e) })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <span className="truncate text-xs font-medium">
        {t("conversationDevicePickTitle")}
      </span>
      <p
        className={cn(
          "text-2xs",
          waiting ? TROUBLE_TONE : "text-muted-foreground"
        )}
      >
        {waiting
          ? t("conversationDeviceNeedsPick")
          : t("conversationDevicePickIntro")}
      </p>
      {!list ? (
        <p className="text-2xs text-muted-foreground">
          {t("conversationDevicePickLoading")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {list.devices.length === 0 && (
            <li className="px-2 py-1.5 text-2xs text-muted-foreground">
              {t("devicesEmpty")}
            </li>
          )}
          {list.devices.map((device) => (
            <li key={device.id}>
              <PickRow
                device={device}
                here={device.id === thisDeviceId}
                chosen={device.id === currentId}
                disabled={busy}
                onChoose={() => void choose(device.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {currentId && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose(null)}
          className="self-start text-2xs text-muted-foreground hover:text-foreground"
        >
          {t("conversationDevicePickNone")}
        </button>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs break-words text-red-400"
        >
          {error}
        </div>
      )}
    </>
  )
}

/** One device to pick: its name, which computer, where it is, what it
 *  lends. One that cannot be used now is pickable too; it says why. */
function PickRow({
  device,
  here,
  chosen,
  disabled,
  onChoose,
}: {
  device: HostDevice
  here: boolean
  chosen: boolean
  disabled: boolean
  onChoose: () => void
}) {
  const t = useCoworkText()
  const locale = useLocale()
  const lends = [
    device.shell && t("devicesLendsShell"),
    device.browser && t("devicesLendsBrowser"),
    device.chrome && t("devicesLendsChrome"),
  ].filter((label): label is string => !!label)
  const about = device.computerName || device.model
  const status = device.stopped
    ? t("devicesStopped")
    : device.online
      ? `${t("devicesOnline")} · ${
          lends.length > 0 ? lends.join(" · ") : t("devicesLendsNothing")
        }`
      : t("devicesLastSeen", { when: lastSeenText(device.lastSeen, locale) })
  const usable = device.online && !device.stopped && lends.length > 0

  return (
    <button
      type="button"
      data-pick-device={device.id}
      aria-pressed={chosen}
      disabled={disabled}
      onClick={onChoose}
      className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-muted/50 disabled:opacity-60"
    >
      <span className="pt-0.5 text-muted-foreground">
        <KindIcon kind={device.kind} />
      </span>
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
        <span
          className={cn(
            "text-2xs",
            usable ? "text-muted-foreground" : TROUBLE_TONE
          )}
        >
          {status}
        </span>
      </span>
      {chosen && <Check className="mt-0.5 size-3.5 shrink-0" />}
    </button>
  )
}
