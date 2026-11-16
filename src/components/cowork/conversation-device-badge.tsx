"use client"

// Cowork fork: the button beside a conversation's composer naming the
// device its agent works on (`docs/devices.md` 6.7 and 8), amber while the
// agent cannot go on with it or is waiting for one. Clicked, it lists the
// person's devices to pick this conversation's from: the pick is theirs, so
// the agent does not ask. On a server from before the picker it only shows
// the device; to switch, the person tells the agent. 服务器能分开选时
// （`conversation_device_split`），命令行和浏览器各选一台，标记上两样都写，
// 哪一样用不了就那一半变琥珀色，智能体正在用哪一样就那一半变蓝、带一个
// 闪的点（和 `SessionUsageMark` 同一个颜色）。

import { useState } from "react"
import {
  Check,
  Chrome,
  Globe,
  Laptop,
  Monitor,
  SquareTerminal,
} from "lucide-react"
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
  partTrouble,
  useConversationDeviceState,
  type ConversationDeviceAnswer,
  type DevicePart,
  type PartTrouble,
} from "@/lib/cowork/conversation-device"
import {
  lastSeenText,
  useHostDevices,
  type HostDevice,
} from "@/lib/cowork/host-devices"
import { useCoworkText, type CoworkTextKey } from "@/lib/cowork/i18n"
import { useSessionUsage, type SessionUse } from "@/lib/cowork/session-usage"
import { cn } from "@/lib/utils"

const TROUBLE_TONE = "text-amber-600 dark:text-amber-400"
/** 「正在用」的颜色，和 `session-usage-mark.tsx` 的 `TONE` 一样。 */
const IN_USE_TONE = "text-sky-600 dark:text-sky-400"

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
  const { answer, canPick, canSplit, pick } = state
  if (canPick && canSplit) {
    return (
      <SplitDeviceBadge
        conversationId={conversationId}
        answer={answer}
        pick={pick}
      />
    )
  }
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

type Text = ReturnType<typeof useCoworkText>

const DOT = (
  <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
)

const IN_USE_DOT = (
  <span
    data-in-use-dot=""
    className="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500"
  />
)

/** 智能体正在用 `device` 的这一样：使用记录按设备名字记，没名字的
 *  （这个服务器所在的那台、或者老的 app）认不出是哪台，不算。 */
function partInUse(
  uses: SessionUse[],
  part: DevicePart,
  device: HostDevice | null
): boolean {
  if (!device) return false
  return uses.some((use) => use.kind === part && use.device === device.name)
}

const PART_LABEL: Record<DevicePart, CoworkTextKey> = {
  shell: "devicesLendsShell",
  browser: "devicesLendsBrowser",
}

const SHORT_TROUBLE: Record<PartTrouble, CoworkTextKey> = {
  notLent: "conversationDeviceNotLent",
  offline: "conversationDeviceOfflineShort",
  stopped: "conversationDeviceStoppedShort",
}

/** 浏览器那台借出的是 Chrome 时用 Chrome 的图标，否则用地球。 */
function PartIcon({
  part,
  device,
}: {
  part: DevicePart
  device: HostDevice | null
}) {
  const Icon =
    part === "shell" ? SquareTerminal : device?.chrome ? Chrome : Globe
  return <Icon data-part-icon={part} className="size-3.5 shrink-0" />
}

/** 一样的现状（`title` 里的一行）：在哪台、为什么用不了、在等。 */
function partLine(
  t: Text,
  locale: string,
  part: DevicePart,
  device: HostDevice | null,
  waiting: boolean,
  inUse: boolean
): string {
  const label = t(PART_LABEL[part])
  if (!device) {
    if (waiting) {
      return t(
        part === "shell"
          ? "conversationDeviceShellWaiting"
          : "conversationDeviceBrowserWaiting"
      )
    }
    return t("conversationDevicePartNotPicked", { part: label })
  }
  switch (partTrouble(device, part)) {
    case "stopped":
      return t("conversationDevicePartStopped", {
        part: label,
        name: device.name,
      })
    case "offline":
      return t("conversationDevicePartOffline", {
        part: label,
        name: device.name,
        when: lastSeenText(device.lastSeen, locale),
      })
    case "notLent":
      return t(
        part === "shell"
          ? "conversationDeviceShellNotLent"
          : "conversationDeviceBrowserNotLent",
        { name: device.name }
      )
    default:
      return t(
        inUse ? "conversationDevicePartInUse" : "conversationDevicePartIs",
        { part: label, name: device.name }
      )
  }
}

