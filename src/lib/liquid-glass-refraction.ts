/**
 * Liquid Glass refraction layer (Chromium only).
 *
 * Each glass element of a given size gets an SVG filter that BENDS the content
 * behind its rim inward (a convex lens) and only then blurs it — bend first,
 * blur second, or the rim would only bend an already-frosted smear. The filter
 * is applied through `backdrop-filter: url(#id)`, which only Chromium supports;
 * Safari drops a whole `backdrop-filter` declaration that contains `url()`
 * (WebKit bug 245510), so the CSS that reads `--f` sits behind
 * `@supports (-webkit-app-region: drag)` in liquid-glass.css, and the material
 * layer (blur + saturate + rim + shadow) stays everywhere else.
 *
 * The maths is the design page's (handoff appendix A, after kube.io's
 * write-up): a convex squircle height profile h(t) = (1 - (1 - t)^4)^(1/4),
 * Snell's law with n = 1.5, the strength normalised to 0..1 and pointed
 * inward. R and G of the displacement map hold the x/y offset around 128.
 * One map per size; elements of the same size share a filter.
 */

export type GlassKind = "ctl" | "pane"

/** Blur of the frosted middle and of the bent rim, per material (px). */
const KIND = {
  ctl: { frost: 3.5, rim: 1 },
  pane: { frost: 12, rim: 1.5 },
} as const

const SVG_NS = "http://www.w3.org/2000/svg"
const DEFS_ID = "codeg-liquid-glass-defs"

let profileCache: Float64Array | null = null

/** Refraction strength from the rim (t=0) to the flat top (t=1), 0..1. */
function profile(n = 1.5, steps = 512): Float64Array {
  if (profileCache) return profileCache
  const h = (t: number) => Math.pow(1 - Math.pow(1 - t, 4), 0.25)
  const out = new Float64Array(steps + 1)
  let max = 0
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(Math.max(i / steps, 1e-3), 1)
    const e = 1e-4
    const lo = Math.max(t - e, 0)
    const hi = Math.min(t + e, 1)
    const slope = (h(hi) - h(lo)) / (hi - lo)
    const th = Math.atan(slope)
    const dev = th - Math.asin(Math.sin(th) / n)
    out[i] = (0.35 + h(t)) * Math.tan(dev)
    if (out[i] > max) max = out[i]
  }
  for (let i = 0; i <= steps; i++) out[i] /= max
  profileCache = out
  return out
}

/** Rim width (bezel) and largest offset for a glass of this size. */
export function lensGeometry(
  w: number,
  h: number,
  kind: GlassKind
): { bezel: number; offset: number } {
  const m = Math.min(w, h)
  if (kind === "pane") {
    return {
      bezel: Math.max(1, Math.min(18, Math.round(m / 2) - 1)),
      offset: 12,
    }
  }
  const bezel = Math.max(8, Math.min(16, Math.round(m * 0.36)))
  return { bezel, offset: Math.max(6, Math.round(bezel * 0.75)) }
}

/** The displacement map as RGBA bytes (exported for tests). */
export function displacementPixels(
  w: number,
  h: number,
  r: number,
  bezel: number
): Uint8ClampedArray {
  const prof = profile()
  const buf = new Uint8ClampedArray(w * h * 4)
  const hw = w / 2
  const hh = h / 2
  const rr = Math.min(r, hw, hh)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw
      const py = y + 0.5 - hh
      const qx = Math.abs(px) - (hw - rr)
      const qy = Math.abs(py) - (hh - rr)
      let sdf: number
      let nx: number
      let ny: number
      if (qx > 0 && qy > 0) {
        const l = Math.hypot(qx, qy)
        sdf = l - rr
        nx = (qx / l) * Math.sign(px)
        ny = (qy / l) * Math.sign(py)
      } else if (qx > qy) {
        sdf = qx - rr
        nx = Math.sign(px)
        ny = 0
      } else {
        sdf = qy - rr
        nx = 0
        ny = Math.sign(py)
      }
      const d = -sdf
      let vx = 0
      let vy = 0
      if (d > 0 && d < bezel) {
        const m = prof[Math.round((d / bezel) * (prof.length - 1))]
        vx = -nx * m
        vy = -ny * m
      }
      const i = (y * w + x) * 4
      buf[i] = Math.round(128 + 127 * vx)
      buf[i + 1] = Math.round(128 + 127 * vy)
      buf[i + 2] = 128
      buf[i + 3] = 255
    }
  }
  return buf
}

function displacementDataUrl(
  w: number,
  h: number,
  r: number,
  bezel: number
): string | null {
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  const image = ctx.createImageData(w, h)
  image.data.set(displacementPixels(w, h, r, bezel))
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL("image/png")
}

/** Whether this engine applies `backdrop-filter: url()` (Chromium only). */
export function refractionSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("-webkit-app-region", "drag") &&
    typeof document !== "undefined"
  )
}

interface Registered {
  id: string
  refs: number
  node: SVGFilterElement
}

const registry = new Map<string, Registered>()
let nextId = 0

