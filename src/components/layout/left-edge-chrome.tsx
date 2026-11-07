"use client"

import { PanelLeft, Search } from "lucide-react"
import { useTranslations } from "next-intl"
import { isDesktop } from "@/lib/platform"
import { Button } from "@/components/ui/button"
import { useSearchDialog } from "@/contexts/search-dialog-context"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useIsMac } from "@/hooks/use-is-mac"
import { usePlatform } from "@/hooks/use-platform"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useZoomLevel } from "@/hooks/use-appearance"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { GLASS_RAISED_CARD_CLASS, Glass } from "@/components/ui/glass"
import { cn } from "@/lib/utils"
import {
  MAC_TRAFFIC_LIGHT_INSET,
  NO_LIGHTS_LEAD,
  leftCapsuleLeft,
  leftChromeButtonsWidth,
} from "@/lib/window-chrome"

/**
 * Contents of the window's fixed top-LEFT chrome overlay: the sidebar toggle +
 * search. `FolderLayoutShell` pins this at the window's top-left corner so it
 * never moves — or re-mounts — when the sidebar opens or closes (that
 * re-parenting is what made the old in-header cluster flicker).
 *
 * A leading spacer clears the native macOS traffic lights. The overlay ends
 * where its buttons do (`leftChromeButtonsWidth`); the window's left-edge
 * column still reserves the wider `leftChromeReserve`, so tabs never render
 * underneath and the reserve's drag region keeps the space after search moving
 * the window. jenny fork: the overlay used to span that tail too, which sat on
 * top of the open sidebar's bell now that the bell follows search directly.
 *
 * Search sits here — rather than in the sidebar, where it used to be a fixed
 * nav row — precisely because this overlay never unmounts: the sidebar does,
 * which left ⌘K as the only path to it while collapsed. The slot it took over
 * belonged to the remote-workspace picker, a far rarer action that moved to the
 * sidebar list's context menu and the status bar's quick actions.
 *
 * "Open folder" and "summon pet" were intentionally dropped from here — Open
 * Folder / Clone remain reachable from the sidebar list's hover / empty-state
 * actions and ⌘O; the pet stays reachable from Settings › Appearance.
 */
export function LeftEdgeChrome() {
  const tTitleBar = useTranslations("Folder.folderTitleBar")
  const { isOpen, toggle } = useSidebarContext()
  const { setOpen: setSearchOpen } = useSearchDialog()
  const isMac = useIsMac()
  const { shortcuts } = useShortcutSettings()
  const { isMac: platformIsMac } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  // The traffic lights only exist on the macOS desktop runtime (not web / not
  // Windows-Linux), so only reserve their inset there.
  const showMacInset = platformIsMac && isDesktop()

  // Open, the buttons are the sidebar header's 24px head buttons; on the
  // collapsed capsule they stay 28px.
  const buttonClass = isOpen ? SIDEBAR_HEAD_ICON_BUTTON : GLASS_ICON_BUTTON
  const buttons = (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={buttonClass}
        onClick={toggle}
        title={tTitleBar("withShortcut", {
          label: tTitleBar(isOpen ? "hideSidebar" : "showSidebar"),
          shortcut: formatShortcutLabel(shortcuts.toggle_sidebar, isMac),
        })}
      >
        <PanelLeft className="h-[0.9375rem] w-[0.9375rem]" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={buttonClass}
        onClick={() => setSearchOpen(true)}
        title={tTitleBar("withShortcut", {
          label: tTitleBar("search"),
          shortcut: formatShortcutLabel(shortcuts.toggle_search, isMac),
        })}
        aria-label={tTitleBar("search")}
      >
        <Search aria-hidden="true" className="h-[0.9375rem] w-[0.9375rem]" />
      </Button>
    </>
  )

  if (!isOpen) {
    // Collapsed (⌘B): the two buttons become a small glass capsule right of
    // the traffic lights, centred on the lights' line (erratum E5), so they
    // stay one click away. The space before it moves the window.
    const left = leftCapsuleLeft(showMacInset, zoomLevel)
    return (
      <div className="relative" style={{ width: left }}>
        <div
          data-tauri-drag-region
          className="absolute top-0 left-0 h-[3.875rem]"
          style={{ width: left }}
        />
        <Glass
          interactive
          data-left-chrome-capsule=""
          className={cn(
            GLASS_RAISED_CARD_CLASS,
            "absolute top-[0.9375rem] flex h-8 w-[4.5rem] items-center justify-center gap-0 rounded-full"
          )}
          style={{ left }}
        >
          {buttons}
        </Glass>
      </div>
    )
  }

  // Open: the buttons sit straight on the sidebar pane's header (glass never
  // nests, so they are plain icon buttons), right after the traffic lights.
  return (
    <div
      className="flex h-[2.875rem] items-center"
      style={{
        marginTop: "0.5rem",
        width: leftChromeButtonsWidth(showMacInset, zoomLevel),
      }}
    >
      <div
        data-tauri-drag-region
        className="h-full shrink-0"
        style={{
          width: showMacInset
            ? MAC_TRAFFIC_LIGHT_INSET
            : Math.round((NO_LIGHTS_LEAD * zoomLevel) / 100),
        }}
      />
      <div className="flex items-center gap-0.5 pl-2">{buttons}</div>
    </div>
  )
}

/** Icon button on glass: 28px circle, gray hover (not another glass). */
const GLASS_ICON_BUTTON =
  "lg-ib h-7 w-7 rounded-full text-[var(--ink2)] hover:bg-[var(--g-hover)] hover:text-foreground dark:hover:bg-[var(--g-hover)]"

/** The same on the open sidebar's header: a 24px circle (SIDEBAR_HEAD_BUTTON_SIZE). */
const SIDEBAR_HEAD_ICON_BUTTON =
  "lg-ib h-6 w-6 rounded-full text-[var(--ink2)] hover:bg-[var(--g-hover)] hover:text-foreground dark:hover:bg-[var(--g-hover)]"
