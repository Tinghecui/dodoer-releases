"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useIsMac } from "@/hooks/use-is-mac"
import {
  getUpdateMode,
  parseUpdateMode,
  setUpdateMode,
  UPDATE_MODE_CHANGED_EVENT,
  type UpdateMode,
  usesTauriUpdater,
} from "@/lib/updater"
import { cn } from "@/lib/utils"

const CHOICES: Array<{
  mode: UpdateMode
  label: "autoUpdateAuto" | "autoUpdateDownload" | "autoUpdateOff"
  hint: "autoUpdateAutoHint" | "autoUpdateDownloadHint" | "autoUpdateOffHint"
}> = [
  { mode: "auto", label: "autoUpdateAuto", hint: "autoUpdateAutoHint" },
  {
    mode: "download",
    label: "autoUpdateDownload",
    hint: "autoUpdateDownloadHint",
  },
  { mode: "off", label: "autoUpdateOff", hint: "autoUpdateOffHint" },
]

/**
 * Cowork fork：设置 → 系统 →「软件更新」里的「自动更新」三档。只有 macOS
 * 桌面窗口（本机和远端窗口都算）有：空闲时自动重启、启动时换上只在 macOS
 * 上做。设置存在桌面主程序里，经 shell transport 读写，远端窗口也一样。
 */
export function AutoUpdateModeSetting() {
  const isMac = useIsMac()
  const visible = isMac && usesTauriUpdater()
  if (!visible) return null
  return <AutoUpdateModeChoices />
}

function AutoUpdateModeChoices() {
  const t = useTranslations("SystemSettings")
  // 读到之前先按 auto 显示（后端没有这一项时也算 auto）。
  const [mode, setMode] = useState<UpdateMode>("auto")
  const [saving, setSaving] = useState(false)
  // 用户已经点过：晚到的读数不盖掉它。
  const touchedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    getUpdateMode()
      .then((stored) => {
        if (!cancelled && !touchedRef.current) setMode(stored)
      })
      .catch((err) =>
        console.debug("[Update] could not read the update setting:", err)
      )
    return () => {
      cancelled = true
    }
  }, [])

  const choose = async (value: string) => {
    const next = parseUpdateMode(value)
    if (next === mode || saving) return
    touchedRef.current = true
    const previous = mode
    setMode(next)
    setSaving(true)
    try {
      const saved = await setUpdateMode(next)
      setMode(saved)
      window.dispatchEvent(
        new CustomEvent(UPDATE_MODE_CHANGED_EVENT, { detail: saved })
      )
    } catch (err) {
      setMode(previous)
      toast.error(t("autoUpdateSaveFailed"))
      console.error("[Update] saving the update setting failed:", err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 pt-2 border-t border-border/70">
      <div className="font-medium">{t("autoUpdateTitle")}</div>
      <RadioGroup
        value={mode}
        onValueChange={(value) => void choose(value)}
        disabled={saving}
        className="gap-2"
      >
        {CHOICES.map((choice) => {
          const id = `auto-update-mode-${choice.mode}`
          return (
            <label
              key={choice.mode}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-2xs",
                mode === choice.mode
                  ? "border-primary bg-primary/5"
                  : "border-input"
              )}
            >
              <RadioGroupItem value={choice.mode} id={id} className="mt-0.5" />
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
