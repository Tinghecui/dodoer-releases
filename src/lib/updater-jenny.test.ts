import { describe, expect, it } from "vitest"
import { isJennyForkVersion } from "./updater"

describe("isJennyForkVersion", () => {
  it("recognizes fork builds", () => {
    expect(isJennyForkVersion("0.33.0-jenny.1")).toBe(true)
    expect(isJennyForkVersion("1.0.0-jenny")).toBe(true)
  })

  it("leaves official versions alone", () => {
    expect(isJennyForkVersion("0.33.0")).toBe(false)
    expect(isJennyForkVersion("0.33.0-rc.2")).toBe(false)
    expect(isJennyForkVersion("0.33.0-jennyfoo")).toBe(false)
  })
})
