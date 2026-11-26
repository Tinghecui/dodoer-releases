"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CheckCircle2,
  Cloud,
  GitBranch,
  GitFork,
  Github,
  Globe,
  Loader2,
  RotateCw,
  Trash2,
  Gitlab,
  XCircle,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import {
  detectGit,
  getGitSettings,
  updateGitSettings,
  testGitPath,
  getGitHubAccounts,
  updateGitHubAccounts,
  validateGitHubToken,
  validateGitLabToken,
  validateGiteaToken,
  validateCnbToken,
  probeGitServer,
  getAccountToken,
  deleteAccountToken,
} from "@/lib/api"
import type {
  ForgeProviderId,
  GitDetectResult,
  GitHubAccount,
  GitHubAccountsSettings,
} from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"
import { AddForgeAccountDialog } from "./add-forge-account-dialog"
import { AddGitAccountDialog } from "./add-git-account-dialog"
import { GitIdentitySettings } from "./git-identity-settings"
import { WorktreeLocationSettings } from "./worktree-location-settings"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Which section an account belongs in. A DECLARED provider decides it outright
 * — that is the whole point of the field, and the only thing that can tell a
 * self-hosted GitLab from a GitHub Enterprise by looking at it. Accounts stored
 * before the field existed keep the rule they were filed under: github.com in
 * the GitHub section, everything else among the plain git credentials.
 */
function isGitHubAccount(account: GitHubAccount): boolean {
  if (account.provider) return account.provider === "github"
  return account.server_url.toLowerCase().includes("github.com")
}

function isGitLabAccount(account: GitHubAccount): boolean {
  return account.provider === "gitlab"
}

/** Gitea (and Forgejo) only ever arrive DECLARED: the section shipped after the
 *  field existed, so there is no legacy shape to guess at the way
 *  `isGitHubAccount` has to. */
function isGiteaAccount(account: GitHubAccount): boolean {
  return account.provider === "gitea"
}

/** CNB, like Gitea, only ever arrives declared. */
function isCnbAccount(account: GitHubAccount): boolean {
  return account.provider === "cnb"
}

/** Which "who am I" endpoint tests an account's stored token, or `null` for a
 *  plain git credential — those have no token API, so the test only probes
 *  whether the server answers at all (`probeGitServer`). */
function validatorFor(
  account: GitHubAccount
): typeof validateGitHubToken | null {
  if (isCnbAccount(account)) return validateCnbToken
  if (isGiteaAccount(account)) return validateGiteaToken
  if (isGitLabAccount(account)) return validateGitLabToken
  if (isGitHubAccount(account)) return validateGitHubToken
  return null
}

/** Which forge dialog reopens for a token rotation. The account's own
 *  declaration decides; GitHub is the fallback because an undeclared account
 *  only ever reaches the rotate action from the GitHub section. */
function providerOf(account: GitHubAccount): ForgeProviderId {
  if (isCnbAccount(account)) return "cnb"
  if (isGiteaAccount(account)) return "gitea"
  if (isGitLabAccount(account)) return "gitlab"
  return "github"
}

/** First character of a username, for the avatar fallback. Split with
 *  `Array.from` so a leading astral-plane character is not halved into a
 *  broken surrogate. */
function accountInitial(username: string): string {
  return Array.from(username.trim())[0]?.toUpperCase() ?? "?"
}

// ---------------------------------------------------------------------------
// Shared account row component
// ---------------------------------------------------------------------------

