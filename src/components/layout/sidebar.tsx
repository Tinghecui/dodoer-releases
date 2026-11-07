"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  ListChevronsDownUp,
  ListChevronsUpDown,
  LayoutTemplate,
  ListTodo,
  Map as MapIcon,
  Menu,
  MessagesSquare,
  SquarePen,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useTabActions } from "@/contexts/tab-context"
import { useAutomationsView } from "@/contexts/automations-view-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  SidebarConversationList,
  type SidebarConversationListHandle,
} from "@/components/conversations/sidebar-conversation-list"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useIsMobile } from "@/hooks/use-mobile"
import { useIsMac } from "@/hooks/use-is-mac"
import { usePlatform } from "@/hooks/use-platform"
import { useZoomLevel } from "@/hooks/use-appearance"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { isDesktop } from "@/lib/platform"
import { GLASS_PANE_INSET, leftChromeButtonsWidth } from "@/lib/window-chrome"
import { GLASS_RAISED_CARD_CLASS, glassClassName } from "@/components/ui/glass"
import {
  isNavItemVisible,
  loadNavFolded,
  loadNavItemVisibility,
  loadTagFilter,
  saveTagFilter,
  loadShowCompleted,
  loadShowRecent,
  loadShowWorktrees,
  loadSortMode,
  loadSectionOrder,
  moveSectionInOrder,
  saveNavFolded,
  saveNavItemVisibility,
  saveShowCompleted,
  saveShowRecent,
  saveShowWorktrees,
  saveSortMode,
  saveSectionOrder,
  DEFAULT_SECTION_ORDER,
  SIDEBAR_NAV_ITEM_IDS,
  type SidebarNavItemId,
  type SidebarNavItemVisibility,
  type SidebarSectionId,
  type SidebarSortMode,
  type SidebarSectionOrder,
} from "@/lib/sidebar-view-mode-storage"
import { useCanvasBoardsStore } from "@/stores/canvas-boards-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import {
  EMPTY_TAG_FILTER,
  pruneTagFilter,
  type TagFilter,
} from "@/lib/conversation-tags"
import {
  SidebarTagFilterBar,
  SidebarTagFilterSubmenu,
} from "@/components/conversations/sidebar-tag-filter"
import { SidebarSectionOrderControl } from "./sidebar-section-order-control"
import { cn } from "@/lib/utils"
import { SidebarBell } from "@/components/conversations/sidebar-bell"
import { formatBadgeCount } from "@/components/conversations/sidebar-unread-badge"

// Keyboard-shortcut hint at the trailing edge of the New chat row.
// Mirrors the folder count badge exactly — same chip (0.9375rem height,
// 0.3125rem radius, bg-primary/10, text-primary, 0.625rem text) per the request
// to match it. That pairing is also solidly legible (text-primary on
// primary/10 ≈ 14:1 light / 11:1 dark), unlike the muted-on-muted kbd it
// replaces (4.34:1). Revealed only on hover / keyboard focus of its row (each
// row is a `group`); font-mono renders the shortcut glyphs cleanly.
const SHORTCUT_BADGE_CLASS = cn(
  "ml-auto inline-flex h-[0.9375rem] shrink-0 items-center justify-center",
  "rounded-[0.3125rem] bg-primary/10 px-[0.25rem]",
  "font-mono text-[0.625rem] font-medium leading-none text-primary",
  "opacity-0 transition-opacity duration-150",
  "group-hover:opacity-100 group-focus-visible:opacity-100"
)

// Icon button on the glass pane's header: a 24px circle (jenny fork, see
// SIDEBAR_HEAD_BUTTON_SIZE) with a neutral gray hover — a plain control on
// glass, never a second layer of glass.
const SIDEBAR_HEAD_BUTTON =
  "lg-ib h-6 w-6 shrink-0 rounded-full text-[var(--ink2)] hover:bg-[var(--g-hover)] hover:text-foreground dark:hover:bg-[var(--g-hover)]"

