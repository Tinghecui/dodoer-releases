"use client"

import { createContext, useContext, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { create } from "zustand"

/**
 * jenny fork: a full-page route's own toolbar (the mind map's controls, an
 * app's address bar) drawn in the window-chrome strip, beside the route's
 * title, instead of as a second row under it.
 *
 * The desktop strip renders one `WorkbenchStripSlot`; a page wraps its toolbar
 * in `WorkbenchStripPortal` inside a `WorkbenchStripScope` that says whether
 * it is the one on screen. Without a slot (the phone's narrow strip, tests) or
 * outside a scope (a browser tab in the side panel) the toolbar stays where it
 * is.
 */
const useStripSlotStore = create<{
  slot: HTMLElement | null
  setSlot: (slot: HTMLElement | null) => void
}>((set) => ({
  slot: null,
  setSlot: (slot) => set({ slot }),
}))

const StripScope = createContext(false)

/** Whether toolbars below may move into the strip. */
export function WorkbenchStripScope({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  return <StripScope.Provider value={active}>{children}</StripScope.Provider>
}

/** The strip's toolbar area: the room between the title and the window's
 *  corner buttons. Its empty part still drags the window. */
export function WorkbenchStripSlot() {
  const setSlot = useStripSlotStore((s) => s.setSlot)
  return (
    <div
      ref={setSlot}
      data-tauri-drag-region
      data-workbench-strip-slot=""
      // A moved toolbar keeps its own row shape (`h-10`, a hairline under
      // it): the strip already is the row, so it takes the strip's height
      // and loses the line.
      className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 *:min-w-0 *:flex-1 *:border-b-0"
    />
  )
}

/** The strip a toolbar here moves into, or null when it stays put. */
export function useWorkbenchStripTarget(): HTMLElement | null {
  const active = useContext(StripScope)
  const slot = useStripSlotStore((s) => s.slot)
  return active ? slot : null
}

/** `children` in the strip when this page is the one on screen, else where
 *  they are. */
export function WorkbenchStripPortal({ children }: { children: ReactNode }) {
  const target = useWorkbenchStripTarget()
  return target ? createPortal(children, target) : <>{children}</>
}
