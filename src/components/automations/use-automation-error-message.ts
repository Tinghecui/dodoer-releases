"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"

/**
 * An automation API error in the user's language: the backend's i18n hint when
 * it sent one (keys in the `Automations` namespace — `cronErrorFieldCount`,
 * `cronErrorInvalidValue`, `cronErrorNeverFires`, see `app_error.rs`), else its
 * own message. Never `[object Object]`: a server-mode rejection is the parsed
 * error body, not an `Error`.
 */
export function useAutomationErrorMessage(): (error: unknown) => string {
  const t = useTranslations("Automations")
  return useCallback(
    (error: unknown) =>
      toLocalizedErrorMessage(error, t as unknown as AppErrorTranslator),
    [t]
  )
}