// Which sections the order editor should render as switched-off. Module
// constants rather than a per-render `new Set`, so the reference is stable and
// the two states are spelled out once. "Recent" is the only section with a
// visibility toggle today.
const NO_HIDDEN_SECTIONS: ReadonlySet<SidebarSectionId> = new Set()
const RECENT_HIDDEN: ReadonlySet<SidebarSectionId> = new Set(["recent"])

// Icon per optional nav row. The visibility checkboxes in the view-options menu
// carry the same glyph as the row they switch, so that group reads as a mirror
// of the nav block rather than three bare labels.
const NAV_ITEM_ICONS: Record<SidebarNavItemId, LucideIcon> = {
  automations: Zap,
  tasks: ListTodo,
  forge: LayoutTemplate,
  canvas: MapIcon,
  apps: AppWindow,
}

/** `data-*` hooks a sidebar control hands through to its element, so tests can
 *  tell it apart from its look-alikes. */
type DataAttributes = { [attr: `data-${string}`]: string | number | boolean }

/**
 * jenny fork: one count from a row the quick-links fold hides, riding on the
 * folded toggle. Same chip and tint as the row's own badge (`attention` =
 * primary, `failure` = destructive), plus the row's icon, since several sit
 * side by side with their rows gone. Past 99 it reads "99+" like every sidebar
 * chip; the tooltip and the screen-reader text keep the row name and the
 * exact count.
 */
function NavCountChip({
  icon: Icon,
  label,
  count,
  tone,
  ...data
}: {
  icon: LucideIcon
  label: string
  count: number
  tone: "attention" | "failure"
} & DataAttributes) {
  const name = `${label} ${count}`
  return (
    <span
      {...data}
      title={name}
      className={cn(
        "inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center gap-0.5 rounded-full px-1",
        "font-mono text-[0.625rem] font-medium leading-none",
        tone === "failure"
          ? "bg-destructive/15 text-destructive"
          : "bg-primary/10 text-primary"
      )}
    >
      <Icon aria-hidden="true" className="h-[0.625rem] w-[0.625rem] shrink-0" />
      <span aria-hidden="true">{formatBadgeCount(count)}</span>
      <span className="sr-only">{name}</span>
    </span>
  )
}

/**
 * jenny fork: a thin disclosure row in the fixed block that folds a run of the
 * sidebar away in one click, and back. The label names what the click does;
 * the chevron shows the state (down while open). `trailing` rides at the
 * row's end.
 */
function SidebarFoldToggle({
  folded,
  label,
  onToggle,
  trailing,
  ...data
}: {
  folded: boolean
  label: string
  onToggle: () => void
  trailing?: ReactNode
} & DataAttributes) {
  return (
    <button
      type="button"
      {...data}
      onClick={onToggle}
      aria-expanded={!folded}
      title={label}
      className={cn(
        "flex h-[1.375rem] w-full items-center gap-[0.4375rem] rounded-[0.625rem] pl-[0.6875rem] pr-2",
        "text-[0.71875rem] text-[var(--ink3)] outline-none",
        "transition-colors duration-150 hover:bg-[var(--g-hover)] hover:text-sidebar-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      )}
    >
      {folded ? (
        <ChevronRight
          aria-hidden="true"
          className="h-[0.875rem] w-[0.875rem] shrink-0"
        />
      ) : (
        <ChevronDown
          aria-hidden="true"
          className="h-[0.875rem] w-[0.875rem] shrink-0"
        />
      )}
      <span className="truncate">{label}</span>
      {trailing}
    </button>
  )
}

/**
 * A fixed top-of-sidebar action / route row. `active` marks the row as the
 * current workbench route (selected styling); `trailing` carries a shortcut hint
 * or a count badge. Extracting this keeps every fixed nav item — and any future
 * route — on one geometry instead of copy-pasting the className. Each row is a
 * `group` so a `group-hover`-revealed trailing element works.
 */
function SidebarNavButton({
  icon: Icon,
  label,
  onClick,
  active,
  trailing,
  navId,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  active?: boolean
  trailing?: ReactNode
  navId?: string
}) {
  return (
    <button
      type="button"
      data-sidebar-nav={navId}
      onClick={onClick}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        // Liquid Glass: 32 high, 13px text, a radius-10 block for hover and
        // selection (concentric with the 18px pane, 8px in) — hover is neutral
        // gray, the selected route the accent at 9%.
        "group flex h-8 w-full items-center gap-[0.5625rem] rounded-[0.625rem] pl-[0.625rem] pr-2",
        "text-[0.8125rem] text-sidebar-foreground outline-none",
        "transition-colors duration-150 hover:bg-[var(--g-hover)]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active && "bg-primary/9 hover:bg-primary/9"
      )}
    >
      <Icon className="h-[0.9375rem] w-[0.9375rem] shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {trailing}
    </button>
  )
}

