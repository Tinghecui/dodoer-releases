"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { isDesktop } from "@/lib/platform"
import {
  codegAuthHeaders,
  probeProxyAuthentication,
  unauthorizedSource,
} from "@/lib/transport/web-auth"
import {
  lastPortalBounce,
  probeCoworkSso,
  sendToPortalLogin,
  ssoFallback,
} from "@/lib/cowork/sso"
import { COWORK_ACCOUNT_URL } from "@/lib/cowork/account"
import { COWORK_BUILD } from "@/lib/cowork/brand"
import { useCoworkText } from "@/lib/cowork/i18n"
import { takeLinkToken } from "@/lib/cowork/token-link"

type TokenCheck =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "proxy" }
  | { kind: "status"; status: number }
  | { kind: "network" }

// Validate a token by calling a lightweight API endpoint.
async function checkToken(token: string): Promise<TokenCheck> {
  try {
    const res = await fetch("/api/health", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...codegAuthHeaders(token),
      },
      body: "{}",
    })
    if (res.ok) return { kind: "ok" }
    if (res.status === 401) {
      // A proxy in front of Codeg may refuse before the token is checked.
      return unauthorizedSource(res.headers.get("www-authenticate")) === "proxy"
        ? { kind: "proxy" }
        : { kind: "invalid" }
    }
    return { kind: "status", status: res.status }
  } catch {
    return { kind: "network" }
  }
}

export default function LoginPage() {
  const router = useRouter()
  const t = useTranslations("LoginPage")
  const tConnection = useTranslations("WebConnection")
  const ct = useCoworkText()
  const [token, setToken] = useState("")
  const [failure, setFailure] = useState<TokenCheck | null>(null)
  const [loading, setLoading] = useState(false)
  // Cowork fork: the token of a sign-in link (`/login?token=<value>`, #74),
  // read once — the address no longer carries it afterwards. undefined = not
  // read yet; kept in a ref so a re-run effect (Strict Mode) still has it.
  const linkToken = useRef<string | null | undefined>(undefined)

  // Cowork portal SSO: hold the form back until the credential-less probe has
  // answered, so a proxied session never flashes the token prompt. An
  // upstream-named build shows the form right away, as upstream does.
  const [ssoChecking, setSsoChecking] = useState(
    () => !isDesktop() && COWORK_BUILD
  )

  useEffect(() => {
    document.title = t("documentTitle")
  }, [t])

  useEffect(() => {
    if (isDesktop()) return
    let cancelled = false
    if (linkToken.current === undefined) linkToken.current = takeLinkToken()
    const fromLink = linkToken.current
    if (fromLink) {
      // An explicit sign-in link wins over the SSO / proxy probes: check its
      // token right away, with the form on screen saying so, and leave it in
      // the form with the reason should it be rejected.
      setToken(fromLink)
      setSsoChecking(false)
      setLoading(true)
      void checkToken(fromLink).then((result) => {
        if (cancelled) return
        linkToken.current = null
        setLoading(false)
        if (result.kind === "ok") {
          localStorage.setItem("codeg_token", fromLink)
          router.replace("/workspace")
        } else {
          setFailure(result)
        }
      })
      return () => {
        cancelled = true
      }
    }
    if (!COWORK_BUILD) {
      // Signed in through a proxy in front of Codeg (CODEG_AUTH=proxy-jwt),
      // there is no token to ask for.
      void probeProxyAuthentication().then((result) => {
        if (!cancelled && result === "proxy") router.replace("/workspace")
      })
      return () => {
        cancelled = true
      }
    }
    void probeCoworkSso().then((probe) => {
      if (cancelled) return
      if (probe === "ok") {
        router.replace("/workspace")
        return
      }
      // Cowork users have no access token to type: an expired / missing
      // portal session goes back to the portal (keeps the form hidden).
      const next = ssoFallback(probe, {
        coworkBuild: COWORK_BUILD,
        manualToken: new URLSearchParams(window.location.search).has("token"),
        lastBounce: lastPortalBounce(),
        now: Date.now(),
      })
      if (next === "portal") sendToPortalLogin(COWORK_ACCOUNT_URL)
      else setSsoChecking(false)
    })
    return () => {
      cancelled = true
    }
  }, [router])

  // Desktop users skip login entirely
  if (isDesktop()) {
    router.replace("/workspace")
    return null
  }

  if (ssoChecking) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFailure(null)
    setLoading(true)
    const result = await checkToken(token)
    setLoading(false)
    if (result.kind === "ok") {
      localStorage.setItem("codeg_token", token)
      router.replace("/workspace")
    } else {
      setFailure(result)
    }
  }

  const error =
    failure?.kind === "proxy"
      ? tConnection("proxySignInDescription")
      : failure?.kind === "invalid"
        ? t("invalidToken")
        : failure?.kind === "status"
          ? t("connectionFailed", { status: failure.status })
          : failure?.kind === "network"
            ? t("networkError")
            : ""

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">{t("brand")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("tokenPlaceholder")}
              autoFocus
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={!token || loading}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {loading ? t("connecting") : t("connect")}
          </button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          {t("helpText")}
        </p>

        {COWORK_BUILD && (
          <p className="text-center text-sm">
            <a
              href={COWORK_ACCOUNT_URL}
              className="text-primary underline-offset-4 hover:underline"
            >
              {ct("portalSignIn")}
            </a>
          </p>
        )}
      </div>
    </div>
  )
}
