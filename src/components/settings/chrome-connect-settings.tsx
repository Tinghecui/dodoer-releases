"use client"

/**
 * The "Chrome" card of `/settings/browser`: connecting the app to the Chrome
 * the person uses every day (`docs/agent-chrome.md`).
 *
 * The connection is the person's to make, twice over — they turn a switch on
 * in Chrome, and Chrome asks them about each connection — so the card is
 * mostly instructions: what to do in Chrome, and, for each way a connection
 * can fail, what that failure is asking them to do next. The backend never
 * connects on its own, so a state that names a problem stays until the
 * button is pressed again.
 *
 * Desktop only, like the rest of the browser engine's settings; the page
 * decides that, not this card.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Chrome, ClipboardPaste } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toErrorMessage } from "@/lib/app-error"
import {
  CHROME_SWITCH_URL,
  chromeConnect,
  chromeDisconnect,
  chromeOpenPrivacySettings,
  chromeStatus,
  subscribeChromeStatus,
  type ChromeProblem,
  type ChromeStatus,
} from "@/lib/browser/chrome-api"
import { copyTextToClipboard } from "@/lib/utils"

// Literal message keys per problem — next-intl only resolves literal keys.
const PROBLEM_KEYS = {
  "switch-off": "problemSwitchOff",
  "file-denied": "problemFileDenied",
  "file-unreadable": "problemFileUnreadable",
  "bad-endpoint": "problemBadEndpoint",
  "not-running": "problemNotRunning",
  rejected: "problemRejected",
  "timed-out": "problemTimedOut",
  lost: "problemLost",
} as const satisfies Record<ChromeProblem, string>

/** The problems whose way out is an endpoint the person copies by hand:
 *  the app could not read where Chrome listens, or what they pasted last
 *  time was not it. */
const NEEDS_PASTE: ReadonlySet<ChromeProblem> = new Set([
  "file-denied",
  "file-unreadable",
  "bad-endpoint",
])

export function ChromeConnectSettings() {
  const t = useTranslations("ChromeSettings")
  const [status, setStatus] = useState<ChromeStatus | null>(null)
  const [pasted, setPasted] = useState("")
  // Once the paste row has been needed it stays for as long as the page is
  // open: a later failure of another kind (Chrome not running) is still one
  // the person will answer by pasting again.
  const [pasting, setPasting] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    // An event is newer than the answer to a question asked before it.
    let heard = false
    void subscribeChromeStatus((next) => {
      heard = true
      if (!cancelled) setStatus(next)
    })
      .then((off) => {
        if (cancelled) off()
        else unsubscribe = off
      })
      .catch(() => {})
    chromeStatus()
      .then((current) => {
        if (!cancelled && !heard) setStatus(current)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const state = status?.state ?? "disconnected"
  const problem = status?.problem ?? null
  const portFileUrl = status?.portFileUrl ?? null

  const run = async (action: () => Promise<ChromeStatus>) => {
    try {
      const next = await action()
      setStatus(next)
      if (next.problem && NEEDS_PASTE.has(next.problem)) setPasting(true)
    } catch (error) {
      toast.error(t("failed", { message: toErrorMessage(error) }))
    }
  }

  const copy = async (text: string) => {
    if (await copyTextToClipboard(text)) toast.success(t("copied"))
    else toast.error(t("copyFailed"))
  }

  const statusLine =
    state === "connected"
      ? status?.product
        ? t("statusConnectedTo", { product: status.product })
        : t("statusConnected")
      : state === "waiting"
        ? t("statusWaiting")
        : t("statusDisconnected")

  return (
    <SettingCard>
      <SettingRow
        icon={Chrome}
        title={t("title")}
        description={t("description")}
        control={
          state === "connected" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="bg-background"
              onClick={() => void run(chromeDisconnect)}
            >
              {t("disconnect")}
            </Button>
          ) : state === "waiting" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="bg-background"
              onClick={() => void run(chromeDisconnect)}
            >
              {t("cancel")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void run(() => chromeConnect())}
            >
              {t("connect")}
            </Button>
          )
        }
      >
        <div className="space-y-2 text-xs leading-5 text-muted-foreground">
          <p role="status" className="font-medium text-foreground">
            {statusLine}
          </p>
          {problem ? (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-foreground">
              <p>{t(PROBLEM_KEYS[problem])}</p>
              {problem === "file-denied" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="bg-background"
                  onClick={() =>
                    void chromeOpenPrivacySettings().catch((error) =>
                      toast.error(
                        t("failed", { message: toErrorMessage(error) })
                      )
                    )
                  }
                >
                  {t("openSystemSettings")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {state === "connected" ? null : (
            <>
              <ol className="list-decimal space-y-1 pl-4">
                <li>
                  {t("stepSwitch", { url: CHROME_SWITCH_URL })}{" "}
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="bg-background"
                    onClick={() => void copy(CHROME_SWITCH_URL)}
                  >
                    {t("copySwitchUrl")}
                  </Button>
                </li>
                <li>{t("stepConnect")}</li>
              </ol>
              <p>{t("otherPrograms")}</p>
            </>
          )}
        </div>
      </SettingRow>
      {pasting && state !== "connected" ? (
        <SettingRow
          icon={ClipboardPaste}
          title={t("pasteTitle")}
          description={t("pasteHint")}
          htmlFor="chrome-endpoint"
        >
          {portFileUrl ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-border/70 bg-background px-3 py-2 text-xs">
                {portFileUrl}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="bg-background"
                onClick={() => void copy(portFileUrl)}
              >
                {t("copyFileUrl")}
              </Button>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Input
              id="chrome-endpoint"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="/devtools/browser/…"
              className="min-w-0 flex-1 bg-background text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              type="button"
              size="sm"
              disabled={!pasted.trim() || state === "waiting"}
              onClick={() => void run(() => chromeConnect(pasted))}
            >
              {t("pasteConnect")}
            </Button>
          </div>
        </SettingRow>
      ) : null}
    </SettingCard>
  )
}