export function Sidebar({
  footer,
}: {
  /** Desktop only: the status bar's left half, at the pane's foot. */
  footer?: ReactNode
} = {}) {
  const t = useTranslations("Folder.sidebar")
  const { isOpen, toggle } = useSidebarContext()
  const { activeFolder } = useActiveFolder()
  const { openNewConversationTab, openChatModeTab } = useTabActions()
  const { unseenFailures } = useAutomationsView()
  const { attentionCount } = useTasksView()
  const { routeId, setRoute, openConversations } = useWorkbenchRoute()
  const isMac = useIsMac()
  const { isMac: platformIsMac } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  const { shortcuts } = useShortcutSettings()
  const isMobile = useIsMobile()
  const listRef = useRef<SidebarConversationListHandle>(null)
  // On desktop the header's top-left is owned by the fixed window-chrome overlay
  // (sidebar toggle + search); reserve exactly up to the end of its buttons so
  // the header's own controls clear it and continue its row. The reserve scales
  // with the app zoom to track the rem-sized overlay buttons. Mobile has no
  // overlay (the sidebar is a Drawer).
  // Measured from the glass pane's own left edge, which sits 8px in.
  const leftReserve =
    leftChromeButtonsWidth(platformIsMac && isDesktop(), zoomLevel) -
    GLASS_PANE_INSET
  // `showCompleted` defaults OFF; `showWorktrees` and `showRecent` default ON
  // (the mount effect below reconciles a persisted override). Each initial
  // value matches its own default so the pre-hydration render doesn't flash as
  // the stored preference is applied.
  const [showCompleted, setShowCompleted] = useState(false)
  const [showWorktrees, setShowWorktrees] = useState(true)
  const [showRecent, setShowRecent] = useState(true)
  // Empty = every nav row shown, which is also the hydrated default — so the
  // pre-hydration render matches for a user who never hid one.
  const [navItems, setNavItems] = useState<SidebarNavItemVisibility>({})
  const [sortMode, setSortMode] = useState<SidebarSortMode>("created")
  const [sectionOrder, setSectionOrder] = useState<SidebarSectionOrder>(
    DEFAULT_SECTION_ORDER
  )
  const [allExpanded, setAllExpanded] = useState(true)
  // Controlled only so the tag filter's "Manage tags…" can close the menu on
  // its way to the dialog: that entry is a plain button in a panel, not a menu
  // item, so it does not close the menu by itself.
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false)
  // What the user picked, persisted as picked. The list gets it PRUNED to tags
  // that still exist (below) — but only once the tag list has loaded: matching
  // needs nothing but ids, so a persisted filter applies from the first paint
  // instead of flashing the whole list and then narrowing it.
  const [rawTagFilter, setRawTagFilter] = useState<TagFilter>(EMPTY_TAG_FILTER)
  const tagsById = useConversationTagsStore((s) => s.tagsById)
  const tagsHydrated = useConversationTagsStore((s) => s.hydrated)
  const tagFilter = useMemo(
    () =>
      tagsHydrated ? pruneTagFilter(rawTagFilter, tagsById) : rawTagFilter,
    [rawTagFilter, tagsById, tagsHydrated]
  )
  // jenny fork: whether the quick links under New chat (every route row) are
  // folded away. Defaults to unfolded (the mount effect applies a persisted
  // fold), so a user who never folded them sees no flash.
  const [navFolded, setNavFolded] = useState(false)
  const [sessionActivity, setSessionActivity] = useState(false)
  const newConversationShortcutLabel = formatShortcutLabel(
    shortcuts.new_conversation,
    isMac
  )
  // General umbrella name for the eye menu (tag filter + list toggles + nav
  // rows + sort + section order). Kept generic so the accessible name / tooltip
  // stays accurate as the menu gains options.
  const viewOptionsLabel = t("viewOptions")
  const toggleExpandLabel = allExpanded
    ? t("collapseAllGroups")
    : t("expandAllGroups")
  const hiddenSections = showRecent ? NO_HIDDEN_SECTIONS : RECENT_HIDDEN

  useEffect(() => {
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    /* eslint-disable react-hooks/set-state-in-effect */
    setShowCompleted(loadShowCompleted())
    setShowWorktrees(loadShowWorktrees())
    setShowRecent(loadShowRecent())
    setNavItems(loadNavItemVisibility())
    setSortMode(loadSortMode())
    setSectionOrder(loadSectionOrder())
    setRawTagFilter(loadTagFilter())
    setNavFolded(loadNavFolded())
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  const handleSetTagFilter = useCallback((next: TagFilter) => {
    setRawTagFilter(next)
    saveTagFilter(next)
  }, [])

  const closeViewOptions = useCallback(() => setViewOptionsOpen(false), [])

  const handleToggleNavFolded = useCallback(() => {
    const next = !navFolded
    setNavFolded(next)
    saveNavFolded(next)
  }, [navFolded])

  /** Run `action` against the conversation list once it is mounted. */
  const runListAction = useCallback(
    (action: (list: SidebarConversationListHandle) => void) => {
      if (listRef.current) action(listRef.current)
    },
    []
  )

  const handleSetShowCompleted = useCallback((value: boolean) => {
    setShowCompleted(value)
    saveShowCompleted(value)
  }, [])

  const handleSetShowWorktrees = useCallback((value: boolean) => {
    setShowWorktrees(value)
    saveShowWorktrees(value)
  }, [])

  const handleSetShowRecent = useCallback((value: boolean) => {
    setShowRecent(value)
    saveShowRecent(value)
  }, [])

  const handleSetNavItem = useCallback(
    (id: SidebarNavItemId, visible: boolean) => {
      setNavItems((prev) => {
        const next = { ...prev, [id]: visible }
        saveNavItemVisibility(next)
        return next
      })
    },
    []
  )

  const handleSetSortMode = useCallback((value: string) => {
    const mode: SidebarSortMode = value === "updated" ? "updated" : "created"
    setSortMode(mode)
    saveSortMode(mode)
  }, [])

  // Nudge one section up/down a slot. `moveSectionInOrder` returns the SAME
  // array when the move would fall off an end, so a clamped nudge neither
  // re-renders the list nor rewrites localStorage.
  const handleMoveSection = useCallback(
    (id: SidebarSectionId, delta: number) => {
      setSectionOrder((prev) => {
        const next = moveSectionInOrder(prev, id, delta)
        if (next !== prev) saveSectionOrder(next)
        return next
      })
    },
    []
  )

  const handleToggleExpandAll = useCallback(() => {
    if (allExpanded) {
      runListAction((list) => list.collapseAll())
      setAllExpanded(false)
    } else {
      runListAction((list) => list.expandAll())
      setAllExpanded(true)
    }
  }, [allExpanded, runListAction])

  const handleNewConversation = useCallback(() => {
    // On mobile the sidebar is a Drawer overlay — close it so the new
    // conversation is visible (mirrors tapping a conversation card, which the
    // list wrapper already closes on).
    if (isMobile) toggle()
    // Starting a conversation always returns to the conversation workspace (in
    // case a route like Automations was taking over the content region).
    openConversations()
    // Defense-in-depth: with no active folder (e.g. a cold start that recovered
    // to nothing, or all folders closed) fall back to folderless chat mode
    // rather than no-op, so this entry point is never a dead end.
    if (!activeFolder) {
      openChatModeTab()
      return
    }
    openNewConversationTab(activeFolder.id, activeFolder.path)
  }, [
    activeFolder,
    openChatModeTab,
    openNewConversationTab,
    openConversations,
    isMobile,
    toggle,
  ])

  // What the folded quick-links toggle still has to say: the counts its hidden
  // rows carry, in row order — folding them must not hide a failed automation
  // or a to-do waiting on the user. A row switched off in View options stays
  // silent here too. Icons come from the same map as the View options toggles.
  const foldedNavCounts = (
    [
      {
        id: "automations",
        icon: NAV_ITEM_ICONS.automations,
        label: t("automations"),
        count: unseenFailures,
        tone: "failure",
      },
      {
        id: "tasks",
        icon: NAV_ITEM_ICONS.tasks,
        label: t("tasks"),
        count: attentionCount,
        tone: "attention",
      },
    ] as const
  ).filter((item) => item.count > 0 && isNavItemVisible(navItems, item.id))

  if (!isOpen) return null

  return (
    <aside
      data-glass={isMobile ? undefined : "pane"}
      className={cn(
        "@container/sidebar flex h-full min-h-0 flex-col overflow-hidden text-sidebar-foreground select-none",
        // A floating card, radius 18 (26 − 8, concentric with the window).
        // jenny fork: a solid light-grey card with a raised rim and a soft
        // shadow that fades out over the conversation; the window stays white.
        !isMobile &&
          cn(
            glassClassName({ material: "pane" }),
            GLASS_RAISED_CARD_CLASS,
            "rounded-[1.125rem]"
          )
      )}
    >
      {/* jenny fork: one row at the window-chrome buttons' own 2px rhythm —
          toggle, search, the bell (running / unread counts), then the list
          tools — so no gap opens inside it at any width; the empty space after
          the tools is the header's own drag region. The sidebar minimum is
          sized (and zoom-scaled) to hold this row (`resolveSidebarMinWidth`).
          The wrap is only a fallback against clipping (e.g. an unusually wide
          count); each row is the 46px head. */}
      <div
        data-tauri-drag-region
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-x-0.5 pr-2",
          // Desktop: the fixed left window-chrome overlay (reserved below) owns
          // the top-left; the `pl-2` in front of the reserve only shows on a
          // wrapped row, which then starts as far from the left edge as the
          // controls end from the right one. Off-image the divider is
          // border-border/50, matching the conversation / file detail
          // headers. But the sidebar sits on a FROSTED surface (ws-surface-sidebar)
          // while those headers sit on the transparent canvas: with a workspace
          // background image on, a border-border/50 hairline washes out against the
          // frosted shade, so it takes the boosted `ws-chrome-border` (like the
          // frosted status bar) to stay legible. Mobile (Drawer): keep the original
          // title padding + a full-strength divider.
          isMobile
            ? "min-h-10 border-b border-border pl-4"
            : // Glass: a 46px head, no divider line under it.
              "min-h-[2.875rem]"
        )}
      >
        {isMobile ? (
          <div className="flex min-w-0 items-center gap-4">
            <h2 className="truncate text-[0.875rem] font-bold tracking-[-0.00625rem] text-sidebar-foreground">
              {t("title")}
            </h2>
          </div>
        ) : (
          // Reserve up to the end of the fixed left overlay's buttons (less the
          // `pl-2` already in front of it) so the bell lands right after search;
          // the empty reserved space is a window-drag region.
          <div
            data-tauri-drag-region
            className="h-[2.875rem] shrink-0"
            style={{ width: leftReserve }}
          />
        )}
        <SidebarBell
          pressed={sessionActivity}
          onClick={() => setSessionActivity((value) => !value)}
        />
        {/* One row at the window-chrome buttons' 2px rhythm — toggle,
            search, the bell, then the list tools — with no gap opening inside
            it at any width; the empty space after the tools is the header's
            own drag region. */}
        <div
          data-sidebar-header-controls
          className={cn(
            "flex shrink-0 items-center gap-0.5",
            isMobile ? "h-10" : "h-[2.875rem]"
          )}
        >
          {/* Locate the active conversation in the list below (moved here from
              the conversation detail header). Always shown, leading the header
              cluster. The sidebar is unmounted while collapsed. */}
          <Button
            variant="ghost"
            size="icon"
            className={SIDEBAR_HEAD_BUTTON}
            onClick={() => runListAction((list) => list.scrollToActive())}
            title={t("locateActiveConversation")}
            aria-label={t("locateActiveConversation")}
          >
            <Crosshair
              aria-hidden="true"
              className="h-[0.9375rem] w-[0.9375rem]"
            />
          </Button>
          {/* Expand/collapse-all is an icon-only header button on every
              viewport (it used to be a labelled row inside the view-options
              menu on desktop): it acts on the list right now instead of storing
              a display preference, so it does not belong among that menu's
              settings rows — and it took two clicks there. The icon itself
              states the direction, hence label-free with a tooltip. */}
          <Button
            variant="ghost"
            size="icon"
            className={SIDEBAR_HEAD_BUTTON}
            onClick={handleToggleExpandAll}
            disabled={sessionActivity}
            title={toggleExpandLabel}
            aria-label={toggleExpandLabel}
          >
            {allExpanded ? (
              <ListChevronsDownUp
                aria-hidden="true"
                className="h-[0.9375rem] w-[0.9375rem]"
              />
            ) : (
              <ListChevronsUpDown
                aria-hidden="true"
                className="h-[0.9375rem] w-[0.9375rem]"
              />
            )}
          </Button>
          <DropdownMenu
            open={viewOptionsOpen}
            onOpenChange={setViewOptionsOpen}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={SIDEBAR_HEAD_BUTTON}
                title={viewOptionsLabel}
                aria-label={viewOptionsLabel}
              >
                {/* An eye, not a funnel: the menu as a whole decides what the
                    list shows and in what order. Its one filter, by tags, wears
                    the funnel on its own row, and a filter that is on announces
                    itself in the strip above the list. */}
                <Eye
                  aria-hidden="true"
                  className="h-[0.9375rem] w-[0.9375rem]"
                />
              </Button>
            </DropdownMenuTrigger>
            {/* Wider than the shared `min-w-48`: the section-order rows carry a
                position chip and two move buttons beside the name, and the menu
                clips overflow-x — 48 would start truncating longer localized
                section names. */}
            <DropdownMenuContent align="end" className="min-w-56">
              {/* Four groups: what the list shows → which nav rows exist → how
                  the list is sorted → how its sections are stacked. The first
                  group is the tag filter plus the list toggles, and those and
                  the nav rows are hover-opened submenus rather than inline
                  blocks. The two inventories are set-and-forget on/off sets,
                  six checkboxes between them, and inlining all six left a
                  fifteen-row menu with Sort by / Section order — the two
                  settings people actually come back for — stranded at the
                  bottom of it. The tag filter, which people come back for too,
                  leads the menu instead: it is a whole panel (search, match
                  mode, tag list) that only a submenu has room for. Sort by and
                  Section order stay inline: a pair of radios and a ranked list
                  read wrong behind another hop, and the order rows need this
                  menu's width.
                  Every option keeps the menu open on select (the default is to
                  close): this menu is a settings panel, not a command list, and
                  flipping two of them used to cost two round trips through the
                  trigger. The one action it used to carry — expand/collapse
                  all — is now a header button of its own. */}
              <SidebarTagFilterSubmenu
                filter={tagFilter}
                onChange={handleSetTagFilter}
                onCloseMenu={closeViewOptions}
              />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <MessagesSquare className="text-muted-foreground" />
                  {t("listOptions")}
                </DropdownMenuSubTrigger>
                {/* No width override: unlike the root content — held at exactly
                    `min-w-56` and clipping overflow-x — the sub-content grows to
                    fit its rows, which is the headroom these three (the longest
                    labels in the menu) want. */}
                <DropdownMenuSubContent>
                  <DropdownMenuCheckboxItem
                    checked={showCompleted}
                    onCheckedChange={handleSetShowCompleted}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {t("showCompleted")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={showWorktrees}
                    onCheckedChange={handleSetShowWorktrees}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {t("showWorktrees")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={showRecent}
                    onCheckedChange={handleSetShowRecent}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {t("showRecent")}
                  </DropdownMenuCheckboxItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Menu className="text-muted-foreground" />
                  {t("navigationItems")}
                </DropdownMenuSubTrigger>
                {/* Driven by the id list itself, so a route added there can
                    never ship a row without its toggle. Each id doubles as its
                    message key. Hiding one only drops the sidebar shortcut: the
                    status bar's quick-actions menu still reaches every route, so
                    no choice here can strand the user on a page. */}
                <DropdownMenuSubContent>
                  {SIDEBAR_NAV_ITEM_IDS.map((id) => {
                    const Icon = NAV_ITEM_ICONS[id]
                    return (
                      <DropdownMenuCheckboxItem
                        key={id}
                        checked={isNavItemVisible(navItems, id)}
                        onCheckedChange={(value) => handleSetNavItem(id, value)}
                        onSelect={(event) => event.preventDefault()}
                      >
                        <Icon className="text-muted-foreground" />
                        {t(id)}
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("sortBy")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortMode}
                onValueChange={handleSetSortMode}
              >
                <DropdownMenuRadioItem
                  value="created"
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("sortByCreatedAt")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="updated"
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("sortByUpdatedAt")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("sectionOrder")}</DropdownMenuLabel>
              <SidebarSectionOrderControl
                order={sectionOrder}
                onMove={handleMoveSection}
                hiddenSections={hiddenSections}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Fixed actions above the scrollable list. `shrink-0` keeps them pinned —
          they never scroll with the conversation list. Rows are `rounded-full`
          like the conversation pills, and the icon/text geometry matches the
          folder header: a 0.875rem icon + 0.875rem label at a 0.4375rem gap, with
          the row's pl-[0.4375rem] (atop the container's px-1.5) placing the icon
          center on the same 0.875rem rail axis as the folder/conversation icons in
          the list below. Each row is a `group` so its shortcut hint reveals on
          hover / keyboard focus. */}
      <div className="flex shrink-0 flex-col gap-px px-2 pt-0.5 pb-1">
        <SidebarNavButton
          icon={SquarePen}
          label={t("newChat")}
          onClick={handleNewConversation}
          trailing={
            newConversationShortcutLabel ? (
              <kbd className={SHORTCUT_BADGE_CLASS}>
                {newConversationShortcutLabel}
              </kbd>
            ) : null
          }
        />
        {/* jenny fork: folds the quick links below — every route row —
            away in one click; New chat stays, as the block's
            primary action. The toggle sits ABOVE the rows it folds, so it stays
            put under the pointer and a second click undoes the first (below
            them it would jump up by their height and leave the pointer on the
            list fold instead). Folded, it carries the hidden rows' counts. */}
        <SidebarFoldToggle
          data-sidebar-nav-fold-toggle
          folded={navFolded}
          label={navFolded ? t("unfoldNavItems") : t("foldNavItems")}
          onToggle={handleToggleNavFolded}
          trailing={
            navFolded && foldedNavCounts.length > 0 ? (
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {foldedNavCounts.map((item) => (
                  <NavCountChip
                    key={item.id}
                    data-nav-fold-count={item.id}
                    icon={item.icon}
                    label={item.label}
                    count={item.count}
                    tone={item.tone}
                  />
                ))}
              </span>
            ) : null
          }
        />
        {/* Search is deliberately NOT a row here: it moved to the fixed top-left
            window chrome (`LeftEdgeChrome`, plus the mobile `FolderTitleBar`),
            which — unlike this sidebar — never unmounts, so the button survives
            a collapse. ⌘K still works from anywhere. */}
        {/* Each route row can be switched off from the view-options menu's
            "Navigation items" group — for a workspace that never uses one of
            them, this block is pure noise above the list. The routes stay
            reachable from the status bar's quick-actions menu either way.
            All three close the mobile Drawer on the way out, like tapping a
            conversation card (handled by the list wrapper below) — otherwise the
            page they just opened stays hidden behind the sidebar. */}
        {!navFolded && isNavItemVisible(navItems, "automations") && (
          <SidebarNavButton
            icon={Zap}
            label={t("automations")}
            active={routeId === "automations"}
            onClick={() => {
              if (isMobile) toggle()
              setRoute("automations")
            }}
            trailing={
              unseenFailures > 0 ? (
                <span className="ml-auto inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full bg-destructive/15 px-1 font-mono text-[0.625rem] font-medium leading-none text-destructive">
                  {formatBadgeCount(unseenFailures)}
                </span>
              ) : null
            }
          />
        )}
        {!navFolded && isNavItemVisible(navItems, "tasks") && (
          <SidebarNavButton
            icon={ListTodo}
            label={t("tasks")}
            active={routeId === "tasks"}
            onClick={() => {
              if (isMobile) toggle()
              setRoute("tasks")
            }}
            trailing={
              attentionCount > 0 ? (
                // Attention (not failure): tasks waiting on the user — primary
                // tint like the shortcut chips, not destructive.
                <span className="ml-auto inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[0.625rem] font-medium leading-none text-primary">
                  {formatBadgeCount(attentionCount)}
                </span>
              ) : null
            }
          />
        )}
        {!navFolded && isNavItemVisible(navItems, "forge") && (
          <SidebarNavButton
            icon={LayoutTemplate}
            label={t("forge")}
            active={routeId === "forge"}
            onClick={() => {
              if (isMobile) toggle()
              setRoute("forge")
            }}
          />
        )}
        {!navFolded && isNavItemVisible(navItems, "canvas") && (
          <SidebarNavButton
            icon={MapIcon}
            label={t("canvas")}
            active={routeId === "canvas"}
            onClick={() => {
              if (isMobile) toggle()
              // Coming from elsewhere returns to the canvas that was open;
              // clicking it again from inside one goes up to the list — the
              // route's own home, like re-tapping an active tab.
              if (routeId === "canvas") {
                useCanvasBoardsStore.getState().closeBoard()
              }
              setRoute("canvas")
            }}
          />
        )}
        {!navFolded && isNavItemVisible(navItems, "apps") && (
          <SidebarNavButton
            icon={AppWindow}
            label={t("apps")}
            active={routeId === "apps"}
            onClick={() => {
              if (isMobile) toggle()
              setRoute("apps")
            }}
          />
        )}
      </div>

      {/* On mobile, clicking a conversation card auto-closes the Drawer */}
      <div
        // Glass: the list fades out at the bottom instead of a divider.
        className={cn(
          "flex flex-col flex-1 min-h-0 overflow-hidden pt-1.5",
          !isMobile && "glass-fade-bottom"
        )}
        onClick={
          isMobile
            ? (e) => {
                const target = e.target as HTMLElement
                if (target.closest("[data-conversation-id]")) {
                  toggle()
                }
              }
            : undefined
        }
      >
        <SidebarTagFilterBar filter={tagFilter} onChange={handleSetTagFilter} />
        <SidebarConversationList
          ref={listRef}
          showCompleted={showCompleted}
          showWorktrees={showWorktrees}
          showRecent={showRecent}
          sortMode={sortMode}
          sectionOrder={sectionOrder}
          tagFilter={tagFilter}
          sessionActivity={sessionActivity}
        />
      </div>
      {/* Glass: the status bar's left half (quick actions, conversation
          count) sits at the foot of the pane. */}
      {!isMobile && footer && (
        <div
          data-sidebar-footer=""
          className="flex h-[2.625rem] shrink-0 items-center px-2.5"
        >
          {footer}
        </div>
      )}
    </aside>
  )
}
