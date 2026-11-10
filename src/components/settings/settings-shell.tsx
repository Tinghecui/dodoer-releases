"use client"

import {
  useCallback,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import {
  Bot,
  BookOpenText,
  Boxes,
  Bubbles,
  Compass,
  FileSpreadsheet,
  GitBranch,
  Globe,
  Keyboard,
  Menu,
  MonitorCloud,
  MessageSquareText,
  MonitorCog,
  SendHorizontal,
  Palette,
  PlugZap,
  Server,
  Settings,
  SlidersHorizontal,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { usePathname } from "next/navigation"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppToaster } from "@/components/ui/app-toaster"
import { cn } from "@/lib/utils"
import {
  detectEnvironment,
  type TransportEnvironment,
} from "@/lib/transport/detect"
import { AppTitleBar } from "@/components/layout/app-title-bar"
import { useIsMobile } from "@/hooks/use-mobile"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { brandTitle } from "@/lib/cowork/brand"
import { useDocumentTitle } from "@/lib/cowork/document-title"
import {
  hasServerSettings,
  settingsTargetFor,
  type SettingsScope,
  type SettingsTarget,
} from "@/lib/settings-scope"
import {
  useAppLabel,
  useServerLabel,
  useSettingsTarget,
} from "@/components/settings/settings-scope"

interface SettingsNavItem {
  href: string
  labelKey:
    | "general"
    | "appearance"
    | "agents"
    | "model_providers"
    | "mcp"
    | "skills"
    | "skill_packs"
    | "collaboration"
    | "browser"
    | "computer_use"
    | "quick_messages"
    | "shortcuts"
    | "version_control"
    | "chat_channels"
    | "system"
    | "web_service"
    | "logs"
  icon: ComponentType<{ className?: string }>
  scope: SettingsScope
}

// Filed by where a page's settings are kept (`lib/settings-scope.ts`): this
// computer's app first, then the daemon the window talks to. The nav shows
// the two groups under their own headings, in this order.
const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    href: "/settings/appearance",
    labelKey: "appearance",
    icon: Palette,
    scope: "app",
  },
  {
    href: "/settings/general",
    labelKey: "general",
    icon: SlidersHorizontal,
    scope: "app",
  },
  {
    href: "/settings/shortcuts",
    labelKey: "shortcuts",
    icon: Keyboard,
    scope: "app",
  },
  {
    href: "/settings/browser",
    labelKey: "browser",
    icon: Compass,
    scope: "app",
  },
  {
    href: "/settings/computer-use",
    labelKey: "computer_use",
    icon: MonitorCog,
    scope: "app",
  },
  {
    href: "/settings/system",
    labelKey: "system",
    icon: Settings,
    scope: "app",
  },
  {
    href: "/settings/agents",
    labelKey: "agents",
    icon: Bot,
    scope: "server",
  },
  {
    href: "/settings/model-providers",
    labelKey: "model_providers",
    icon: Server,
    scope: "server",
  },
  {
    href: "/settings/mcp",
    labelKey: "mcp",
    icon: PlugZap,
    scope: "server",
  },
  {
    href: "/settings/skills",
    labelKey: "skills",
    icon: BookOpenText,
    scope: "server",
  },
  {
    href: "/settings/skill-packs",
    labelKey: "skill_packs",
    icon: Boxes,
    scope: "server",
  },
  {
    href: "/settings/collaboration",
    labelKey: "collaboration",
    icon: Bubbles,
    scope: "server",
  },
  {
    href: "/settings/quick-messages",
    labelKey: "quick_messages",
    icon: MessageSquareText,
    scope: "server",
  },
  {
    href: "/settings/chat-channels",
    labelKey: "chat_channels",
    icon: SendHorizontal,
    scope: "server",
  },
  {
    href: "/settings/version-control",
    labelKey: "version_control",
    icon: GitBranch,
    scope: "server",
  },
  {
    href: "/settings/web-service",
    labelKey: "web_service",
    icon: Globe,
    scope: "server",
  },
  {
    href: "/settings/logs",
    labelKey: "logs",
    icon: FileSpreadsheet,
    scope: "server",
  },
]

interface SettingsShellProps {
  children: ReactNode
}

/**
 * The nav for one runtime. Only one entry is runtime-bound: the Web service
 * page configures the server a web client is already talking to, and there is
 * no such server to configure from inside it.
 *
 * The Browser page is deliberately not on that list. Most of what it holds is
 * a desktop browser engine, but site rules, what a server starting in a
 * terminal does and the terminal's link menu all still decide something in a
 * browser session, and that page is the only place they can be set.
 */
export function settingsNavItemsFor(
  env: TransportEnvironment,
  target: SettingsTarget = settingsTargetFor(env, null, null)
): SettingsNavItem[] {
  return SETTINGS_NAV_ITEMS.filter(
    (item) =>
      !(item.labelKey === "web_service" && env === "web") &&
      // An app running without a local daemon (`CODEG_DESKTOP_DAEMON=
      // client`): only the app's own pages are anyone's settings there.
      (item.scope === "app" || hasServerSettings(target))
  )
}

function normalizePath(path: string): string {
  const noSuffix = path.replace(/\/index\.html$/, "").replace(/\.html$/, "")
  const noTrailingSlash = noSuffix.replace(/\/+$/, "")
  return noTrailingSlash || "/"
}

function isWindowsRuntime(): boolean {
  if (typeof navigator === "undefined") return false
  const platform = navigator.platform.toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()
  return platform.includes("win") || userAgent.includes("windows")
}

