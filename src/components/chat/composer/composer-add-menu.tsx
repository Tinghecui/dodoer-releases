"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import {
  ChevronLeft,
  ChevronRight,
  Command,
  FileStack,
  FlaskConical,
  FolderSearch,
  Lock,
  MessageSquarePlus,
  MessageSquareText,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Upload,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DropdownRadioItemContent } from "@/components/chat/dropdown-radio-item-content"
import { rankByTextMatch } from "@/lib/fuzzy-text-match"
import { isImeCompositionKey } from "@/lib/ime-composition"
import { cn } from "@/lib/utils"
import type { AvailableCommandInfo } from "@/lib/types"

import {
  commandInputHint,
  commandInvocationToken,
} from "@/components/chat/composer/invocation-reference"
import { UPWARD_DROPDOWN_MAX_HEIGHT_CLASS } from "@/components/chat/composer/upward-menu"
import type { ComposerAttachments } from "@/components/chat/composer/use-composer-attachments"
import type { ComposerShortcuts } from "@/components/chat/composer/use-composer-shortcuts"

/** The submenu geometry every list in this menu shares. */
const SUBMENU_STYLE = {
  maxWidth: "min(20rem, calc(100vw - 1rem))",
  // 手机上键盘弹起时也不超出键盘以上的可见区域（--app-vvh，见 upward-menu.ts）。
  maxHeight:
    "min(32rem, var(--radix-dropdown-menu-content-available-height), var(--app-vvh, 100dvh))",
} as const

/** 手机布局下加号菜单里「原地切换」到的子菜单。 */
type MobileView = "quick" | "slash" | "experts" | "office" | "research"

export interface ComposerAddMenuProps {
  disabled?: boolean
  /** File/image attachment entries. Omit to drop the attach section entirely
   *  (a surface whose target can't receive files). */
  attachments?: Pick<
    ComposerAttachments,
    | "showNativePaperclip"
    | "handlePickFiles"
    | "handleUploadLocalFiles"
    | "setServerFilePickerOpen"
  > | null
  shortcuts: ComposerShortcuts
  /** The agent's own `/` commands (from a live session or a transient probe). */
  slashCommands: AvailableCommandInfo[]
  /** Open the live-feedback dialog. Conversation-only; omitted elsewhere. */
  onAddFeedback?: () => void
  feedbackAddDisabled?: boolean
  triggerClassName?: string
}

/**
 * The composer's "+" menu — attach files, insert a saved quick message, pick a
 * slash command, or drop in one of the bundled skill families.
 *
 * One component for every composer in the app (conversation, and the to-do task
 * new/edit + follow-up + restart boxes) so the shortcuts a user learns in chat
 * are the same ones on the board, down to the wording: every label here reads
 * from the conversation composer's own message namespace.
 */
