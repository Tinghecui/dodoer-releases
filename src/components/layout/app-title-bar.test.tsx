import { act, render, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppTitleBar } from "./app-title-bar"
import { useIsMac } from "@/hooks/use-is-mac"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }))

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

function stubNavigator(userAgent: string, platform: string, touch: number) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    get: () => touch,
  })
}

// usePlatform 在下一帧才读 UA：等这一帧跑完、状态更新落地
async function flushFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
}

function setWindowGlobals(globals: Record<string, unknown>) {
  const w = window as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(globals)) w[k] = v
}

// 标题栏里给 Mac 红绿灯留的左边空白
function hasTrafficLightInset(container: HTMLElement): boolean {
  return container.querySelector(".pl-\\[92px\\]") !== null
}

describe("AppTitleBar：iOS 不留红绿灯空白", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    const w = window as unknown as Record<string, unknown>
    delete w.__TAURI_INTERNALS__
    delete w.__CODEG_SHELL__
    delete (navigator as unknown as Record<string, unknown>).maxTouchPoints
  })

  it("iPhone 上（即使有 Tauri 注入）不留空白", async () => {
    stubNavigator(IPHONE_UA, "iPhone", 5)
    setWindowGlobals({ __TAURI_INTERNALS__: { invoke: () => {} } })
    const { container } = render(<AppTitleBar left="x" />)
    await flushFrame()
    expect(hasTrafficLightInset(container)).toBe(false)
  })

  it("iOS 壳里（有标记加 Tauri 注入）不留空白", async () => {
    stubNavigator(MAC_UA, "MacIntel", 0)
    setWindowGlobals({
      __TAURI_INTERNALS__: { invoke: () => {} },
      __CODEG_SHELL__: "ios",
    })
    const { container } = render(<AppTitleBar left="x" />)
    await flushFrame()
    expect(hasTrafficLightInset(container)).toBe(false)
  })

  it("Mac 桌面版仍留空白", async () => {
    stubNavigator(MAC_UA, "MacIntel", 0)
    setWindowGlobals({ __TAURI_INTERNALS__: { invoke: () => {} } })
    const { container } = render(<AppTitleBar left="x" />)
    await waitFor(() => expect(hasTrafficLightInset(container)).toBe(true))
  })

  it("iOS 上快捷键提示不用 ⌘", async () => {
    stubNavigator(IPHONE_UA, "iPhone", 5)
    const { result } = renderHook(() => useIsMac())
    await flushFrame()
    expect(result.current).toBe(false)
    expect(formatShortcutLabel("mod+k", result.current)).not.toContain("⌘")
  })
})