/** 标记的一半：一样的图标，加上那台的名字、「没选」或用不了的原因。 */
function PartHalf({
  part,
  device,
  waiting,
  using,
}: {
  part: DevicePart
  device: HostDevice | null
  waiting: boolean
  using: boolean
}) {
  const t = useCoworkText()
  const trouble = device ? partTrouble(device, part) : null
  // 「正在用」和「用不了」同时成立时显示「用不了」
  const inUse = using && !trouble
  const text = trouble
    ? t(SHORT_TROUBLE[trouble])
    : device
      ? device.name
      : t("conversationDeviceNotPicked")
  return (
    <span
      data-device-part={part}
      data-trouble={trouble ?? undefined}
      data-needs-pick={waiting ? "true" : undefined}
      data-in-use={inUse ? part : undefined}
      className={cn(
        "flex min-w-0 items-center gap-1",
        !device && !waiting && "text-muted-foreground",
        (trouble || waiting) && TROUBLE_TONE,
        inUse && IN_USE_TONE,
        waiting && "font-medium"
      )}
    >
      <PartIcon part={part} device={device} />
      <span className="truncate">{text}</span>
      {waiting && DOT}
      {inUse && IN_USE_DOT}
    </span>
  )
}

/** 能分开选的服务器上的标记：两样同一台时写一个名字带两个小图标，
 *  不同台时一样一半。点开是分两列的菜单。 */
