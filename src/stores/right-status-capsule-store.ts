import { create } from "zustand"

/**
 * jenny fork: how wide the status capsule (the right half of the status bar)
 * is while it sits in the window's top-right corner, beside the window
 * buttons, gap included; 0 while it is not there (the aux panel is open and
 * holds it at its foot). The top strips under that corner add it to their
 * right reserve, so tabs and titles stop before the capsule.
 */
interface RightStatusCapsuleState {
  width: number
  setWidth: (width: number) => void
}

export const useRightStatusCapsuleStore = create<RightStatusCapsuleState>(
  (set) => ({
    width: 0,
    setWidth: (width) => set({ width: Math.max(0, Math.round(width)) }),
  })
)

export function useRightStatusCapsuleWidth(): number {
  return useRightStatusCapsuleStore((s) => s.width)
}