export function SettingsShell({ children }: SettingsShellProps) {
  const t = useTranslations("SettingsShell")
  const pathname = usePathname()
  const router = useRouter()
  const normalizedPathname = normalizePath(pathname)
  const isMobile = useIsMobile()
  const [navOpen, setNavOpen] = useState(false)

  const target = useSettingsTarget()
  const serverLabel = useServerLabel(target)
  const appLabel = useAppLabel(target)
  // A remote window's settings are titled with the server they edit, so two
  // settings windows side by side tell themselves apart (the native title is
  // set the same way, `open_settings_window`).
  const windowTitle =
    target.kind === "remote"
      ? t("titleWithServer", { server: serverLabel })
      : t("title")

  // Held, not set once: a client-side navigation puts the root layout's
  // metadata title back, and this shell is a layout that stays mounted.
  useDocumentTitle(brandTitle(windowTitle))

  const navigateTo = useCallback(
    (href: string) => {
      if (typeof window === "undefined") return

      const target = normalizePath(href)
      const current = normalizePath(window.location.pathname)
      if (current === target) {
        setNavOpen(false)
        return
      }

      // Preserve current query string so the active remote workspace context
      // (`?remoteConnectionId=N`) carries over to sub-pages — without this,
      // navigating from /settings/appearance to /settings/mcp drops the
      // remote id and the next page falls back to the local Tauri backend.
      const search = window.location.search
      const fullTarget = search ? `${target}${search}` : target

      if (isWindowsRuntime()) {
        window.location.assign(fullTarget)
        return
      }

      router.push(fullTarget)
      setNavOpen(false)
    },
    [router, setNavOpen]
  )

  const filteredNavItems = settingsNavItemsFor(detectEnvironment(), target)
  const navGroups: { scope: SettingsScope; label: string }[] = [
    { scope: "app", label: appLabel },
    { scope: "server", label: serverLabel },
  ]

  const renderNavItem = (item: SettingsNavItem) => {
    const Icon = item.icon
    const translationKey = `nav.${item.labelKey}` as const
    const active =
      normalizedPathname === item.href ||
      normalizedPathname.startsWith(`${item.href}/`)
    return (
      <Button
        key={item.href}
        variant={active ? "secondary" : "ghost"}
        size="sm"
        className={cn("w-full justify-start px-2")}
        type="button"
        onClick={() => navigateTo(item.href)}
        aria-current={active ? "page" : undefined}
      >
        <span className="inline-flex items-center gap-1">
          <Icon className="h-3.5 w-3.5" />
          {t(translationKey)}
        </span>
      </Button>
    )
  }

  const navContent = (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <nav className="space-y-3">
          {navGroups.map((group) => {
            const items = filteredNavItems.filter(
              (item) => item.scope === group.scope
            )
            if (items.length === 0) return null
            return (
              <div
                key={group.scope}
                className="space-y-1"
                data-settings-scope={group.scope}
              >
                <div
                  className="truncate px-2 pb-1 text-2xs font-medium text-muted-foreground"
                  title={
                    group.scope === "server" && target.kind === "remote"
                      ? target.serverUrl
                      : undefined
                  }
                >
                  {group.label}
                </div>
                {items.map(renderNavItem)}
              </div>
            )
          })}
        </nav>
      </ScrollArea>
    </div>
  )

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-foreground">
      {/* Liquid Glass: in the settings window only the top toolbar is
          glass (handoff 6.2); the pages under it are content. */}
      <AppTitleBar
        className="lg lg-pane lg-bar z-10 border-b-0 bg-[var(--g-fill)]"
        left={
          isMobile ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setNavOpen(true)}
            >
              <Menu className="h-4 w-4" />
            </Button>
          ) : undefined
        }
        center={
          <div className="flex min-w-0 items-center gap-2">
            <div className="text-sm font-bold tracking-tight">{t("title")}</div>
            {target.kind === "remote" && (
              <span
                className="inline-flex max-w-64 items-center gap-1 rounded-full border px-2 py-0.5 text-2xs text-muted-foreground"
                title={target.serverUrl}
              >
                <MonitorCloud className="h-3 w-3 shrink-0" />
                <span className="truncate">{serverLabel}</span>
              </span>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 flex">
        {/* Desktop sidebar */}
        {!isMobile && (
          <aside className="flex min-h-0 w-56 shrink-0 flex-col border-r px-2 py-3">
            {navContent}
          </aside>
        )}

        {/* Mobile navigation Drawer. Opts back into press-outside-to-close,
            against the app-wide drawer default: it is navigation, and tapping
            the page it partially covers is how you put it away on a phone. */}
        {isMobile && (
          <Drawer
            open={navOpen}
            onOpenChange={setNavOpen}
            swipeDirection="left"
            disablePointerDismissal={false}
          >
            {/* rem so the nav grows with the zoom level like its own labels do,
                but capped against the viewport: 16.25rem at 150% is 390px, wider
                than the phone this drawer is for. */}
            <DrawerContent
              showCloseButton={false}
              className="w-[min(16.25rem,85vw)] p-3"
            >
              <DrawerTitle className="sr-only">{t("title")}</DrawerTitle>
              {navContent}
            </DrawerContent>
          </Drawer>
        )}

        <section className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {children}
        </section>
      </div>
      <AppToaster position="bottom-right" closeButton duration={4000} />
    </div>
  )
}
