import { describe, expect, it } from "vitest"

import {
  LEFT_CHROME_BUTTONS,
  LEFT_CHROME_CLUSTER,
  MAC_TRAFFIC_LIGHT_INSET,
  NO_LIGHTS_LEAD,
  RIGHT_CHROME_CLUSTER,
  WINDOW_CAPTION_WIDTH,
  leftCapsuleLeft,
  leftChromeButtonsWidth,
  leftChromeReserve,
  rightChromeClusterWidth,
  rightChromeReserve,
} from "./window-chrome"

// The app "zoom" scales the root font-size (rem), so the rem-sized chrome buttons
// grow with zoom. Their fixed-px containers must grow by the same factor or the
// buttons overflow/clip at high zoom (the 150% bug). These guard that only the
// DOM button CLUSTER scales, while the native insets (macOS traffic-light
// clearance, Windows/Linux caption strip) stay fixed.
describe("window-chrome zoom scaling", () => {
  it("defaults to 100% (no scaling) and matches the pre-zoom baseline", () => {
    // Four icon buttons, including the optional file-panel toggle.
    expect(rightChromeReserve(false)).toBe(RIGHT_CHROME_CLUSTER)
    expect(rightChromeReserve(true)).toBe(
      RIGHT_CHROME_CLUSTER + WINDOW_CAPTION_WIDTH
    )
    expect(rightChromeClusterWidth()).toBe(RIGHT_CHROME_CLUSTER)
    expect(leftChromeReserve(false)).toBe(LEFT_CHROME_CLUSTER)
    expect(leftChromeReserve(true)).toBe(
      MAC_TRAFFIC_LIGHT_INSET + LEFT_CHROME_CLUSTER
    )
  })

  it("scales only the button cluster at 150%, leaving native insets fixed", () => {
    // Glass capsules: 164 → 246, 101 → 152 (151.5 rounded).
    expect(rightChromeClusterWidth(150)).toBe(246)
    expect(rightChromeReserve(false, 150)).toBe(246)
    // Native caption strip stays 138.
    expect(rightChromeReserve(true, 150)).toBe(246 + WINDOW_CAPTION_WIDTH)
    // Native traffic-light inset stays 75; only the 101 cluster scales.
    expect(leftChromeReserve(false, 150)).toBe(152)
    expect(leftChromeReserve(true, 150)).toBe(MAC_TRAFFIC_LIGHT_INSET + 152)
  })

  it("measures the open-sidebar buttons up to their end", () => {
    // Without lights the buttons start 15px in from the pane (8 + 15 - 10
    // lead, then their own 10px padding).
    expect(leftChromeButtonsWidth(false)).toBe(
      NO_LIGHTS_LEAD + LEFT_CHROME_BUTTONS
    )
    expect(leftChromeButtonsWidth(true)).toBe(
      MAC_TRAFFIC_LIGHT_INSET + LEFT_CHROME_BUTTONS
    )
    // 58 → 87 at 150%; the traffic-light inset still does not scale.
    expect(leftChromeButtonsWidth(true, 150)).toBe(MAC_TRAFFIC_LIGHT_INSET + 87)
  })

  it("puts the collapsed capsule 14px after the lights (89px on macOS)", () => {
    expect(leftCapsuleLeft(true)).toBe(89)
    expect(leftCapsuleLeft(false)).toBe(14)
    expect(leftCapsuleLeft(true, 150)).toBe(MAC_TRAFFIC_LIGHT_INSET + 21)
  })

  it("scales the cluster down below 100% too and rounds to whole pixels", () => {
    // 164 * 0.9 = 147.6 → 148 (rounded).
    expect(rightChromeClusterWidth(90)).toBe(148)
    // 101 * 0.5 = 50.5 → 51, plus the fixed 75 inset.
    expect(leftChromeReserve(true, 50)).toBe(MAC_TRAFFIC_LIGHT_INSET + 51)
  })
})
