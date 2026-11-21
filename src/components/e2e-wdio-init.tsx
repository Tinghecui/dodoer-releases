"use client"

import { useEffect } from "react"
import { loadWdioTauriPlugin } from "@/lib/e2e/wdio-plugin"

/**
 * Loads the WebdriverIO plugin's frontend half in e2e test builds; a no-op
 * (and no plugin code in the bundle) everywhere else. See
 * `@/lib/e2e/wdio-plugin`.
 */
export function E2eWdioInit() {
  useEffect(() => {
    void loadWdioTauriPlugin()?.catch((e) =>
      console.error("[e2e] @wdio/tauri-plugin failed to load", e)
    )
  }, [])
  return null
}
