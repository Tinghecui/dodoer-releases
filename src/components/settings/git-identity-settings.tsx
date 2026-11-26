"use client"

import { useEffect, useId, useState } from "react"
import { Loader2, UserRound } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getGitIdentity, setGitIdentity } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { GitIdentity } from "@/lib/types"

/**
 * 提交身份（#1419）：提交记录上的作者姓名和邮箱，读写的是运行 dodoer 的
 * 那个系统用户的全局 git 配置（user.name / user.email）。没配过的机器上
 * 提交会被 git 拒绝，提交窗口的「去设置」就是打开到这里。
 */
export function GitIdentitySettings() {
  const t = useTranslations("VersionControlSettings")
  const nameId = useId()
  const emailId = useId()
  const [saved, setSaved] = useState<GitIdentity | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getGitIdentity()
      .then((identity) => {
        if (cancelled) return
        setSaved(identity)
        setName(identity.name ?? "")
        setEmail(identity.email ?? "")
      })
      .catch((e) => {
        if (!cancelled) setLoadError(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const trimmedName = name.trim()
  const trimmedEmail = email.trim()
  const complete = trimmedName !== "" && trimmedEmail !== ""
  const dirty =
    saved != null &&
    (trimmedName !== (saved.name ?? "") || trimmedEmail !== (saved.email ?? ""))
  const notSet = saved != null && (!saved.name || !saved.email)

  const save = async () => {
    if (!complete) return
    setSaving(true)
    try {
      const next = await setGitIdentity(trimmedName, trimmedEmail)
      setSaved(next)
      setName(next.name ?? "")
      setEmail(next.email ?? "")
      toast.success(t("saveSuccess"))
    } catch (e) {
      toast.error(t("saveFailed", { message: toErrorMessage(e) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <UserRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("identity.title")}</h2>
      </div>
      <p className="text-xs text-muted-foreground leading-5">
        {t("identity.description")}
      </p>

      {loadError !== null ? (
        <p role="alert" className="text-xs text-red-400 break-words">
          {t("loadFailed", { message: loadError })}
        </p>
      ) : (
        notSet && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t("identity.notSet")}
          </p>
        )
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label
            htmlFor={nameId}
            className="text-xs font-medium text-muted-foreground"
          >
            {t("identity.name")}
          </label>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("identity.namePlaceholder")}
            disabled={saved == null}
            autoComplete="name"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor={emailId}
            className="text-xs font-medium text-muted-foreground"
          >
            {t("identity.email")}
          </label>
          <Input
            id={emailId}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("identity.emailPlaceholder")}
            disabled={saved == null}
            autoComplete="email"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {dirty && !complete && (
          <span className="text-2xs text-muted-foreground">
            {t("identity.required")}
          </span>
        )}
        <Button
          size="sm"
          onClick={save}
          disabled={saving || saved == null || !dirty || !complete}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            t("save")
          )}
        </Button>
      </div>
    </section>
  )
}
