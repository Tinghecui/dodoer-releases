import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Drawer, DrawerContent, DrawerTitle } from "./drawer"
import { SIDE_DRAWER_SAFE_AREA_CLASS } from "./drawer-safe-area"

describe("SIDE_DRAWER_SAFE_AREA_CLASS", () => {
  it("每一边的边距至少是对应的安全区，没有安全区时还是 8px", () => {
    const classes = SIDE_DRAWER_SAFE_AREA_CLASS.split(/\s+/)
    for (const [side, edge] of [
      ["mt", "top"],
      ["mb", "bottom"],
      ["ml", "left"],
      ["mr", "right"],
    ]) {
      expect(classes).toContain(
        `${side}-[max(0.5rem,env(safe-area-inset-${edge}))]`
      )
    }
  })

  it("合进抽屉的类名后四边的安全区边距都留着", () => {
    render(
      <Drawer open swipeDirection="left">
        <DrawerContent className={SIDE_DRAWER_SAFE_AREA_CLASS}>
          <DrawerTitle>Sidebar</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    const popup = document.querySelector("[data-slot='drawer-popup']")
    expect(popup).not.toBeNull()
    for (const edge of ["top", "bottom", "left", "right"]) {
      expect(popup!.className).toContain(`env(safe-area-inset-${edge})`)
    }
  })
})
