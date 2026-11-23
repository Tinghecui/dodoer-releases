import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { detectEnvironment, isIosShell } from "./detect"
import { isDesktop } from "./index"

describe("detectEnvironment", () => {
  // jsdom-provided `window` is the only global we tinker with. Snapshot the
  // original `__TAURI_INTERNALS__` (likely undefined) and restore in afterEach.
  let hadInternals: boolean
  let originalInternals: unknown

  beforeEach(() => {
    hadInternals = "__TAURI_INTERNALS__" in window
    originalInternals = (window as unknown as Record<string, unknown>)
      .__TAURI_INTERNALS__
  })

  afterEach(() => {
    const w = window as unknown as Record<string, unknown>
    if (hadInternals) {
      w.__TAURI_INTERNALS__ = originalInternals
    } else {
      delete w.__TAURI_INTERNALS__
    }
    delete w.__CODEG_SHELL__
  })

  it("returns 'web' by default in jsdom", () => {
    const w = window as unknown as Record<string, unknown>
    delete w.__TAURI_INTERNALS__
    expect(detectEnvironment()).toBe("web")
  })

  it("returns 'tauri' when __TAURI_INTERNALS__ is present", () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: () => {},
    }
    expect(detectEnvironment()).toBe("tauri")
  })

  // #1332：iOS 壳加载的是服务器自己的网页，界面要按网页版运行。
  describe("iOS 壳标记 __CODEG_SHELL__", () => {
    it("只有 Tauri 注入：桌面版，不是 iOS 壳", () => {
      const w = window as unknown as Record<string, unknown>
      w.__TAURI_INTERNALS__ = { invoke: () => {} }
      expect(isIosShell()).toBe(false)
      expect(isDesktop()).toBe(true)
      expect(detectEnvironment()).toBe("tauri")
    })

    it("有标记加 Tauri 注入：按网页版运行", () => {
      const w = window as unknown as Record<string, unknown>
      w.__TAURI_INTERNALS__ = { invoke: () => {} }
      w.__CODEG_SHELL__ = "ios"
      expect(isIosShell()).toBe(true)
      expect(isDesktop()).toBe(false)
      expect(detectEnvironment()).toBe("web")
    })

    it("什么都没有：网页版，不是 iOS 壳", () => {
      const w = window as unknown as Record<string, unknown>
      delete w.__TAURI_INTERNALS__
      expect(isIosShell()).toBe(false)
      expect(isDesktop()).toBe(false)
      expect(detectEnvironment()).toBe("web")
    })

    it("标记是别的值时不算 iOS 壳", () => {
      const w = window as unknown as Record<string, unknown>
      w.__TAURI_INTERNALS__ = { invoke: () => {} }
      w.__CODEG_SHELL__ = "android"
      expect(isIosShell()).toBe(false)
      expect(detectEnvironment()).toBe("tauri")
    })
  })
})
