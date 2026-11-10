import { beforeEach, describe, expect, it } from "vitest"
import {
  MAIN_WINDOW_VIEW_KEY,
  initialMainWindowView,
  readMainWindowView,
  rememberMainWindowView,
} from "./start-page"

beforeEach(() => localStorage.clear())

describe("initialMainWindowView", () => {
  it("has only the start page without a local daemon", () => {
    expect(initialMainWindowView(false, "local", 0)).toBe("start")
    expect(initialMainWindowView(false, null, null)).toBe("start")
  })

  it("follows what was remembered", () => {
    expect(initialMainWindowView(true, "local", 3)).toBe("local")
    expect(initialMainWindowView(true, "start", 0)).toBe("start")
    expect(initialMainWindowView(true, "start", null)).toBe("start")
  })

  it("with nothing remembered, asks for the saved servers", () => {
    expect(initialMainWindowView(true, null, null)).toBeNull()
    expect(initialMainWindowView(true, null, 1)).toBe("start")
    expect(initialMainWindowView(true, null, 0)).toBe("local")
  })
})

describe("the remembered view", () => {
  it("round-trips and ignores what it does not know", () => {
    expect(readMainWindowView()).toBeNull()
    rememberMainWindowView("start")
    expect(readMainWindowView()).toBe("start")
    expect(localStorage.getItem(MAIN_WINDOW_VIEW_KEY)).toBe("start")
    rememberMainWindowView("local")
    expect(readMainWindowView()).toBe("local")
    localStorage.setItem(MAIN_WINDOW_VIEW_KEY, "remote")
    expect(readMainWindowView()).toBeNull()
  })
})
