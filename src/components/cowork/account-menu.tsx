"use client"

import { ArrowUpCircle, LogOut, MonitorDown, UserRound } from "lucide-react"
import { toast } from "sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import {
  coworkCanOpenInDesktop,
  coworkCanSignOut,
  coworkSignOut,
  openCoworkAccount,
  openCoworkInDesktop,
} from "@/lib/cowork/account"
import { useCoworkText } from "@/lib/cowork/i18n"
import { useCoworkInfo } from "@/lib/cowork/info"
import { openCoworkUpgrade, useCoworkUpgradeHint } from "@/lib/cowork/upgrade"
import { cn } from "@/lib/utils"

/**
 * Account menu, shown only when served behind the Cowork portal. On desktop
 * widths it is the last button of the fixed top-right chrome (RightEdgeChrome,
 * which passes its button classes in), so it stays put whether the aux panel
 * is open or not; on mobile it ends the status bar.
 * The entries are full-page navigations to same-origin paths that Cowork's
 * nginx redirects to the portal. An admin with a newer cowork release waiting
 * also gets an "upgrade" entry (and a dot on the trigger) that opens the
 * portal's version page; the upgrade itself happens there.
 *
 * In the browser it also offers "Open in desktop app" (a one-time
 * `codeg://cowork/connect` link from the portal).
 *
 * In a desktop window bound to a remote Cowork workspace the menu keeps only
 * "My account" (opened in the system browser): the upgrade hint and sign-out
 * both ride on the portal session cookie, which the desktop app doesn't have.
 */
export function CoworkAccountMenu({
  className,
  iconClassName,
  side = "top",
}: {
  className?: string
  iconClassName?: string
  /** Which way the menu opens: up from the status bar, down from the top chrome. */
  side?: "top" | "bottom"
} = {}) {
  const info = useCoworkInfo()
  const t = useCoworkText()
  const session = coworkCanSignOut()
  const upgrade = useCoworkUpgradeHint(info?.portal === true && session)
  if (!info?.portal) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("relative h-6 w-6 hover:text-foreground/80", className)}
          title={t("account")}
          aria-label={t("account")}
        >
          <UserRound className={cn("h-3.5 w-3.5", iconClassName)} />
          {upgrade && (
            <span
              data-testid="cowork-upgrade-dot"
              className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} className="min-w-52">
        {upgrade && (
          <>
            <DropdownMenuItem
              disabled={!upgrade.url}
              onSelect={() => openCoworkUpgrade(upgrade)}
            >
              <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
              {t("upgradeAvailable", { version: upgrade.latest })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {coworkCanOpenInDesktop() && (
          <DropdownMenuItem
            onSelect={() => {
              openCoworkInDesktop().catch((err: unknown) => {
                toast.error(
                  t("openInDesktopFailed", {
                    message: err instanceof Error ? err.message : String(err),
                  })
                )
              })
            }}
          >
            <MonitorDown className="h-3.5 w-3.5 shrink-0" />
            {t("openInDesktop")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => openCoworkAccount()}>
          <UserRound className="h-3.5 w-3.5 shrink-0" />
          {t("myAccount")}
        </DropdownMenuItem>
        {session && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => coworkSignOut()}>
              <LogOut className="h-3.5 w-3.5 shrink-0" />
              {t("signOut")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
