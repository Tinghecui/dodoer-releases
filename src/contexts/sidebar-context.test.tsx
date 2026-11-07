import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  SidebarProvider,
  resolveSidebarMinWidth,
  useSidebarContext,
} from "./sidebar-context"

const env = vi.hoisted(() => ({
  desktop: true,
  platform: "macos" as "macos" | "windows" | "linux" | "unknown",
}))

vi.mock("@/lib/platform", () => ({ isDesktop: () => env.desktop }))
vi.mock("@/hooks/use-platform", () => ({
  detectPlatform: () => env.platform,
}))

const STORAGE_KEY = "workspace:left-sidebar"

function Probe() {
  const ctx = useSidebarContext()
  return (
    <>
      <div data-testid="probe" data-min={ctx.minWidth} data-width={ctx.width} />
      {/* What a handle drag past either end asks for. */}
      <button type="button" onClick={() => ctx.setWidth(100)}>
        narrow
      </button>
      <button type="button" onClick={() => ctx.setWidth(1200)}>
        wide
      </button>
    </>
  )
}

function renderProvider() {
  render(
    <SidebarProvider>
      <Probe />
    </SidebarProvider>
  )
  const probe = screen.getByTestId("probe")
  return {
    min: () => Number(probe.dataset.min),
    width: () => Number(probe.dataset.width),
  }
}

describe("sidebar minimum width", () => {
  beforeEach(() => {
    localStorage.clear()
    env.desktop = true
    env.platform = "macos"
  })

  // The traffic lights sit at the header's far left on the macOS desktop app
  // only; elsewhere the minimum adds just the short lead before the toggle.
  it.each([
    ["the macOS desktop app", true, "macos", 317],
    ["the Windows desktop app", true, "windows", 250],
    ["the Linux desktop app", true, "linux", 250],
    ["a browser on macOS", false, "macos", 250],
    ["a browser on Windows", false, "windows", 250],
  ] as const)("is %s's own", (_label, desktop, platform, expected) => {
    env.desktop = desktop
    env.platform = platform
    expect(resolveSidebarMinWidth()).toBe(expected)
    expect(renderProvider().min()).toBe(expected)
  })

  it("grows the button room with the app zoom but not the traffic-light inset", () => {
    expect(resolveSidebarMinWidth(125)).toBe(303 + 75)
    env.platform = "windows"
    expect(resolveSidebarMinWidth(150)).toBe(363 + 12)
    expect(resolveSidebarMinWidth(80)).toBe(250)
  })

  it("lets a Windows sidebar keep a width under the macOS minimum", () => {
    env.platform = "windows"
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ isOpen: true, width: 280 })
    )
    const probe = renderProvider()
    expect(probe.width()).toBe(280)

    fireEvent.click(screen.getByRole("button", { name: "narrow" }))
    expect(probe.width()).toBe(250)
  })

  it("still clamps a macOS sidebar to the traffic-light minimum", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ isOpen: true, width: 280 })
    )
    const probe = renderProvider()
    expect(probe.width()).toBe(317)

    fireEvent.click(screen.getByRole("button", { name: "wide" }))
    expect(probe.width()).toBe(900)
  })
})