export function ComposerAddMenu({
  disabled = false,
  attachments = null,
  shortcuts,
  slashCommands,
  onAddFeedback,
  feedbackAddDisabled,
  triggerClassName,
}: ComposerAddMenuProps) {
  const t = useTranslations("Folder.chat.messageInput")
  // 手机屏幕太窄，子菜单从主菜单右边弹出会超出屏幕（#1351）：手机布局下改成
  // 主菜单原地换成子菜单的列表，顶上带「返回」；电脑上仍是侧弹的子菜单。
  const isMobile = useIsMobile()
  const [mobileView, setMobileView] = useState<MobileView | null>(null)
  const [slashOpenDesktop, setSlashOpenDesktop] = useState(false)
  const slashOpen = isMobile ? mobileView === "slash" : slashOpenDesktop
  const [slashSearch, setSlashSearch] = useState("")
  const slashInputRef = useRef<HTMLInputElement>(null)

  const filteredSlashCommands = useMemo(
    () =>
      rankByTextMatch(
        slashSearch,
        slashCommands,
        (cmd) => cmd.name,
        (cmd) => cmd.description
      ),
    [slashCommands, slashSearch]
  )

  const handleSlashOpenChange = useCallback((open: boolean) => {
    setSlashOpenDesktop(open)
    if (!open) setSlashSearch("")
  }, [])

  const showMobileView = useCallback((view: MobileView | null) => {
    setMobileView(view)
    setSlashSearch("")
  }, [])

  // 用 Enter 选中第一条命令后收起命令列表（电脑上收子菜单，手机上回主列表）。
  const closeSlash = useCallback(() => {
    if (isMobile) showMobileView(null)
    else handleSlashOpenChange(false)
  }, [isMobile, showMobileView, handleSlashOpenChange])

  useEffect(() => {
    if (!slashOpen) return
    const raf = requestAnimationFrame(() => {
      slashInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [slashOpen])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        // 下次打开从主列表开始。
        showMobileView(null)
        return
      }
      // The editor keeps its selection while the menu is open, so a quick
      // message inserts back at the same caret without tracking an offset.
      shortcuts.refreshQuickMessages()
    },
    [shortcuts, showMobileView]
  )

  const quickMessagesBody =
    shortcuts.quickMessagesLoading && shortcuts.quickMessages.length === 0 ? (
      <div className="px-3 py-4 text-center text-xs text-muted-foreground">
        {t("quickMessagesLoading")}
      </div>
    ) : shortcuts.quickMessages.length === 0 ? (
      <div className="px-3 py-4 text-center text-xs text-muted-foreground">
        {t("quickMessagesEmpty")}
      </div>
    ) : (
      shortcuts.quickMessages.map((message) => (
        <DropdownMenuItem
          key={message.id}
          onClick={() => shortcuts.insertQuickMessage(message)}
        >
          <span className="truncate">
            {message.title.trim() || (
              <span className="italic text-muted-foreground">
                {t("quickMessageUntitled")}
              </span>
            )}
          </span>
        </DropdownMenuItem>
      ))
    )

  const slashBody = (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={slashInputRef}
          type="text"
          role="searchbox"
          aria-label={t("slashSearchPlaceholder")}
          value={slashSearch}
          onChange={(e) => setSlashSearch(e.target.value)}
          onKeyDown={(e) => {
            // Arrow/Enter belong to the IME while a CJK candidate is up,
            // not to this command list.
            if (isImeCompositionKey(e)) return
            if (e.key === "ArrowDown") {
              e.preventDefault()
              const container = e.currentTarget.closest("[data-slash-list]")
              const firstItem =
                container?.querySelector<HTMLElement>('[role="menuitem"]')
              firstItem?.focus()
              return
            }
            if (e.key === "Enter") {
              e.preventDefault()
              const first = filteredSlashCommands[0]
              if (first) {
                shortcuts.insertSlashCommand(first)
                closeSlash()
              }
              return
            }
            if (e.key === "Escape" || e.key === "Tab") return
            // Prevent radix DropdownMenu's built-in typeahead from
            // hijacking letter keys while the user is typing.
            e.stopPropagation()
          }}
          placeholder={t("slashSearchPlaceholder")}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {filteredSlashCommands.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("slashSearchEmpty")}
          </div>
        ) : (
          filteredSlashCommands.map((cmd) => (
            <DropdownMenuItem
              key={cmd.name}
              onClick={() => shortcuts.insertSlashCommand(cmd)}
              // Radix focuses the item on pointermove, which fires while
              // scrolling (items slide under the cursor) and steals focus
              // from the search input. Short-circuit that default with
              // preventDefault so the search keeps focus until the user
              // explicitly clicks.
              onPointerMove={(e) => e.preventDefault()}
              onPointerLeave={(e) => e.preventDefault()}
              className="hover:bg-accent hover:text-accent-foreground"
            >
              <DropdownRadioItemContent
                label={commandInvocationToken(cmd.name)}
                hint={commandInputHint(cmd)}
                description={cmd.description}
              />
            </DropdownMenuItem>
          ))
        )}
      </div>
    </>
  )

  const expertsBody = shortcuts.experts.map((item) => {
    const Icon = shortcuts.getExpertIcon(item.metadata.icon)
    return (
      <DropdownMenuItem
        key={item.metadata.id}
        onClick={() => shortcuts.insertExpert(item)}
      >
        <Icon className="size-4" />
        <span className="flex-1 truncate">{shortcuts.expertLabel(item)}</span>
        {shortcuts.isSkillLocked(item.metadata.id) && (
          <Lock className="ml-auto size-3.5 shrink-0 text-muted-foreground/70" />
        )}
      </DropdownMenuItem>
    )
  })

  const officeBody = shortcuts.officeActions.map((action) => {
    const Icon = action.icon
    return (
      <DropdownMenuItem
        key={action.id}
        onClick={() => shortcuts.insertOffice(action)}
      >
        <Icon className="size-4" />
        <span className="flex-1 truncate">{shortcuts.officeLabel(action)}</span>
        {shortcuts.isSkillLocked(action.skillId) && (
          <Lock className="ml-auto size-3.5 shrink-0 text-muted-foreground/70" />
        )}
      </DropdownMenuItem>
    )
  })

  const researchBody = shortcuts.science.map((item) => {
    const Icon = shortcuts.getScienceIcon(item.metadata.icon)
    return (
      <DropdownMenuItem
        key={item.metadata.id}
        onClick={() => shortcuts.insertScience(item)}
      >
        <Icon className="size-4" />
        <span className="flex-1 truncate">{shortcuts.scienceLabel(item)}</span>
        {shortcuts.isSkillLocked(item.metadata.id) && (
          <Lock className="ml-auto size-3.5 shrink-0 text-muted-foreground/70" />
        )}
      </DropdownMenuItem>
    )
  })

  /**
   * 一个子菜单入口：电脑上是侧弹的子菜单；手机上是主列表里的一项，点了把主菜单
   * 原地换成这一项的列表（见 mobileView）。
   */
  const submenu = ({
    view,
    icon,
    label,
    disabled = false,
    contentClassName,
    body,
    open,
    onOpenChange,
  }: {
    view: MobileView
    icon: ReactNode
    label: string
    disabled?: boolean
    contentClassName: string
    body: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) =>
    isMobile ? (
      <DropdownMenuItem
        disabled={disabled}
        data-mobile-submenu={view}
        onSelect={(e) => {
          // 不关菜单，只换成子菜单的列表。
          e.preventDefault()
          showMobileView(view)
        }}
      >
        {icon}
        {label}
        <ChevronRight className="ml-auto" />
      </DropdownMenuItem>
    ) : (
      <DropdownMenuSub open={open} onOpenChange={onOpenChange}>
        <DropdownMenuSubTrigger disabled={disabled}>
          {icon}
          {label}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className={contentClassName}
          style={SUBMENU_STYLE}
          {...(view === "slash" ? { "data-slash-list": "" } : {})}
        >
          {body}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )

  const mobileViewBody =
    mobileView === "quick"
      ? quickMessagesBody
      : mobileView === "slash"
        ? slashBody
        : mobileView === "experts"
          ? expertsBody
          : mobileView === "office"
            ? officeBody
            : mobileView === "research"
              ? researchBody
              : null
  const mobileViewLabel =
    mobileView === "quick"
      ? t("quickMessages")
      : mobileView === "slash"
        ? t("slashCommands")
        : mobileView === "experts"
          ? t("experts")
          : mobileView === "office"
            ? t("office")
            : mobileView === "research"
              ? t("research")
              : ""

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          disabled={disabled}
          variant="ghost"
          size="icon-xs"
          className={cn("shrink-0 text-muted-foreground", triggerClassName)}
          title={t("addActions")}
          aria-label={t("addActions")}
        >
          <Plus className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className={cn(
          "min-w-56 w-auto",
          UPWARD_DROPDOWN_MAX_HEIGHT_CLASS,
          // 手机上子菜单也在这一层里显示，宽度不超出屏幕。
          isMobile && "max-w-[calc(100vw-1rem)]",
          isMobile && mobileView === "slash" && "min-w-72"
        )}
      >
        {isMobile && mobileView ? (
          <>
            <DropdownMenuItem
              data-mobile-back=""
              onSelect={(e) => {
                e.preventDefault()
                showMobileView(null)
              }}
            >
              <ChevronLeft className="size-4" />
              <span className="flex-1 truncate">{t("addMenuBack")}</span>
              <span className="truncate text-xs text-muted-foreground">
                {mobileViewLabel}
              </span>
            </DropdownMenuItem>
            {mobileView === "slash" ? (
              <div data-slash-list="" className="flex flex-col">
                {mobileViewBody}
              </div>
            ) : (
              mobileViewBody
            )}
          </>
        ) : (
          <>
            {attachments ? (
              attachments.showNativePaperclip ? (
                <DropdownMenuItem
                  onClick={() => {
                    attachments.handlePickFiles().catch((error) => {
                      console.error(
                        "[ComposerAddMenu] pick files from menu failed:",
                        error
                      )
                    })
                  }}
                >
                  <Paperclip className="size-4" />
                  {t("attachFiles")}
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem
                    onClick={() => {
                      attachments.handleUploadLocalFiles().catch((error) => {
                        console.error(
                          "[ComposerAddMenu] upload local files failed:",
                          error
                        )
                      })
                    }}
                  >
                    <Upload className="size-4" />
                    {t("attachLocalUpload")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => attachments.setServerFilePickerOpen(true)}
                  >
                    <FolderSearch className="size-4" />
                    {t("attachServerFile")}
                  </DropdownMenuItem>
                </>
              )
            ) : null}
            {submenu({
              view: "quick",
              icon: <MessageSquareText className="size-4" />,
              label: t("quickMessages"),
              contentClassName: "min-w-40 overflow-y-auto",
              body: quickMessagesBody,
            })}
            {onAddFeedback && (
              <DropdownMenuItem
                disabled={feedbackAddDisabled}
                onClick={onAddFeedback}
                title={
                  feedbackAddDisabled
                    ? t("liveFeedbackDisabledHint")
                    : undefined
                }
              >
                <MessageSquarePlus className="size-4" />
                {t("liveFeedback")}
              </DropdownMenuItem>
            )}
            {submenu({
              view: "slash",
              icon: <Command className="size-4" />,
              label: t("slashCommands"),
              disabled: slashCommands.length === 0,
              contentClassName: "flex min-w-72 flex-col overflow-hidden p-0",
              body: slashBody,
              open: slashOpenDesktop,
              onOpenChange: handleSlashOpenChange,
            })}
            {/* A custom-dir pi can't have skills managed by codeg's default-dir
                store, so hide these shortcuts instead of offering ones that lock
                with a Settings path the Experts/Office matrices also hide for this
                agent. */}
            {shortcuts.skillManagementSupported && (
              <>
                {submenu({
                  view: "experts",
                  icon: <Sparkles className="size-4" />,
                  label: t("experts"),
                  disabled: shortcuts.experts.length === 0,
                  contentClassName: "min-w-44 overflow-y-auto",
                  body: expertsBody,
                })}
                {submenu({
                  view: "office",
                  icon: <FileStack className="size-4" />,
                  label: t("office"),
                  contentClassName: "min-w-44 overflow-y-auto",
                  body: officeBody,
                })}
                {submenu({
                  view: "research",
                  icon: <FlaskConical className="size-4" />,
                  label: t("research"),
                  disabled: shortcuts.science.length === 0,
                  contentClassName: "min-w-44 overflow-y-auto",
                  body: researchBody,
                })}
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