function AccountRow({
  account,
  testingId,
  onTest,
  onRotate,
  onSetDefault,
  onRemove,
  t,
}: {
  account: GitHubAccount
  testingId: string | null
  onTest: (account: GitHubAccount) => void
  /** Replace this account's token in place. Offered only for forge accounts,
   *  because they are the ones tasks pin by id — see the dialog's comment. */
  onRotate?: (account: GitHubAccount) => void
  onSetDefault: (id: string) => void
  onRemove: (account: GitHubAccount) => void
  t: ReturnType<typeof useTranslations<"VersionControlSettings">>
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/10 px-3 py-2.5">
      {/* Having an avatar URL is not the same as being able to load it, so the
          initial is a fallback the primitive keeps mounted until the image
          actually decodes — not an else-branch for a missing URL. GitLab hands
          out third-party gravatar.com URLs for users who never uploaded a
          picture, and a self-hosted instance can put an avatar behind a login;
          either one fails on the wire and used to leave a hole where the
          account's face should be. */}
      <Avatar>
        {account.avatar_url && (
          <AvatarImage src={account.avatar_url} alt={account.username} />
        )}
        <AvatarFallback className="text-xs font-medium">
          {accountInitial(account.username)}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {account.username}
          </span>
          {account.is_default && (
            <Badge variant="secondary" className="text-3xs px-1.5 py-0">
              {t("defaultLabel")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <span className="truncate">{account.server_url}</span>
          {account.scopes.length > 0 && (
            <>
              <span>·</span>
              <span className="truncate">{account.scopes.join(", ")}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => onTest(account)}
          disabled={testingId === account.id}
        >
          {testingId === account.id ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            t("testConnection")
          )}
        </Button>
        {onRotate && (
          <Button size="xs" variant="ghost" onClick={() => onRotate(account)}>
            {t("updateToken")}
          </Button>
        )}
        {!account.is_default && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onSetDefault(account.id)}
          >
            {t("setDefault")}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => onRemove(account)}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function VersionControlSettings() {
  const t = useTranslations("VersionControlSettings")
  const tSystem = useTranslations("SystemSettings")

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [gitInfo, setGitInfo] = useState<GitDetectResult | null>(null)
  const [customPath, setCustomPath] = useState("")
  const [editingPath, setEditingPath] = useState(false)
  const [savingGit, setSavingGit] = useState(false)

  const [accounts, setAccounts] = useState<GitHubAccountsSettings>({
    accounts: [],
  })
  const [addGitHubOpen, setAddGitHubOpen] = useState(false)
  const [addGitLabOpen, setAddGitLabOpen] = useState(false)
  const [addGiteaOpen, setAddGiteaOpen] = useState(false)
  const [addCnbOpen, setAddCnbOpen] = useState(false)
  const [rotateTarget, setRotateTarget] = useState<GitHubAccount | null>(null)
  const [addGitOpen, setAddGitOpen] = useState(false)
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<GitHubAccount | null>(null)

  // Split accounts into GitHub vs other
  const githubAccounts = useMemo(
    () => accounts.accounts.filter(isGitHubAccount),
    [accounts]
  )
  const gitlabAccounts = useMemo(
    () => accounts.accounts.filter(isGitLabAccount),
    [accounts]
  )
  const giteaAccounts = useMemo(
    () => accounts.accounts.filter(isGiteaAccount),
    [accounts]
  )
  const cnbAccounts = useMemo(
    () => accounts.accounts.filter(isCnbAccount),
    [accounts]
  )
  const gitAccounts = useMemo(
    () =>
      accounts.accounts.filter(
        (a) =>
          !isGitHubAccount(a) &&
          !isGitLabAccount(a) &&
          !isGiteaAccount(a) &&
          !isCnbAccount(a)
      ),
    [accounts]
  )

  const loadData = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [git, settings, ghAccounts] = await Promise.all([
        detectGit(),
        getGitSettings(),
        getGitHubAccounts(),
      ])
      setGitInfo(git)
      setCustomPath(settings.custom_path ?? "")
      setAccounts(ghAccounts)
    } catch (err) {
      setLoadError(toErrorMessage(err))
      console.error("[VersionControlSettings] load failed:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData().catch(console.error)
  }, [loadData])

  // --- Git path handlers ---

  const handleSaveGit = useCallback(async () => {
    const trimmed = customPath.trim()
    setSavingGit(true)
    try {
      // Test first if a custom path is provided
      if (trimmed) {
        const result = await testGitPath(trimmed)
        if (!result.installed) {
          toast.error(
            t("testFailed", { message: "not a valid git executable" })
          )
          return
        }
      }
      await updateGitSettings({ custom_path: trimmed || null })
      const git = await detectGit()
      setGitInfo(git)
      setEditingPath(false)
      toast.success(t("saveSuccess"))
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("saveFailed", { message }))
    } finally {
      setSavingGit(false)
    }
  }, [customPath, t])

  const handleCancelEdit = useCallback(() => {
    setEditingPath(false)
    // Restore to the saved value
    getGitSettings()
      .then((s) => setCustomPath(s.custom_path ?? ""))
      .catch(() => {})
  }, [])

  // --- Shared account handlers ---

  // Every change is made to the list as stored now, not as this page last
  // read it: the credential prompt or another window may have added an
  // account since, and a page whose load failed holds an empty list. A list
  // that cannot be read fails the change instead of being written over.
  const saveAccounts = useCallback(
    async (change: (list: GitHubAccount[]) => GitHubAccount[]) => {
      const current = await getGitHubAccounts()
      const saved = await updateGitHubAccounts({
        accounts: change(current.accounts),
      })
      setAccounts(saved)
    },
    []
  )

  const handleAccountAdded = useCallback(
    async (account: GitHubAccount) => {
      // Replace in place when the id is already known: that is a token
      // rotation, and appending would leave two rows claiming one identity.
      // 默认账号按存着的列表定，不信对话框带来的 is_default：那是按页面上次
      // 读到的列表算的，别的标签页刚加的默认账号它看不到。轮换的保留原来那
      // 一行的默认；新账号只在列表里还没有默认账号时才成为默认，别人的默认不动。
      const add = (list: GitHubAccount[]) => {
        const stored = list.find((a) => a.id === account.id)
        if (stored) {
          return list.map((a) =>
            a.id === account.id
              ? { ...account, is_default: stored.is_default }
              : a
          )
        }
        const hasDefault = list.some((a) => a.is_default)
        return [...list, { ...account, is_default: !hasDefault }]
      }
      try {
        await saveAccounts(add)
        toast.success(t("addSuccess", { username: account.username }))
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("addFailed", { message }))
      }
    },
    [saveAccounts, t]
  )

  const handleTestConnection = useCallback(
    async (account: GitHubAccount) => {
      setTestingAccountId(account.id)
      try {
        const token = await getAccountToken(account.id)
        if (!token) {
          toast.error(t("connectionFailed", { message: "Token not found" }))
          return
        }
        const validate = validatorFor(account)
        if (validate) {
          const result = await validate(account.server_url, token)
          if (result.success) {
            toast.success(t("connectionSuccess"))
          } else {
            toast.error(
              t("connectionFailed", {
                message: result.message ?? "Unknown error",
              })
            )
          }
        } else {
          // 普通 Git 服务器没有统一的令牌校验接口：真去连一下服务器，
          // 连得上也只能说明服务器可达，令牌本身验证不了。
          const result = await probeGitServer(account.server_url)
          if (result.success) {
            toast.success(t("gitAccount.serverReachable"))
          } else {
            toast.error(
              t("connectionFailed", {
                message: result.message ?? "Unknown error",
              })
            )
          }
        }
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("connectionFailed", { message }))
      } finally {
        setTestingAccountId(null)
      }
    },
    [t]
  )

  const handleSetDefault = useCallback(
    async (accountId: string) => {
      try {
        await saveAccounts((list) =>
          list.map((a) => ({ ...a, is_default: a.id === accountId }))
        )
        toast.success(t("defaultSet"))
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(message)
      }
    },
    [saveAccounts, t]
  )

  const handleRemoveAccount = useCallback(async () => {
    if (!removeTarget) return
    try {
      await deleteAccountToken(removeTarget.id)
      await saveAccounts((list) => list.filter((a) => a.id !== removeTarget.id))
      toast.success(t("removeSuccess"))
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(message)
    } finally {
      setRemoveTarget(null)
    }
  }, [removeTarget, saveAccounts, t])

  // --- Render ---

  // Without the saved settings the path field is empty and every account
  // list reads as "no accounts": saving the path would erase a custom git
  // path, and the lists would claim the accounts are gone. Lock the writes
  // and say the read failed until a retry succeeds.
  const locked = loadError !== null
  const emptyOrFailed = (emptyText: string) =>
    loadError !== null ? t("loadFailed", { message: loadError }) : emptyText

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        {loadError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400"
          >
            <span className="min-w-0 break-words">
              {t("loadFailed", { message: loadError })}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => {
                loadData().catch((err) => {
                  console.error("[VersionControlSettings] retry failed:", err)
                })
              }}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {tSystem("retry")}
            </Button>
          </div>
        )}

        {/* ---- Git Configuration ---- */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("gitTitle")}</h2>
          </div>

          <div className="rounded-md border bg-muted/20 px-3 py-3 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {gitInfo?.installed ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                    <span className="text-green-600 dark:text-green-400 font-medium">
                      {t("gitDetected")}
                    </span>
                  </>
                ) : loadError !== null ? (
                  // Unread is not "not installed"; the banner says why.
                  <span className="text-muted-foreground">-</span>
                ) : (
                  <>
                    <XCircle className="h-3.5 w-3.5 text-red-500" />
                    <span className="text-red-600 dark:text-red-400 font-medium">
                      {t("gitNotFound")}
                    </span>
                  </>
                )}
                {gitInfo?.version && (
                  <span className="text-muted-foreground">
                    {gitInfo.version}
                  </span>
                )}
              </div>
              {!editingPath && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-xs"
                  onClick={() => setEditingPath(true)}
                  disabled={locked}
                >
                  {t("customGitPath")}
                </Button>
              )}
            </div>
            {gitInfo?.path && (
              <p className="text-muted-foreground">
                {t("gitPath")}: {gitInfo.path}
              </p>
            )}
          </div>

          {editingPath && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t("customGitPath")}
              </label>
              <div className="flex gap-2">
                <Input
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder={t("customGitPathPlaceholder")}
                  className="flex-1"
                  autoFocus
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelEdit}
                  disabled={savingGit}
                >
                  {t("removeCancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveGit}
                  disabled={savingGit || locked}
                >
                  {savingGit ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t("save")
                  )}
                </Button>
              </div>
              <p className="text-2xs text-muted-foreground">
                {t("customGitPathHint")}
              </p>
            </div>
          )}
        </section>

        {/* ---- Commit identity（#1419） ---- */}
        <GitIdentitySettings />

        {/* ---- Worktree location ---- */}
        <WorktreeLocationSettings />

        {/* ---- GitHub Accounts ---- */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Github className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("githubTitle")}</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-5">
            {t("githubDescription")}
          </p>

          {githubAccounts.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
              {emptyOrFailed(t("noAccounts"))}
            </div>
          ) : (
            <div className="space-y-2">
              {githubAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  testingId={testingAccountId}
                  onTest={handleTestConnection}
                  onRotate={setRotateTarget}
                  onSetDefault={handleSetDefault}
                  onRemove={setRemoveTarget}
                  t={t}
                />
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => setAddGitHubOpen(true)}
              disabled={locked}
            >
              {t("addAccount")}
            </Button>
          </div>
        </section>

        {/* ---- GitLab Accounts ---- */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Gitlab className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("gitlabTitle")}</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-5">
            {t("gitlabDescription")}
          </p>

          {gitlabAccounts.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
              {emptyOrFailed(t("gitlabNoAccounts"))}
            </div>
          ) : (
            <div className="space-y-2">
              {gitlabAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  testingId={testingAccountId}
                  onTest={handleTestConnection}
                  onRotate={setRotateTarget}
                  onSetDefault={handleSetDefault}
                  onRemove={setRemoveTarget}
                  t={t}
                />
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => setAddGitLabOpen(true)}
              disabled={locked}
            >
              {t("addAccount")}
            </Button>
          </div>
        </section>

        {/* ---- Gitea Accounts ---- */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <GitFork className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("giteaTitle")}</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-5">
            {t("giteaDescription")}
          </p>

          {giteaAccounts.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
              {emptyOrFailed(t("giteaNoAccounts"))}
            </div>
          ) : (
            <div className="space-y-2">
              {giteaAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  testingId={testingAccountId}
                  onTest={handleTestConnection}
                  onRotate={setRotateTarget}
                  onSetDefault={handleSetDefault}
                  onRemove={setRemoveTarget}
                  t={t}
                />
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => setAddGiteaOpen(true)}
              disabled={locked}
            >
              {t("addAccount")}
            </Button>
          </div>
        </section>

        {/* ---- CNB Accounts ---- */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("cnbTitle")}</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-5">
            {t("cnbDescription")}
          </p>

          {cnbAccounts.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
              {emptyOrFailed(t("cnbNoAccounts"))}
            </div>
          ) : (
            <div className="space-y-2">
              {cnbAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  testingId={testingAccountId}
                  onTest={handleTestConnection}
                  onRotate={setRotateTarget}
                  onSetDefault={handleSetDefault}
                  onRemove={setRemoveTarget}
                  t={t}
                />
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => setAddCnbOpen(true)}
              disabled={locked}
            >
              {t("addAccount")}
            </Button>
          </div>
        </section>

        {/* ---- Git Accounts (non-forge) ---- */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("gitAccount.sectionTitle")}
            </h2>
          </div>
          <p className="text-xs text-muted-foreground leading-5">
            {t("gitAccount.sectionDescription")}
          </p>

          {gitAccounts.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
              {emptyOrFailed(t("gitAccount.noAccounts"))}
            </div>
          ) : (
            <div className="space-y-2">
              {gitAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  testingId={testingAccountId}
                  onTest={handleTestConnection}
                  onSetDefault={handleSetDefault}
                  onRemove={setRemoveTarget}
                  t={t}
                />
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => setAddGitOpen(true)}
              disabled={locked}
            >
              {t("gitAccount.addAccount")}
            </Button>
          </div>
        </section>
      </div>

      {/* Dialogs */}
      <AddForgeAccountDialog
        provider="github"
        open={addGitHubOpen}
        onOpenChange={setAddGitHubOpen}
        onAccountAdded={handleAccountAdded}
        isFirstAccount={accounts.accounts.length === 0}
      />
      <AddForgeAccountDialog
        provider="gitlab"
        open={addGitLabOpen}
        onOpenChange={setAddGitLabOpen}
        onAccountAdded={handleAccountAdded}
        isFirstAccount={accounts.accounts.length === 0}
      />
      <AddForgeAccountDialog
        provider="gitea"
        open={addGiteaOpen}
        onOpenChange={setAddGiteaOpen}
        onAccountAdded={handleAccountAdded}
        isFirstAccount={accounts.accounts.length === 0}
      />
      <AddForgeAccountDialog
        provider="cnb"
        open={addCnbOpen}
        onOpenChange={setAddCnbOpen}
        onAccountAdded={handleAccountAdded}
        isFirstAccount={accounts.accounts.length === 0}
      />
      {rotateTarget && (
        <AddForgeAccountDialog
          key={rotateTarget.id}
          provider={providerOf(rotateTarget)}
          existing={rotateTarget}
          open
          onOpenChange={(open) => !open && setRotateTarget(null)}
          onAccountAdded={handleAccountAdded}
          isFirstAccount={false}
        />
      )}
      <AddGitAccountDialog
        open={addGitOpen}
        onOpenChange={setAddGitOpen}
        onAccountAdded={handleAccountAdded}
        isFirstAccount={accounts.accounts.length === 0}
      />

      {/* Remove Confirmation */}
      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeConfirmMessage", {
                username: removeTarget?.username ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("removeCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveAccount}>
              {t("removeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  )
}
