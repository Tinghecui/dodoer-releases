import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

import { AppToaster } from "./app-toaster"
import {
  isNativeSurfaceOccluded,
  isNativeSurfaceOcclusionPassive,
  requestNativeSurfaceReclaim,
  resetNativeSurfaceOcclusionForTests,
} from "@/lib/browser/native-surface-occlusion"

/**
 * Sonner removes a dismissed toast with a `setState` 200ms later
 * (`TIME_BEFORE_UNMOUNT`). Left pending, that timer can fire after the file's
 * jsdom environment is torn down — `window is not defined` from react-dom,
 * which vitest reports as an unhandled error and fails the whole shard (seen
 * on a busy self-hosted runner). Dismiss and let it run while still mounted.
 */
async function settleToasts() {
  toast.dismiss()
  await act(() => new Promise((resolve) => setTimeout(resolve, 250)))
}

/**
 * The toaster must live in the BODY, not where it is mounted. Every dialog
 * portals to the body at z-50, while the workspace shell's root is
 * `fixed inset-0` — a stacking context that would cap sonner's z-index no
 * matter how large it is. A toast raised from an open dialog (the error that
 * explains why a button did nothing) painted underneath it.
 */
describe("AppToaster", () => {
  afterEach(settleToasts)

  it("mounts the toaster on the body rather than in the tree that renders it", async () => {
    const { container } = render(
      <div id="shell" className="fixed inset-0">
        <AppToaster position="bottom-right" />
      </div>
    )

    // Sonner's own container is not inside the (stacking-context-forming)
    // shell that rendered it…
    expect(container.querySelector("section[aria-live='polite']")).toBeNull()

    toast.error("project folder is on 'feature'")
    const message = await screen.findByText("project folder is on 'feature'")
    // …and neither is the toast it raises.
    expect(container.contains(message)).toBe(false)
    expect(message.closest("#shell")).toBeNull()
    expect(document.body.contains(message)).toBe(true)
  })
})

/**
 * A toast raised over a built-in browser tab is not behind the page in any
 * way a z-index could fix: a child webview is a native view painted above
 * every DOM element of the window. The toaster therefore holds a passive
 * occlusion lease for as long as a toast is on screen — see
 * `native-surface-occlusion` for what the hosts do with "passive".
 */
describe("AppToaster occlusion", () => {
  beforeEach(() => {
    toast.dismiss()
    resetNativeSurfaceOcclusionForTests()
  })
  afterEach(async () => {
    await settleToasts()
    resetNativeSurfaceOcclusionForTests()
  })

  it("holds the browser surfaces down while a toast is on screen", async () => {
    render(<AppToaster position="bottom-right" />)
    expect(isNativeSurfaceOccluded()).toBe(false)

    const id = toast.error("the folder moved")
    await screen.findByText("the folder moved")
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(true))
    // Passive: nobody opened this, so the page keeps the keyboard and gets a
    // say in how long it lasts.
    expect(isNativeSurfaceOcclusionPassive()).toBe(true)

    await act(async () => {
      toast.dismiss(id)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(false))
  })

  it("takes the toasts away when a page is reached for", async () => {
    render(<AppToaster position="bottom-right" />)
    toast.message("a background task finished")
    await screen.findByText("a background task finished")
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(true))

    await act(async () => {
      requestNativeSurfaceReclaim()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(false))
  })
})

/**
 * 手机布局下提示条放到顶部居中，并让出刘海的安全区：右下角在手机上正好是
 * 输入框和发送按钮，横条也在那里。桌面布局还是调用方给的位置。
 */
describe("AppToaster on the mobile layout", () => {
  const realMatchMedia = window.matchMedia
  function setMobile(mobile: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: mobile && query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
  afterEach(async () => {
    await settleToasts()
    window.matchMedia = realMatchMedia
  })

  async function toasterFor(text: string) {
    toast.message(text)
    await screen.findByText(text)
    return document.querySelector<HTMLElement>("ol[data-sonner-toaster]")!
  }

  it("shows toasts top-center clear of the safe area on a phone", async () => {
    setMobile(true)
    render(<AppToaster position="bottom-right" />)
    const list = await toasterFor("saved on the phone")
    expect(list.dataset.yPosition).toBe("top")
    expect(list.dataset.xPosition).toBe("center")
    expect(list.style.getPropertyValue("--mobile-offset-top")).toContain(
      "env(safe-area-inset-top)"
    )
    expect(list.style.getPropertyValue("--offset-top")).toContain(
      "env(safe-area-inset-top)"
    )
  })

  it("keeps the caller's position on the desktop layout", async () => {
    setMobile(false)
    render(<AppToaster position="bottom-right" />)
    const list = await toasterFor("saved on the desktop")
    expect(list.dataset.yPosition).toBe("bottom")
    expect(list.dataset.xPosition).toBe("right")
    expect(list.style.getPropertyValue("--offset-top")).not.toContain(
      "safe-area"
    )
  })
})
