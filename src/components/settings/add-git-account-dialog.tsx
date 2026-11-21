"use client"

import { useCallback, useId, useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { randomUUID } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { saveAccountToken } from "@/lib/api"
import type { GitHubAccount } from "@/lib/types"

/** 把用户填的服务器地址规范成 http(s) 地址；不是合法地址时返回 null。
 *  没写协议、又像主机名（字母、数字、`.-:`，没有空格）的补上 `https://`，
 *  其余的交给 `URL` 解析，协议必须是 http 或 https，主机不能为空。 */
export function normalizeGitServerUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const candidate =
    !trimmed.includes("://") && /^[A-Za-z0-9.\-:]+(\/\S*)?$/.test(trimmed)
      ? `https://${trimmed}`
      : trimmed
  if (/\s/.test(candidate)) return null
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  if (!parsed.hostname) return null
  // 保留用户写的路径，只去掉路径末尾多余的斜杠；
  // 查询参数和 # 后面的内容原样保留，不然存下来的就不是用户填的地址
  const tailAt = candidate.search(/[?#]/)
  const head = tailAt === -1 ? candidate : candidate.slice(0, tailAt)
  const tail = tailAt === -1 ? "" : candidate.slice(tailAt)
  return head.replace(/\/+$/, "") + tail
}

interface AddGitAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAccountAdded: (account: GitHubAccount) => void
  isFirstAccount: boolean
}

export function AddGitAccountDialog({
  open,
  onOpenChange,
  onAccountAdded,
  isFirstAccount,
}: AddGitAccountDialogProps) {
  const t = useTranslations("VersionControlSettings")
  const ime = useImeGuard()

  const [serverUrl, setServerUrl] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 地址的错误单独存，显示在地址输入框下面，让用户就地看到哪里填错了
  const [serverError, setServerError] = useState<string | null>(null)
  const serverErrorId = useId()

  const resetForm = useCallback(() => {
    setServerUrl("")
    setUsername("")
    setPassword("")
    setShowPassword(false)
    setError(null)
    setServerError(null)
  }, [])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) resetForm()
      onOpenChange(nextOpen)
    },
    [onOpenChange, resetForm]
  )

  const handleSubmit = useCallback(async () => {
    const trimmedUrl = serverUrl.trim()
    const trimmedUser = username.trim()
    const trimmedPass = password.trim()

    if (!trimmedUrl) {
      setServerError(t("gitAccount.serverRequired"))
      return
    }
    const normalizedUrl = normalizeGitServerUrl(trimmedUrl)
    if (!normalizedUrl) {
      setServerError(t("gitAccount.serverInvalid"))
      return
    }
    if (!trimmedUser) {
      setError(t("gitAccount.usernameRequired"))
      return
    }
    if (!trimmedPass) {
      setError(t("gitAccount.passwordRequired"))
      return
    }

    const account: GitHubAccount = {
      id: randomUUID(),
      server_url: normalizedUrl,
      username: trimmedUser,
      scopes: [],
      avatar_url: null,
      is_default: isFirstAccount,
      created_at: new Date().toISOString(),
    }

    try {
      await saveAccountToken(account.id, trimmedPass)
    } catch {
      setError(t("gitAccount.passwordRequired"))
      return
    }

    onAccountAdded(account)
    handleOpenChange(false)
  }, [
    serverUrl,
    username,
    password,
    isFirstAccount,
    onAccountAdded,
    handleOpenChange,
    t,
  ])

  const canSubmit =
    serverUrl.trim().length > 0 &&
    username.trim().length > 0 &&
    password.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("gitAccount.addTitle")}</DialogTitle>
          <DialogDescription>
            {t("gitAccount.addDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("gitAccount.serverUrl")}
            </label>
            <Input
              value={serverUrl}
              onChange={(e) => {
                setServerUrl(e.target.value)
                setError(null)
                setServerError(null)
              }}
              placeholder={t("gitAccount.serverUrlPlaceholder")}
              aria-invalid={serverError ? true : undefined}
              aria-describedby={serverError ? serverErrorId : undefined}
              autoFocus
            />
            {serverError && (
              <p id={serverErrorId} className="text-xs text-red-400">
                {serverError}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("gitAccount.username")}
            </label>
            <Input
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                setError(null)
              }}
              placeholder={t("gitAccount.usernamePlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("gitAccount.password")}
            </label>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setError(null)
                }}
                placeholder={t("gitAccount.passwordPlaceholder")}
                className="pr-9"
                {...ime.props}
                onKeyDown={(e) => {
                  if (ime.isComposing(e)) return
                  if (e.key === "Enter" && canSubmit) handleSubmit()
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <p className="text-2xs text-muted-foreground">
              {t("gitAccount.passwordHint")}
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {t("gitAccount.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
