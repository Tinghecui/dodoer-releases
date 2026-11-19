"use client"

import { useEffect } from "react"
import { toast } from "sonner"
import { useCoworkText } from "@/lib/cowork/i18n"
import { takeLinkTokenIgnored } from "@/lib/cowork/token-link"

/**
 * #873: in the workspace, says once that the sign-in link just opened was not
 * used — the portal session was already valid, so the stored credential was
 * kept (`noteLinkTokenIgnored` on the login page). Renders nothing.
 */
export function LinkTokenNotice() {
  const t = useCoworkText()

  // The note is used up on the first read: a re-run (language change) stays
  // quiet.
  useEffect(() => {
    if (takeLinkTokenIgnored()) toast.info(t("linkTokenIgnored"))
  }, [t])

  return null
}
