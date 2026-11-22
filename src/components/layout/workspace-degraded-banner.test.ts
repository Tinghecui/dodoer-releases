import { describe, expect, it } from "vitest"
import * as banner from "@/components/layout/workspace-degraded-banner"

type BannerState = { degraded: boolean; health: string }
const shouldShow = (
  banner as unknown as {
    shouldShowWorkspaceDegradedBanner?: (s: BannerState) => boolean
  }
).shouldShowWorkspaceDegradedBanner

describe("shouldShowWorkspaceDegradedBanner (#1279)", () => {
  it("shows the banner when the watcher fell back to polling", () => {
    expect(shouldShow?.({ degraded: true, health: "healthy" })).toBe(true)
  })

  it("shows the banner when starting the live stream failed", () => {
    // 订阅启动失败：后端没报 degraded，但 health 是 degraded、带出错说明，
    // 实时更新同样不可用，顶部提示条也要在。
    expect(shouldShow?.({ degraded: false, health: "degraded" })).toBe(true)
  })

  it("hides the banner while healthy or resyncing", () => {
    expect(shouldShow?.({ degraded: false, health: "healthy" })).toBe(false)
    expect(shouldShow?.({ degraded: false, health: "resyncing" })).toBe(false)
  })
})
