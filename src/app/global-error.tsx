"use client"

// Cowork fork: what a render crash shows instead of a blank page, for every
// user; with telemetry on it is also reported (docs/telemetry.md §5.3). It
// replaces the root layout, so there are no providers here: no i18n, no
// theme — plain text in the browser's language, Chinese or English.

import { useEffect } from "react"
import { reportError } from "@/lib/telemetry"

function isChinese(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("zh")
  )
}

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    reportError(error, { boundary: "global", digest: error.digest })
  }, [error])
  const zh = isChinese()
  return (
    <html lang={zh ? "zh-CN" : "en"}>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#09090b",
          color: "#fafafa",
        }}
      >
        <main style={{ textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>
            {zh ? "页面出错了" : "Something went wrong"}
          </h1>
          <p style={{ margin: "0 0 20px", opacity: 0.7 }}>
            {zh
              ? "刷新一下通常就好。对话和项目都还在。"
              : "Reloading usually fixes it. Your conversations and projects are safe."}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "1px solid #3f3f46",
              background: "#fafafa",
              color: "#09090b",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {zh ? "刷新" : "Reload"}
          </button>
        </main>
      </body>
    </html>
  )
}
