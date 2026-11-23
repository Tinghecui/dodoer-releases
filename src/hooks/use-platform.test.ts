import { afterEach, describe, expect, it, vi } from "vitest"

import { detectPlatform } from "./use-platform"

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  macDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}

function stubNavigator(userAgent: string, platform: string, touch = 0) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)
  // jsdom 的 navigator 没有 maxTouchPoints，直接定义一个可删的
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    get: () => touch,
  })
}

describe("detectPlatform", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (navigator as unknown as Record<string, unknown>).maxTouchPoints
  })

  it("iPhone 认成 ios", () => {
    stubNavigator(UA.iphone, "iPhone", 5)
    expect(detectPlatform()).toBe("ios")
  })

  it("iPad 认成 ios", () => {
    stubNavigator(UA.ipad, "iPad", 5)
    expect(detectPlatform()).toBe("ios")
  })

  it("iPadOS 桌面模式（Macintosh UA 加多点触控）认成 ios", () => {
    stubNavigator(UA.macDesktop, "MacIntel", 5)
    expect(detectPlatform()).toBe("ios")
  })

  it("真 Mac 仍是 macos", () => {
    stubNavigator(UA.macDesktop, "MacIntel", 0)
    expect(detectPlatform()).toBe("macos")
  })

  it("Windows、Linux 不变", () => {
    stubNavigator(UA.windows, "Win32", 0)
    expect(detectPlatform()).toBe("windows")
    vi.restoreAllMocks()
    stubNavigator(UA.linux, "Linux x86_64", 0)
    expect(detectPlatform()).toBe("linux")
  })
})