function defsRoot(): SVGDefsElement {
  let svg = document.getElementById(DEFS_ID) as SVGSVGElement | null
  if (!svg) {
    svg = document.createElementNS(SVG_NS, "svg")
    svg.id = DEFS_ID
    svg.setAttribute("aria-hidden", "true")
    svg.setAttribute("width", "0")
    svg.setAttribute("height", "0")
    svg.style.position = "absolute"
    svg.style.width = "0"
    svg.style.height = "0"
    svg.style.pointerEvents = "none"
    svg.appendChild(document.createElementNS(SVG_NS, "defs"))
    document.body.appendChild(svg)
  }
  return svg.querySelector("defs") as SVGDefsElement
}

function el(name: string, attrs: Record<string, string | number>): Element {
  const node = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

function buildFilter(
  id: string,
  w: number,
  h: number,
  r: number,
  kind: GlassKind
): SVGFilterElement | null {
  const { bezel, offset } = lensGeometry(w, h, kind)
  const { frost, rim } = KIND[kind]
  const map = displacementDataUrl(w, h, r, bezel)
  if (!map) return null
  const filter = el("filter", {
    id,
    x: 0,
    y: 0,
    width: w,
    height: h,
    filterUnits: "userSpaceOnUse",
    primitiveUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
  }) as SVGFilterElement
  filter.appendChild(
    el("feImage", {
      href: map,
      x: 0,
      y: 0,
      width: w,
      height: h,
      preserveAspectRatio: "none",
      result: "m",
    })
  )
  filter.appendChild(
    el("feDisplacementMap", {
      in: "SourceGraphic",
      in2: "m",
      scale: offset * 2,
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: "bent",
    })
  )
  filter.appendChild(
    el("feGaussianBlur", {
      in: "bent",
      stdDeviation: rim,
      edgeMode: "duplicate",
      result: "rim",
    })
  )
  filter.appendChild(
    el("feGaussianBlur", {
      in: "SourceGraphic",
      stdDeviation: frost,
      edgeMode: "duplicate",
      result: "frost",
    })
  )
  const transfer = el("feComponentTransfer", { in: "m", result: "mag" })
  transfer.appendChild(el("feFuncR", { type: "table", tableValues: "1 0 1" }))
  transfer.appendChild(el("feFuncG", { type: "table", tableValues: "1 0 1" }))
  filter.appendChild(transfer)
  filter.appendChild(
    el("feColorMatrix", {
      in: "mag",
      type: "matrix",
      values: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 4 4 0 0 0",
      result: "k",
    })
  )
  filter.appendChild(
    el("feComposite", { in: "rim", in2: "k", operator: "in", result: "rk" })
  )
  filter.appendChild(
    el("feComposite", { in: "rk", in2: "frost", operator: "over" })
  )
  return filter
}

/**
 * Register (or share) the filter for a glass of this size; returns its key
 * and the `url(#id)` to put on `--f`, or null when unsupported.
 */
export function acquireLens(
  w: number,
  h: number,
  r: number,
  kind: GlassKind
): { key: string; url: string } | null {
  if (w < 4 || h < 4) return null
  const rw = Math.round(w)
  const rh = Math.round(h)
  const rr = Math.round(r)
  const key = `${rw}x${rh}r${rr}${kind}`
  let entry = registry.get(key)
  if (!entry) {
    const id = `codeg-lg-${nextId++}`
    const node = buildFilter(id, rw, rh, rr, kind)
    if (!node) return null
    defsRoot().appendChild(node)
    entry = { id, refs: 0, node }
    registry.set(key, entry)
  }
  entry.refs += 1
  return { key, url: `url(#${entry.id})` }
}

export function releaseLens(key: string): void {
  const entry = registry.get(key)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) {
    entry.node.remove()
    registry.delete(key)
  }
}

/** How long a size has to hold still before its refraction is (re)built. */
const SETTLE_MS = 160

/**
 * Keep `--f` on `element` in step with its size. While it resizes (an
 * animated composer, a dragged sidebar) the element shows the material layer
 * only; once it has held still it gets the filter for its new size. Returns a
 * disposer.
 */
export function attachRefraction(
  element: HTMLElement,
  kind: GlassKind,
  radius?: number
): () => void {
  if (!refractionSupported() || typeof ResizeObserver === "undefined") {
    return () => {}
  }
  let current: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastW = 0
  let lastH = 0

  const clear = () => {
    if (current) releaseLens(current)
    current = null
    element.style.removeProperty("--f")
  }

  const apply = () => {
    timer = null
    const rect = element.getBoundingClientRect()
    // Layout size, not the transformed box: a scaled ancestor would otherwise
    // build a map for the wrong number of pixels.
    const w = element.offsetWidth || rect.width
    const h = element.offsetHeight || rect.height
    const r =
      radius ??
      (Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0)
    const lens = acquireLens(w, h, r, kind)
    clear()
    if (lens) {
      current = lens.key
      element.style.setProperty("--f", lens.url)
    }
  }

  const observer = new ResizeObserver(() => {
    const w = element.offsetWidth
    const h = element.offsetHeight
    if (w === lastW && h === lastH && current) return
    const first = lastW === 0 && lastH === 0
    lastW = w
    lastH = h
    if (!first) clear()
    if (timer) clearTimeout(timer)
    timer = setTimeout(apply, first ? 0 : SETTLE_MS)
  })
  observer.observe(element)

  return () => {
    observer.disconnect()
    if (timer) clearTimeout(timer)
    clear()
  }
}
