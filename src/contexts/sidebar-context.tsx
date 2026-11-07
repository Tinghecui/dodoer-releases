"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { AppearanceContext } from "@/components/appearance-provider"
import { detectPlatform } from "@/hooks/use-platform"
import {
  loadPersistedPanelState,
  savePersistedPanelState,
} from "@/lib/panel-state-storage"
import { isDesktop } from "@/lib/platform"
import { MAC_TRAFFIC_LIGHT_INSET, NO_LIGHTS_LEAD } from "@/lib/window-chrome"

const STORAGE_KEY = "workspace:left-sidebar"

const DEFAULT_WIDTH = 320
// The sidebar header is the window's top-left edge: its top-left is reserved
// for the fixed window-chrome overlay (sidebar toggle + search) and its
// top-right holds the view controls, so it needs more room than the old 200.
// jenny fork: 242 — the header's one row also holds the bell with its two
// counts. Measured from where the traffic lights (or the no-lights lead) end:
// toggle + search (58), the bell with two "99+" counts (88), locate / expand /
// view options (3 × 24 + 2 × 2), the 2px gaps between them, the header's 8px
// right padding and the 8px gutter right of the pane (the pane inset on the
// left is already in the reserve).
const BASE_MIN_WIDTH = 242
const MAX_WIDTH = 900
const DEFAULT_IS_OPEN = true

/**
 * The narrowest the sidebar may be dragged. On the macOS desktop app the native
 * traffic lights sit at the header's far left, ahead of the chrome overlay, so
 * only there does the minimum add their inset (242 + 75 = 317). Windows, Linux
 * and the browser have no traffic lights, only the short lead before the
 * toggle (242 + 8 = 250): sized for the lights anyway, the column bottomed out
 * wider than anything in it needs. Both minimums leave the header the same
 * room for the overlay and the view controls.
 *
 * `zoom` (percent) scales the base and the lead: the header's buttons are
 * rem-sized and grow with the app zoom, while the native traffic-light inset
 * does not. So the
 * header stays one row at every zoom, and the minimum grows only as much as
 * its buttons do.
 */
export function resolveSidebarMinWidth(zoom = 100): number {
  const macTrafficLights = isDesktop() && detectPlatform() === "macos"
  const scale = (px: number) => Math.round((px * Math.max(zoom, 100)) / 100)
  return (
    scale(BASE_MIN_WIDTH) +
    (macTrafficLights ? MAC_TRAFFIC_LIGHT_INSET : scale(NO_LIGHTS_LEAD))
  )
}

interface SidebarContextValue {
  isOpen: boolean
  restored: boolean
  width: number
  minWidth: number
  maxWidth: number
  toggle: () => void
  setWidth: (w: number) => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export function useSidebarContext() {
  const ctx = useContext(SidebarContext)
  if (!ctx) {
    throw new Error("useSidebarContext must be used within SidebarProvider")
  }
  return ctx
}

function clampWidth(width: number, minWidth: number) {
  return Math.max(minWidth, Math.min(MAX_WIDTH, width))
}

interface SidebarProviderProps {
  children: ReactNode
}

export function SidebarProvider({ children }: SidebarProviderProps) {
  const storageKey = STORAGE_KEY
  const [isOpen, setIsOpen] = useState(DEFAULT_IS_OPEN)
  const [width, setWidthState] = useState(DEFAULT_WIDTH)
  const [restored, setRestored] = useState(false)
  // Platform- and zoom-derived minimum (see resolveSidebarMinWidth). Read the
  // context directly so the provider also works without appearance settings.
  const zoom = useContext(AppearanceContext)?.zoomLevel ?? 100
  const minWidth = useMemo(() => resolveSidebarMinWidth(zoom), [zoom])

  const toggle = useCallback(() => setIsOpen((prev) => !prev), [])

  const setWidth = useCallback(
    (w: number) => {
      setWidthState(clampWidth(w, minWidth))
    },
    [minWidth]
  )

  useEffect(() => {
    const stored = loadPersistedPanelState(storageKey)
    // On mobile (< 768px), always start closed regardless of persisted state.
    const isMobileViewport = window.innerWidth < 768
    const defaultOpen = isMobileViewport ? false : DEFAULT_IS_OPEN
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOpen(isMobileViewport ? false : (stored?.isOpen ?? defaultOpen))
    setWidthState(clampWidth(stored?.width ?? DEFAULT_WIDTH, minWidth))
    setRestored(true)
  }, [storageKey, minWidth])

  useEffect(() => {
    if (!restored) return
    savePersistedPanelState(storageKey, { isOpen, width })
  }, [isOpen, restored, storageKey, width])

  const value = useMemo(
    () => ({
      isOpen,
      restored,
      width,
      minWidth,
      maxWidth: MAX_WIDTH,
      toggle,
      setWidth,
    }),
    [isOpen, restored, width, minWidth, toggle, setWidth]
  )

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  )
}