function SplitDeviceBadge({
  conversationId,
  answer,
  pick,
}: {
  conversationId: number | null
  answer: ConversationDeviceAnswer
  pick: (deviceId: string | null, part?: DevicePart) => Promise<void>
}) {
  const t = useCoworkText()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  // 实时的「正在用」（`conversation://device-usage`），委派出去的子对话
  // 服务器已经算在最上面这个对话上
  const uses = useSessionUsage(conversationId)
  if (!offersPick(answer)) return null

  const shell = answer.device ?? null
  const browser = answer.browserDevice ?? null
  const shellWaiting = !shell && !!answer.needsPick
  const browserWaiting = !browser && !!answer.needsBrowserPick
  const shellTrouble = shell ? partTrouble(shell, "shell") : null
  const browserTrouble = browser ? partTrouble(browser, "browser") : null
  const shellInUse = partInUse(uses, "shell", shell)
  const browserInUse = partInUse(uses, "browser", browser)
  // 同一台、两样的状况也一样时才合起来写一个名字
  const together =
    !!shell &&
    !!browser &&
    shell.id === browser.id &&
    shellTrouble === browserTrouble
  const none = !shell && !browser
  const waiting = shellWaiting || browserWaiting

  const title = [
    partLine(t, locale, "shell", shell, shellWaiting, shellInUse),
    partLine(t, locale, "browser", browser, browserWaiting, browserInUse),
    t("conversationDeviceSplitPickHint"),
  ].join("\n")

  let content
  if (none) {
    content = (
      <>
        <Monitor className="size-3.5 shrink-0" />
        <span className="truncate">{t("conversationDevicePick")}</span>
        {waiting && DOT}
      </>
    )
  } else if (together) {
    content = (
      <>
        <KindIcon kind={shell.kind} />
        <span className="truncate">{shell.name}</span>
        {(["shell", "browser"] as const).map((part) => {
          // 两样同一台时没有两半，正在用的那一样的小图标变蓝
          const inUse =
            !shellTrouble && (part === "shell" ? shellInUse : browserInUse)
          return (
            <span
              key={part}
              data-in-use={inUse ? part : undefined}
              className={cn("flex shrink-0", inUse && IN_USE_TONE)}
            >
              <PartIcon part={part} device={shell} />
            </span>
          )
        })}
        {!shellTrouble && (shellInUse || browserInUse) && IN_USE_DOT}
      </>
    )
  } else {
    content = (
      <>
        <PartHalf
          part="shell"
          device={shell}
          waiting={shellWaiting}
          using={shellInUse}
        />
        <PartHalf
          part="browser"
          device={browser}
          waiting={browserWaiting}
          using={browserInUse}
        />
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-conversation-device={shell?.name ?? ""}
          data-trouble={(together && shellTrouble) || undefined}
          data-needs-pick={none && waiting ? "true" : undefined}
          title={title}
          aria-label={title}
          className={cn(
            "flex min-w-0 max-w-48 items-center gap-1.5 transition-colors hover:text-foreground",
            none && !waiting && "text-muted-foreground",
            ((together && shellTrouble) || (none && waiting)) && TROUBLE_TONE,
            none && waiting && "font-medium"
          )}
        >
          {content}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 gap-2 p-2.5">
        <SplitPickerMenu
          shellId={shell?.id ?? null}
          browserId={browser?.id ?? null}
          shellWaiting={shellWaiting}
          browserWaiting={browserWaiting}
          onPick={async (id, part) => {
            // 选一列的圈不关菜单，好接着选另一列；「不用电脑」两样都清掉、关
            if (part) {
              await pick(id, part)
            } else {
              await pick(id)
              setOpen(false)
            }
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** 分两列的菜单：一台一行，右边「命令行」「浏览器」各一个单选圈。 */
export function SplitPickerMenu({
  shellId,
  browserId,
  shellWaiting,
  browserWaiting,
  onPick,
}: {
  shellId: string | null
  browserId: string | null
  shellWaiting: boolean
  browserWaiting: boolean
  onPick: (deviceId: string | null, part?: DevicePart) => Promise<void>
}) {
  const t = useCoworkText()
  const locale = useLocale()
  const { list, thisDeviceId } = useHostDevices(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = async (id: string | null, part?: DevicePart) => {
    setBusy(true)
    setError(null)
    try {
      await onPick(id, part)
    } catch (e) {
      setError(
        t("conversationDevicePickFailed", { message: toErrorMessage(e) })
      )
    } finally {
      setBusy(false)
    }
  }

  const waitingText =
    shellWaiting && browserWaiting
      ? t("conversationDeviceNeedsPick")
      : shellWaiting
        ? t("conversationDeviceShellWaiting")
        : browserWaiting
          ? t("conversationDeviceBrowserWaiting")
          : null
  const columns = "grid grid-cols-[minmax(0,1fr)_4rem_4.5rem] gap-1"

  return (
    <>
      <span className="truncate text-xs font-medium">
        {t("conversationDevicePickTitle")}
      </span>
      <p
        className={cn(
          "text-2xs",
          waitingText ? TROUBLE_TONE : "text-muted-foreground"
        )}
      >
        {waitingText ?? t("conversationDeviceSplitIntro")}
      </p>
      {!list ? (
        <p className="text-2xs text-muted-foreground">
          {t("conversationDevicePickLoading")}
        </p>
      ) : (
        <div className="flex flex-col divide-y rounded-md border">
          <div
            className={cn(
              columns,
              "px-2 py-1 text-center text-3xs text-muted-foreground"
            )}
          >
            <span />
            <span>{t("devicesLendsShell")}</span>
            <span>{t("devicesLendsBrowser")}</span>
          </div>
          {list.devices.length === 0 && (
            <p className="px-2 py-1.5 text-2xs text-muted-foreground">
              {t("devicesEmpty")}
            </p>
          )}
          {list.devices.map((device) => {
            const about = device.computerName || device.model
            const status = device.stopped
              ? t("conversationDeviceStoppedShort")
              : device.online
                ? t("devicesOnline")
                : t("devicesLastSeen", {
                    when: lastSeenText(device.lastSeen, locale),
                  })
            return (
              <div
                key={device.id}
                data-pick-row={device.id}
                className={cn(columns, "items-start px-2 py-1.5")}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="truncate font-mono">{device.name}</span>
                    {device.id === thisDeviceId && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
                        {t("devicesThis")}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-3xs text-muted-foreground">
                    {about ? `${about} · ${status}` : status}
                  </span>
                </span>
                {(["shell", "browser"] as const).map((part) => (
                  <PartCell
                    key={part}
                    device={device}
                    part={part}
                    chosen={
                      device.id === (part === "shell" ? shellId : browserId)
                    }
                    disabled={busy}
                    onChoose={() => void choose(device.id, part)}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}
      {(shellId || browserId) && (
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

/** 一台的一样：能用就是一个单选圈（浏览器的圈下面写 Chrome 还是内置
 *  浏览器）；用不了就只写原因、点不了，除非它正是选着的那台。 */
function PartCell({
  device,
  part,
  chosen,
  disabled,
  onChoose,
}: {
  device: HostDevice
  part: DevicePart
  chosen: boolean
  disabled: boolean
  onChoose: () => void
}) {
  const t = useCoworkText()
  const trouble = partTrouble(device, part)
  const reason = trouble ? t(SHORT_TROUBLE[trouble]) : null
  return (
    <span
      data-pick-cell={part}
      data-pick-device={device.id}
      className="flex flex-col items-center gap-0.5 pt-0.5 text-center"
    >
      {trouble && !chosen ? (
        <span className="text-3xs text-muted-foreground">{reason}</span>
      ) : (
        <>
          <button
            type="button"
            role="radio"
            aria-checked={chosen}
            aria-label={t("conversationDevicePartOn", {
              part: t(PART_LABEL[part]),
              name: device.name,
            })}
            disabled={disabled}
            onClick={chosen ? undefined : onChoose}
            className={cn(
              "flex size-3.5 items-center justify-center rounded-full border border-muted-foreground/60 hover:border-foreground disabled:opacity-60",
              chosen && "border-foreground"
            )}
          >
            {chosen && <span className="size-1.5 rounded-full bg-foreground" />}
          </button>
          {reason ? (
            <span data-cell-trouble className={cn("text-3xs", TROUBLE_TONE)}>
              {reason}
            </span>
          ) : (
            part === "browser" && (
              <span className="text-3xs text-muted-foreground">
                {device.chrome
                  ? t("devicesLendsChrome")
                  : t("conversationDeviceBuiltInBrowser")}
              </span>
            )
          )}
        </>
      )}
    </span>
  )
}
