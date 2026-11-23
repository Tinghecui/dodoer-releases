import { render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }))
const nav = vi.hoisted(() => ({ pathname: "/workspace" }))
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => nav.pathname,
}))

import { InPageRouterInit } from "./in-page-router-init"
import { navigateInPage, wasOpenedInPage } from "@/lib/in-page-navigation"

afterEach(() => vi.restoreAllMocks())

describe("InPageRouterInit（#1332）", () => {
  it("挂上以后在当前页打开走 Next 路由，卸下后不再用它", () => {
    const { unmount } = render(<InPageRouterInit />)
    navigateInPage("/settings/general")
    expect(router.push).toHaveBeenCalledWith("/settings/general")

    unmount()
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      assign,
    } as unknown as Location)
    navigateInPage("/stash?folderId=1")
    expect(router.push).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith("/stash?folderId=1")
  })

  it("浏览器后退回工作区、再前进回新建项目页，还认得出是在当前页打开的", () => {
    nav.pathname = "/project-boot"
    const { rerender, unmount } = render(<InPageRouterInit />)
    navigateInPage("/project-boot")

    nav.pathname = "/workspace"
    window.history.replaceState({}, "", "/workspace")
    rerender(<InPageRouterInit />)

    nav.pathname = "/project-boot"
    window.history.replaceState({}, "", "/project-boot")
    rerender(<InPageRouterInit />)
    expect(wasOpenedInPage()).toBe(true)
    unmount()
    navigateInPage("/workspace")
    window.history.replaceState({}, "", "/")
  })
})
