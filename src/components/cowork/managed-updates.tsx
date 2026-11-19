"use client"

import type { ComponentProps } from "react"

import type { CoworkInfo } from "@/lib/cowork/info"
import { usesTauriUpdater } from "@/lib/updater"

/**
 * Whether software updates are someone else's to manage in this window: the
 * administrator upgrades a Cowork server (`CODEG_UPDATE_DISABLED`, see
 * COWORK.md), so in a browser there is no update to check for or install and
 * no version of the visitor's to show. The same rule as the provider's
 * background check (`update-provider.tsx`): a desktop window, remote or not,
 * updates the desktop app itself and is never managed.
 */
export function updatesAreManaged(info: CoworkInfo | null): boolean {
  return !usesTauriUpdater() && info?.updateDisabled === true
}

/**
 * Like `updatesAreManaged`, but an unread `cowork_info` (`loaded` false: the
 * server is restarting, a proxy answered 500, …) also counts as managed for
 * now — the same rule as the provider's background check. So the System page
 * neither checks on load nor shows the update section until the server has
 * said whether Cowork pins the version; a Cowork server would refuse the
 * check with a 403 and the page would show an update error.
 */
export function updatesMayBeManaged(
  info: CoworkInfo | null,
  loaded: boolean
): boolean {
  if (usesTauriUpdater()) return false
  return !loaded || info?.updateDisabled === true
}

/**
 * The System page's software-update `<section>`, left out entirely (version
 * label included) where updates are managed. It takes the section's own props
 * so the upstream markup inside it stays exactly as it is.
 */
export function SoftwareUpdateSection({
  managed,
  ...section
}: ComponentProps<"section"> & { managed: boolean }) {
  return managed ? null : <section {...section} />
}
