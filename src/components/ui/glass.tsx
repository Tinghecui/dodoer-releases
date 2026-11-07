"use client"

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type HTMLAttributes,
  type RefObject,
} from "react"
import { attachRefraction, type GlassKind } from "@/lib/liquid-glass-refraction"
import { cn } from "@/lib/utils"

/**
 * Glass materials (handoff 6.3): `ctl` = small glass for controls (toolbar
 * buttons, the window-button capsule, scroll-to-bottom, the collapsed
 * composer, status capsules, live stats); `pane` = large glass for panels
 * (sidebar, aux panel, permission card, composer, menus and popovers).
 */
export type GlassMaterial = GlassKind

/** The `className` that turns an element into glass of this material. */
export function glassClassName({
  material = "ctl",
  edge = false,
  interactive = false,
}: {
  material?: GlassMaterial
  edge?: boolean
  interactive?: boolean
} = {}): string {
  return cn(
    "lg",
    material === "pane" && "lg-pane",
    edge && "lg-edge",
    interactive && "lg-ia"
  )
}

/**
 * jenny fork: the card family — the sidebar, the composer, the top-right
 * corner capsule and the Apps list share one solid fill, a raised rim (a
 * bright inner line and a hairline outside) and a soft floating shadow, no
 * glass (see `.lg-raised`). Goes on an element that is already glass.
 */
export const GLASS_RAISED_CARD_CLASS = "lg-card lg-raised"

/** The composer's (and the Apps list's) card: the same, with a slightly
 *  firmer outer line. */
export const GLASS_CARD_CLASS = "lg-card lg-raised lg-raised-firm"

/**
 * Give an element that already carries the glass classes its Chromium
 * refraction: sized by a ResizeObserver, rebuilt once a resize settles. A
 * no-op on Safari / Firefox / the macOS desktop app, which keep the material
 * layer only. `radius` overrides the element's computed corner radius.
 */
export function useGlassRefraction(
  ref: RefObject<HTMLElement | null>,
  material: GlassMaterial,
  { enabled = true, radius }: { enabled?: boolean; radius?: number } = {}
): void {
  useEffect(() => {
    const element = ref.current
    if (!enabled || !element) return
    return attachRefraction(element, material, radius)
  }, [ref, material, enabled, radius])
}

export interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  material?: GlassMaterial
  /** Corner radius in px; omitted = whatever the className sets. */
  radius?: number
  /** Edge-to-edge glass for the aux panel (handoff erratum E6): no radius,
   *  no specular ring, light only along its leading edge. */
  edge?: boolean
  /** Hover light from the pointer, icons shrink to 92% on press. */
  interactive?: boolean
  /** Skip the Chromium refraction (material layer only). */
  noRefraction?: boolean
}

/**
 * A piece of Liquid Glass. Only things that float over content are glass, and
 * glass never nests: controls placed on it use the plain `.lg-ib` look (gray
 * hover / selected), not another `<Glass>`.
 */
export const Glass = forwardRef<HTMLDivElement, GlassProps>(function Glass(
  {
    material = "ctl",
    radius,
    edge = false,
    interactive = false,
    noRefraction = false,
    className,
    style,
    ...props
  },
  forwardedRef
) {
  const ref = useRef<HTMLDivElement>(null)
  useImperativeHandle(forwardedRef, () => ref.current as HTMLDivElement)
  useGlassRefraction(ref, material, {
    enabled: !noRefraction,
    radius: edge ? 0 : radius,
  })
  return (
    <div
      ref={ref}
      data-glass={material}
      className={cn(glassClassName({ material, edge, interactive }), className)}
      style={
        radius !== undefined && !edge
          ? { borderRadius: radius, ...style }
          : style
      }
      {...props}
    />
  )
})
