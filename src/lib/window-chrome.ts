/**
 * Shared geometry for the desktop window-chrome corner overlays.
 *
 * The sidebar toggle / search (top-left) and terminal / aux / settings
 * (top-right) clusters are pinned to fixed overlays at the window's corners so
 * they never move — and never re-mount — when the side panels open or close
 * (that re-parenting is what used to make them flicker). Because the overlays
 * float ABOVE whichever column owns that edge, the column must reserve exactly
 * the overlay's width so its tabs / content never render underneath. Keeping the
 * overlay width and the column reservation in one place guarantees they agree.
 */

/**
 * Liquid Glass geometry (handoff 6.2 / 6.6 / erratum E5). The sidebar is a
 * floating glass pane 8px in from the window edges whose 46px header holds the
 * macOS traffic lights; the lights stay put whether the sidebar is open or
 * not (their position is set in Rust, `workspace_window_traffic_light_position`:
 * left edge at x 23, centre at y 31). Open, the sidebar toggle + search sit on
 * the pane right after the lights; collapsed, they become a 72x32 glass
 * capsule right of the lights, centred on the same line.
 */
export const GLASS_PANE_INSET = 8

/**
 * Where the native macOS traffic lights END (x 23 + three 12px lights with
 * 8px gaps = 75). Everything the left overlay draws starts right of this.
 */
export const MAC_TRAFFIC_LIGHT_INSET = 75

/**
 * Windows/Linux caption buttons (min / max / close) occupy the window's
 * top-right corner. Mirrors `WINDOW_CONTROLS_WIDTH` in window-controls.tsx; the
 * right cluster sits to their left.
 */
export const WINDOW_CAPTION_WIDTH = 138

/** Collapsed-sidebar capsule: 14px gap after the lights, 72 wide. */
export const LEFT_CAPSULE_GAP = 14
export const LEFT_CAPSULE_WIDTH = 72

/**
 * Left reserve while the sidebar is collapsed: the capsule plus the 15px the
 * top bar keeps after it (design: capsule at x 89, top bar from x 176).
 */
export const LEFT_CHROME_CLUSTER = LEFT_CAPSULE_GAP + LEFT_CAPSULE_WIDTH + 15

/**
 * jenny fork: the open sidebar header's icon buttons are 24px circles 2px
 * apart (glass drew 28px circles 4px apart, which read as gaps between the
 * 15px icons and forced a wide sidebar minimum). The collapsed capsule keeps
 * its 28px buttons.
 */
export const SIDEBAR_HEAD_BUTTON_SIZE = 24
export const SIDEBAR_HEAD_GAP = 2

/** Lead between the traffic lights (or the pane's edge) and the toggle. */
export const LEFT_CHROME_LEAD = 8

/**
 * Where the open sidebar's toggle + search END, measured from the lights' end
 * (mac) or the window edge: the lead, then two head buttons. The sidebar
 * header's own controls continue the row at the same 2px rhythm.
 */
export const LEFT_CHROME_BUTTONS =
  LEFT_CHROME_LEAD + 2 * SIDEBAR_HEAD_BUTTON_SIZE + SIDEBAR_HEAD_GAP

/**
 * Lead before the open sidebar's toggle when there are no traffic lights (web,
 * Windows, Linux): just the pane inset, so the toggle starts as far inside
 * the pane as the header's controls end from its right edge.
 */
export const NO_LIGHTS_LEAD = GLASS_PANE_INSET

/**
 * Right cluster: the window buttons' glass capsule (up to four 36px slots —
 * files, terminal, aux, settings), 12px from the window edge, plus 8px after
 * "More actions". Reserve the optional file toggle's slot even when empty to
 * keep the chrome stable.
 */
export const RIGHT_CHROME_SLOT = 36
export const RIGHT_CHROME_CLUSTER = 4 * RIGHT_CHROME_SLOT + 12 + 8

/**
 * Scale a DOM button-cluster width by the app's rem-based zoom.
 *
 * The app "zoom" scales the root font-size (`documentElement.style.fontSize =
 * 16 * zoom/100`, see AppearanceProvider), so the rem-sized chrome buttons
 * (`h-6 w-6`, `gap-1`, `pl-3`/`pr-3`) grow with zoom. Their containers must grow
 * by the same factor or the buttons overflow and get clipped at high zoom. The
 * NATIVE insets do NOT scale this way — the macOS traffic lights keep a constant
 * horizontal inset (only their Y shifts with zoom, see `traffic_light_position_at`
 * in commands/windows.rs) and the Windows/Linux caption buttons are fixed 46px
 * each — so callers add those separately, outside this helper.
 */
function scaleCluster(px: number, zoom: number): number {
  return Math.round((px * zoom) / 100)
}

/**
 * Width the window's left-edge column reserves for the left overlay.
 * `macInset` adds the traffic-light clearance (desktop macOS only); `zoom` (a
 * percent, default 100) scales the rem-sized button cluster to match the buttons
 * inside it, while the native traffic-light inset stays fixed.
 */
export function leftChromeReserve(macInset: boolean, zoom = 100): number {
  return (
    (macInset ? MAC_TRAFFIC_LIGHT_INSET : 0) +
    scaleCluster(LEFT_CHROME_CLUSTER, zoom)
  )
}

/**
 * The left overlay's OWN width: up to the end of its buttons (see
 * `LEFT_CHROME_BUTTONS`), plus the traffic-light clearance on desktop macOS.
 * The columns beneath still reserve the full `leftChromeReserve`, so the 16px
 * tail stays a drag region there; the overlay just no longer covers the open
 * sidebar header's controls that follow search.
 */
export function leftChromeButtonsWidth(macInset: boolean, zoom = 100): number {
  return (
    (macInset ? MAC_TRAFFIC_LIGHT_INSET : scaleCluster(NO_LIGHTS_LEAD, zoom)) +
    scaleCluster(LEFT_CHROME_BUTTONS, zoom)
  )
}

/** Left edge of the collapsed-sidebar capsule. */
export function leftCapsuleLeft(macInset: boolean, zoom = 100): number {
  return (
    (macInset ? MAC_TRAFFIC_LIGHT_INSET : 0) +
    scaleCluster(LEFT_CAPSULE_GAP, zoom)
  )
}

/**
 * Width the window's right-edge column reserves for the right overlay.
 * `winLinuxCaption` adds the native caption-button strip (desktop Win/Linux);
 * `zoom` (a percent, default 100) scales the rem-sized button cluster, while the
 * fixed native caption strip stays constant.
 */
export function rightChromeReserve(
  winLinuxCaption: boolean,
  zoom = 100
): number {
  return (
    scaleCluster(RIGHT_CHROME_CLUSTER, zoom) +
    (winLinuxCaption ? WINDOW_CAPTION_WIDTH : 0)
  )
}

/**
 * The right-edge overlay's OWN width — just the (zoom-scaled) button cluster.
 * The native caption strip isn't part of this box; it's cleared by the overlay's
 * `right` offset (see `FolderLayoutShell`), so only the cluster is measured here.
 */
export function rightChromeClusterWidth(zoom = 100): number {
  return scaleCluster(RIGHT_CHROME_CLUSTER, zoom)
}

/** Height of the conversation / file / route top bars (52px at 100%). */
export const GLASS_TOP_BAR_HEIGHT = "3.25rem"

/**
 * CSS variable telling a transcript how far its content starts below the top
 * of its scroller, because the top bar floats over it (0 when the group does
 * not touch the column's top edge, or when there is no top bar).
 */
export const GLASS_TOP_INSET_VAR = "--glass-top-inset"
