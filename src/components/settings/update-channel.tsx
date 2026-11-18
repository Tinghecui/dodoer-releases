"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  getUpdateChannel,
  parseUpdateChannel,
  setUpdateChannel,
  type UpdateChannel,
  usesTauriUpdater,
} from "@/lib/updater"
import { cn } from "@/lib/utils"

const CHOICES: Array<{
  channel: UpdateChannel
  label: "channelStable" | "channelEarly"
  hint: "channelStableHint" | "channelEarlyHint"
}> = [
  { channel: "stable", label: "channelStable", hint: "channelStableHint" },
  { channel: "early", label: "channelEarly", hint: "channelEarlyHint" },
]

/**
 * Cowork fork（issue #413）：设置 → 系统 →「软件更新」里的「更新通道」，
 * 稳定版 / 抢先版。桌面窗口（本机和远端窗口都算，各个系统都有）才有，而且
 * 只在这个构建有通道时显示（更新源不是 GitHub Release 的构建没有）。设置存在
 * 桌面主程序里，经 shell transport 读写。存好以后调 `onChanged`，由设置页
 * 立刻按新通道再查一次。
 */
export function UpdateChannelSetting({
  onChanged,
}: {
  onChanged?: (channel: UpdateChannel) => void
}) {
  if (!usesTauriUpdater()) return null
  return <UpdateChannelChoices onChanged={onChanged} />
}

function UpdateChannelChoices({
  onChanged,
}: {
  onChanged?: (channel: UpdateChannel) => void
}) {
  const t = useTranslations("SystemSettings")
  // 读到之前不显示：不知道这个构建有没有通道。
  const [available, setAvailable] = useState(false)
  const [channel, setChannel] = useState<UpdateChannel>("stable")
  const [saving, setSaving] = useState(false)
  // 用户已经点过：晚到的第一次读数不盖掉它。
  const touchedRef = useRef(false)
  // 正在存：这时回到窗口的重读不算数，以存的结果为准。
  const savingRef = useRef(false)
  const channelRef = useRef<UpdateChannel>("stable")
  // 第一次读数到了没有：之后再读到不一样的通道，就是别的窗口改过了。
  const loadedRef = useRef(false)
  const onChangedRef = useRef(onChanged)
  useEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])

  useEffect(() => {
    let cancelled = false
    // 偏好存在桌面主程序里，几个设置窗口共用一份：挂载时读一次，窗口回到
    // 前台时再读一次。别的窗口改过的，这里跟着改，并按新通道重新检查。
    const read = () => {
      getUpdateChannel()
        .then((stored) => {
          if (cancelled || savingRef.current) return
          setAvailable(stored.channelsAvailable)
          const first = !loadedRef.current
          loadedRef.current = true
          if (first && touchedRef.current) return
          if (stored.channel === channelRef.current) return
          channelRef.current = stored.channel
          setChannel(stored.channel)
          if (!first) onChangedRef.current?.(stored.channel)
        })
        .catch((err) =>
          console.debug("[Update] could not read the update channel:", err)
        )
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") read()
    }
    read()
    window.addEventListener("focus", read)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      window.removeEventListener("focus", read)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  if (!available) return null

  const choose = async (value: string) => {
    const next = parseUpdateChannel(value)
    if (next === channel || saving) return
    touchedRef.current = true
    const previous = channel
    channelRef.current = next
    setChannel(next)
    savingRef.current = true
    setSaving(true)
    let saved: UpdateChannel
    try {
      saved = (await setUpdateChannel(next)).channel
      channelRef.current = saved
      setChannel(saved)
    } catch (err) {
      channelRef.current = previous
      setChannel(previous)
      toast.error(t("channelSaveFailed"))
      console.error("[Update] saving the update channel failed:", err)
      return
    } finally {
      savingRef.current = false
      setSaving(false)
    }
    onChanged?.(saved)
  }

  return (
    <div className="space-y-2 pt-2 border-t border-border/70">
      <div className="font-medium">{t("channelTitle")}</div>
      <RadioGroup
        value={channel}
        onValueChange={(value) => void choose(value)}
        disabled={saving}
        className="gap-2"
      >
        {CHOICES.map((choice) => {
          const id = `update-channel-${choice.channel}`
          return (
            <label
              key={choice.channel}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-2xs",
                channel === choice.channel
                  ? "border-primary bg-primary/5"
                  : "border-input"
              )}
            >
              <RadioGroupItem
                value={choice.channel}
                id={id}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium text-foreground">
                  {t(choice.label)}
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  {t(choice.hint)}
                </span>
              </span>
            </label>
          )
        })}
      </RadioGroup>
    </div>
  )
}

/** 版本号后面的「· 抢先版」：上一次检查走的是抢先版时才有。 */
export function UpdateChannelBadge({
  channel,
}: {
  channel: UpdateChannel | null
}) {
  const t = useTranslations("SystemSettings")
  if (channel !== "early") return null
  return <span className="ml-1">{`· ${t("channelEarlyBadge")}`}</span>
}
