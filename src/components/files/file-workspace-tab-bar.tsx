"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Reorder } from "motion/react"
import {
  Bot,
  FileText,
  GitCompare,
  Maximize2,
  Minimize2,
  Plus,
  ServerCog,
  X,
  Globe,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { AGENT_MARK } from "@/components/browser/browser-agent-access"
import { browserListServices } from "@/lib/browser/browser-api"
import { useBrowserTabState } from "@/lib/browser/browser-tab-store"
import {
  BLANK_PAGE_URL,
  displayHostPort,
  isBlankPageUrl,
} from "@/lib/browser/browser-url"
import type { DetectedService } from "@/lib/browser/types"
import { useBrowserCapabilities } from "@/lib/browser/use-browser-capabilities"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer"
import { useLongPressDrag } from "@/hooks/use-long-press-drag"
import { normalizeAbsPath } from "@/lib/file-open-target"
import { noteUserPickedFileTab } from "@/lib/files/file-tab-user-pick"
import { extractHtmlTitle } from "@/lib/html-preview-inline"
import { isHtmlPreviewable } from "@/lib/language-detect"
import { openFileDialog } from "@/lib/platform"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import { cn, handleMiddleClickClose } from "@/lib/utils"
import { STRIP_ICON_BTN } from "@/components/tabs/strip-icon-button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Rendered only inside the desktop file-column title strip. The old
// standalone mobile variant is gone — mobile shows the FileWorkspaceHeader
// (folder › file breadcrumb) instead and opens files from the file tree.
export function FileWorkspaceTabBar() {
  const t = useTranslations("Folder.fileWorkspace")
  const { mode, filesMaximized } = useWorkspaceView()
  const { fileTabs, activeFileTabId, previewFileTabIds } =
    useWorkspaceFileTabs()
  const {
    switchFileTab,
    closeFileTab,
    closeOtherFileTabs,
    closeAllFileTabs,
    reorderFileTabs,
    toggleFilesMaximized,
  } = useWorkspaceActions()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isCoarsePointer = useIsCoarsePointer()
  const [touchSortingTabId, setTouchSortingTabId] = useState<string | null>(
    null
  )

  useEffect(() => {
    if (!activeFileTabId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(
      `[data-file-tab-id="${activeFileTabId}"]`
    )
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeFileTabId])

  const handleReorder = useCallback(
    (nextTabs: FileWorkspaceTab[]) => {
      if (isCoarsePointer && !touchSortingTabId) return
      reorderFileTabs(nextTabs)
    },
    [isCoarsePointer, reorderFileTabs, touchSortingTabId]
  )

  const handleTouchSortingEnd = useCallback(
    () => setTouchSortingTabId(null),
    []
  )

  if (fileTabs.length === 0) return null

  return (
    <div className="flex h-full min-w-0 flex-1 items-center pl-2">
      <Reorder.Group
        as="div"
        ref={scrollRef}
        role="tablist"
        axis="x"
        values={fileTabs}
        onReorder={handleReorder}
        data-file-tabs-capsule
        className="flex h-8 min-w-0 items-center gap-0.5 overflow-hidden rounded-full bg-muted ws-surface-muted p-1"
      >
        {fileTabs.map((tab) => (
          <FileWorkspaceTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeFileTabId}
            previewing={previewFileTabIds.has(tab.id)}
            closeLabel={t("closeFileTab")}
            closeText={t("close")}
            closeOthersText={t("closeOthers")}
            closeAllText={t("closeAll")}
            isCoarsePointer={isCoarsePointer}
            isTouchSorting={touchSortingTabId === tab.id}
            onSwitch={switchFileTab}
            onClose={closeFileTab}
            onCloseOthers={closeOtherFileTabs}
            onCloseAll={closeAllFileTabs}
            onTouchSortingStart={setTouchSortingTabId}
            onTouchSortingEnd={handleTouchSortingEnd}
          />
        ))}
      </Reorder.Group>
      <FileTabAddMenu />
      <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
      {mode === "fusion" && (
        <button
          type="button"
          onClick={toggleFilesMaximized}
          className={cn(
            STRIP_ICON_BTN,
            "mr-1.5 self-center",
            filesMaximized && "text-primary"
          )}
          aria-label={filesMaximized ? t("restore") : t("maximize")}
          aria-pressed={filesMaximized}
          title={filesMaximized ? t("restore") : t("maximize")}
        >
          {filesMaximized ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </div>
  )
}

/**
 * The "+" at the end of the file tab strip: the tabs a person can add to this
 * strip by hand.
 *
 * All of them already exist elsewhere, but none is reachable *from here*. A
 * file otherwise arrives from the aux-panel file tree or a transcript badge —
 * both of which can be closed or absent — and a browser tab had no manual
 * entry point at all: every one of them arrived by following a link, so there
 * was no way to simply open a page. The blank page is exactly that (see
 * `BLANK_PAGE_URL`): an empty tab with a focused address bar.
 *
 * The local servers below them are the ones codeg has watched start in its
 * terminals (`browser::services`), listed fresh every time the menu opens:
 * the backend connects to each one while answering, so an address here is an
 * address that was answering a moment ago. This is the entry point for
 * everyone who left the notification off, and the way back to a page that was
 * offered and dismissed.
 *
 * Renders nothing when no row is possible rather than an empty menu — off the
 * desktop there is no built-in browser, and a native picker is no use to a
 * window driving a remote backend.
 */
function FileTabAddMenu() {
  const t = useTranslations("Folder.fileWorkspace")
  const { openFilePreview, openBrowserTab } = useWorkspaceActions()
  const capabilities = useBrowserCapabilities()
  const [services, setServices] = useState<readonly DetectedService[]>([])

  // A native dialog picks a path on THIS machine; a desktop window driving a
  // remote backend would hand the server a path it cannot read, and the web
  // fallback only ever learns a bare file name (same test as add-node-menu).
  const canOpenFile = isDesktop() && !isRemoteDesktopMode()
  // Web mode answers "unavailable" without a round trip, so this is false
  // there from the first render rather than after a flash.
  const canOpenBrowser = capabilities?.available ?? false

  const handleOpenFile = useCallback(async () => {
    const picked = await openFileDialog({ title: t("openFileTitle") }).catch(
      () => null
    )
    const path = Array.isArray(picked) ? picked[0] : picked
    // `openFilePreview` reports a failed read on the tab itself, so a
    // rejection here is only ever the dialog being dismissed.
    if (path) void openFilePreview(normalizeAbsPath(path))
  }, [openFilePreview, t])

  // Asked on every open, not held: a server that has stopped must not be
  // offered, and the backend's answer already excludes those. The previous
  // answer stays on screen until the new one lands (they are the same list
  // in the overwhelming majority of cases) and an error empties it rather
  // than showing addresses nobody vouched for.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      // The servers this computer's terminals started. A window bound to a
      // remote codeg-server runs its terminals there, so none of these is
      // one of its own — and `localhost` in its list would be ambiguous.
      if (!open || !canOpenBrowser || isRemoteDesktopMode()) return
      void browserListServices()
        .then(setServices)
        .catch(() => setServices([]))
    },
    [canOpenBrowser]
  )

  if (!canOpenFile && !canOpenBrowser) return null

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(STRIP_ICON_BTN, "ml-1.5 mr-0.5 self-center")}
          aria-label={t("newTab")}
          title={t("newTab")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        {canOpenBrowser && (
          <DropdownMenuItem
            onSelect={() => {
              openBrowserTab(BLANK_PAGE_URL)
            }}
          >
            <Globe />
            {t("newBrowserTab")}
          </DropdownMenuItem>
        )}
        {canOpenFile && (
          <DropdownMenuItem onSelect={() => void handleOpenFile()}>
            <FileText />
            {t("openFile")}
          </DropdownMenuItem>
        )}
        {canOpenBrowser && services.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("localServices")}</DropdownMenuLabel>
            {services.map((service) => (
              <DropdownMenuItem
                key={service.origin}
                onSelect={() => {
                  openBrowserTab(service.url)
                }}
              >
                <ServerCog />
                <span className="min-w-0 flex-1 truncate">
                  {displayHostPort(service.url) ?? service.url}
                </span>
                {service.source === "agent" && (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {t("localServiceFromAgent")}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface FileWorkspaceTabItemProps {
  tab: FileWorkspaceTab
  active: boolean
  /** The tab is showing the rendered document rather than its source — what
   *  lets an HTML tab be named by the page instead of by the file. */
  previewing: boolean
  closeLabel: string
  closeText: string
  closeOthersText: string
  closeAllText: string
  isCoarsePointer: boolean
  isTouchSorting: boolean
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseAll: () => void
  onTouchSortingStart: (tabId: string) => void
  onTouchSortingEnd: () => void
}

const FileWorkspaceTabItem = memo(function FileWorkspaceTabItem({
  tab,
  active,
  previewing,
  closeLabel,
  closeText,
  closeOthersText,
  closeAllText,
  isCoarsePointer,
  isTouchSorting,
  onSwitch,
  onClose,
  onCloseOthers,
  onCloseAll,
  onTouchSortingStart,
  onTouchSortingEnd,
}: FileWorkspaceTabItemProps) {
  const tAgent = useTranslations("Browser.agent")
  const tBrowserTab = useTranslations("Browser.tab")
  const isDiff = tab.kind === "diff" || tab.kind === "rich-diff"
  const isBrowser = tab.kind === "browser"
  const isDirty = tab.kind === "file" && Boolean(tab.isDirty)
  // A browser tab's title follows the page (document.title); the record only
  // knows the host it was opened with.
  const browserState = useBrowserTabState(isBrowser ? tab.id : null)
  // No live state = no page behind the tab yet: restored from a previous run
  // or unloaded in the background; it loads when switched to. Drawn faded,
  // the way browsers draw a discarded tab.
  const unloaded = isBrowser && !browserState
  const browserUrl = isBrowser
    ? browserState?.url || tab.browser.initialUrl
    : null
  // An empty tab names itself ("New tab") and has no address worth showing:
  // `about:blank` is the absence of a page, not one the user navigated to.
  const blankPage = browserUrl !== null && isBlankPageUrl(browserUrl)
  // What to call it, most specific first: the live page's own title, then the
  // record's. Except that a tab opened empty took `about:blank` for its
  // record title — a record is named once, and the address had no host to
  // offer for the blank page — so the moment it goes somewhere, that title
  // names the wrong page. The host stands in until the page says its own,
  // which also covers the stretch of every navigation where the backend has
  // cleared the live title and `title_changed` has not fired yet.
  const recordTitle = isBlankPageUrl(tab.title) ? null : tab.title
  // Host and port, the same answer the record is named with, so a page that
  // loses its title mid-navigation does not also change what it is called.
  const browserHost = browserUrl ? displayHostPort(browserUrl) : null
  // An HTML file being previewed is named the way a browser names a page: by
  // the document's own <title>, the file name behind it on hover. Read from
  // the tab's source rather than from the rendered document, so it is the same
  // answer for both renderers (inline iframe / document guest), it is there
  // before anything loads, and a background tab has it too. Empty (no <title>
  // element, or the tab is showing source) = the file name, as before.
  const htmlTitle = useMemo(
    () =>
      previewing && tab.kind === "file" && isHtmlPreviewable(tab.path)
        ? extractHtmlTitle(tab.content ?? "")
        : "",
    [previewing, tab.content, tab.kind, tab.path]
  )
  const displayTitle = isBrowser
    ? browserState?.title ||
      (blankPage
        ? tBrowserTab("untitled")
        : (recordTitle ?? browserHost ?? tab.title))
    : htmlTitle || tab.title
  const sharedWith = browserState?.agentGrant?.origin ?? null
  // A browser tab is the one kind whose label is always truncated (a page
  // title is a sentence, not a filename) AND whose address is not shown
  // anywhere in the strip, so hovering gives both — title first, then the
  // address it is on, one per line. A previewed HTML file is in the same
  // position and gets the same two lines, its path standing in for the address.
  const displayHint = isBrowser
    ? [
        displayTitle,
        blankPage ? null : browserUrl,
        sharedWith && tAgent("shared"),
      ]
        .filter(Boolean)
        .join("\n")
    : htmlTitle
      ? [htmlTitle, tab.description ?? tab.path].filter(Boolean).join("\n")
      : (tab.description ?? tab.title)

  // 点、拖都告诉文件标签的持久化「用户选过它」：点的是已经选中的标签时选中项不变，
  // 它从标签栏的变化里看不出来，刷新后恢复到一半时会又选回刷新前的那个。
  const handleLongPressStart = useCallback(() => {
    noteUserPickedFileTab(tab.id)
    onTouchSortingStart(tab.id)
  }, [onTouchSortingStart, tab.id])

  const { dragControls, gestureHandlers } = useLongPressDrag({
    enabled: isCoarsePointer,
    onStart: handleLongPressStart,
    onEnd: onTouchSortingEnd,
  })

  const handleSwitch = useCallback(() => {
    noteUserPickedFileTab(tab.id)
    onSwitch(tab.id)
  }, [onSwitch, tab.id])

  // 拖动开始：先告诉持久化，再交给长按拖动的手势（拖完松手的那一下点击靠它吞掉）。
  const gestureDragStart = gestureHandlers.onDragStart
  const handleDragStart = useCallback(() => {
    noteUserPickedFileTab(tab.id)
    gestureDragStart()
  }, [gestureDragStart, tab.id])

  const whileDrag = useMemo(() => ({ scale: 1.03 }), [])

  return (
    <Reorder.Item
      as="div"
      value={tab}
      data-file-tab-id={tab.id}
      drag="x"
      dragControls={dragControls}
      dragListener={!isCoarsePointer}
      whileDrag={whileDrag}
      {...gestureHandlers}
      onDragStart={handleDragStart}
      data-tab-item
      data-active={active ? "true" : undefined}
      className={cn(
        "min-w-0 max-w-48 shrink cursor-grab active:cursor-grabbing",
        isTouchSorting &&
          "z-50 rounded-full opacity-90 shadow-md ring-1 ring-primary/25"
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={isTouchSorting}>
          <div
            role="tab"
            aria-selected={active}
            onClick={handleSwitch}
            onMouseDown={(event) =>
              handleMiddleClickClose(event, () => onClose(tab.id))
            }
            className={cn(
              "group/filetab flex h-6 min-w-0 items-center gap-1.5 rounded-full pl-2.5 pr-1 text-xs",
              "cursor-pointer select-none transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            )}
            title={displayHint}
          >
            {isBrowser && sharedWith ? (
              // A shared tab says so from the strip, not only from inside
              // itself: the page an agent is reading is often not the one the
              // user is looking at. Replaces the globe rather than joining it
              // — "an agent can read this" is the fact worth a glyph here,
              // and the title and address already say it is a web page.
              <Bot
                className={cn("h-3.5 w-3.5 shrink-0", AGENT_MARK)}
                data-agent-shared={sharedWith}
              />
            ) : isBrowser ? (
              <Globe
                className={cn("h-3.5 w-3.5 shrink-0", unloaded && "opacity-50")}
                data-unloaded={unloaded ? "true" : undefined}
              />
            ) : isDiff ? (
              <GitCompare className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                unloaded && "opacity-60"
              )}
            >
              {displayTitle}
              {isDirty ? " *" : ""}
            </span>
            <button
              type="button"
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10",
                active
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover/filetab:pointer-events-auto group-hover/filetab:opacity-100"
              )}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
              aria-label={closeLabel}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onClose(tab.id)}>
            {closeText}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCloseOthers(tab.id)}>
            {closeOthersText}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onCloseAll}>
            {closeAllText}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Reorder.Item>
  )
})
