"use client"

import { Loader2 } from "lucide-react"
import { PRODUCT_NAME } from "@/lib/cowork/brand"

// Shown by `AppI18nProvider` while the language settings and the locale's
// messages load, so it cannot use translations: the name comes straight from
// the brand constant (Cowork in a Cowork build, dodoer otherwise).
export function AppBootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="flex items-center gap-3 px-2 py-1">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-sm font-medium tracking-tight">
          {PRODUCT_NAME}
        </span>
      </div>
    </div>
  )
}
