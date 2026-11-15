"use client"

// Cowork fork: the mark beside a conversation's composer naming the device
// its agent works on (`docs/devices.md` 8), amber while the agent cannot go
// on with it. Only shown: to switch, the person tells the agent.

import { Laptop, Monitor } from "lucide-react"
import { useLocale } from "next-intl"

import { useTabStore } from "@/contexts/tab-context"
import {
  deviceTrouble,
  useConversationDevice,
} from "@/lib/cowork/conversation-device"
import { lastSeenText } from "@/lib/cowork/host-devices"
import { useCoworkText } from "@/lib/cowork/i18n"
import { cn } from "@/lib/utils"

const TROUBLE_TONE = "text-amber-600 dark:text-amber-400"

export function ConversationDeviceBadge({ tabId }: { tabId: string | null }) {
  const t = useCoworkText()
  const locale = useLocale()
  // The tab's conversation, as `ComposerContextUsage` resolves it.
  const conversationId = useTabStore((s) => {
    const tab = s.tabs.find((x) => x.id === tabId)
    if (!tab || tab.kind !== "conversation") return null
    return tab.runtimeConversationId ?? tab.conversationId ?? null
  })
  const device = useConversationDevice(conversationId)
  if (!device) return null

  const trouble = deviceTrouble(device)
  const title =
    trouble === "offline"
      ? t("conversationDeviceOffline", {
          name: device.name,
          when: lastSeenText(device.lastSeen, locale),
        })
      : trouble === "lendsNothing"
        ? t("conversationDeviceLendsNothing", { name: device.name })
        : t("conversationDeviceWorksOn", { name: device.name })
  const Icon = device.kind === "laptop" ? Laptop : Monitor

  return (
    <span
      data-conversation-device={device.name}
      data-trouble={trouble ?? undefined}
      title={title}
      aria-label={title}
      className={cn(
        "flex min-w-0 max-w-32 items-center gap-1",
        trouble && TROUBLE_TONE
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{device.name}</span>
    </span>
  )
}
