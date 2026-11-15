import type { ReactNode } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  /** The backend's switch, in memory only. */
  on: false,
  chromeEval: vi.fn(),
  chromeSetEval: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/browser/chrome-api", () => ({
  chromeEval: mocks.chromeEval,
  chromeSetEval: mocks.chromeSetEval,
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import {
  ChromeEvalPanelSwitch,
  ChromeEvalSetting,
  EVAL_KEY,
} from "./chrome-eval-switch"
import enMessages from "@/i18n/messages/en.json"

const SWITCH = "Let agents run code in tabs they may act on"

async function mount(ui: ReactNode) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {ui}
      </NextIntlClientProvider>
    )
  })
  return result
}

beforeEach(() => {
  localStorage.clear()
  mocks.on = false
  mocks.chromeEval.mockReset().mockImplementation(async () => mocks.on)
  mocks.chromeSetEval.mockReset().mockImplementation(async (on: boolean) => {
    mocks.on = on
    return on
  })
  mocks.toast.error.mockReset()
})

describe("ChromeEvalSetting", () => {
  it("is off until the person turns it on, and says what it risks", async () => {
    await mount(<ChromeEvalSetting />)
    const toggle = screen.getByRole("switch", { name: SWITCH })
    expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(mocks.chromeSetEval).not.toHaveBeenCalled()
    expect(screen.getByText(/sign-in details/)).toBeInTheDocument()
    expect(screen.getByText(/do anything there as you/)).toBeInTheDocument()
  })

  it("turns it on in the backend and remembers it", async () => {
    await mount(<ChromeEvalSetting />)
    await userEvent.click(screen.getByRole("switch", { name: SWITCH }))
    expect(mocks.chromeSetEval).toHaveBeenLastCalledWith(true)
    expect(localStorage.getItem(EVAL_KEY)).toBe("1")
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute(
      "aria-checked",
      "true"
    )

    await userEvent.click(screen.getByRole("switch", { name: SWITCH }))
    expect(mocks.chromeSetEval).toHaveBeenLastCalledWith(false)
    expect(localStorage.getItem(EVAL_KEY)).toBe("0")
  })

  it("hands a remembered switch back to the backend after a restart", async () => {
    localStorage.setItem(EVAL_KEY, "1")
    await mount(<ChromeEvalSetting />)
    expect(mocks.chromeSetEval).toHaveBeenCalledWith(true)
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute(
      "aria-checked",
      "true"
    )
  })

  it("does not turn on what the person turned off", async () => {
    localStorage.setItem(EVAL_KEY, "0")
    await mount(<ChromeEvalSetting />)
    expect(mocks.chromeSetEval).not.toHaveBeenCalled()
  })

  it("says so when the switch could not be changed", async () => {
    mocks.chromeSetEval.mockRejectedValue(new Error("no such command"))
    await mount(<ChromeEvalSetting />)
    await userEvent.click(screen.getByRole("switch", { name: SWITCH }))
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Could not change the switch: no such command"
    )
    expect(localStorage.getItem(EVAL_KEY)).toBeNull()
  })
})

describe("ChromeEvalPanelSwitch", () => {
  it("asks the backend again each time the panel opens", async () => {
    const view = await mount(<ChromeEvalPanelSwitch open={false} />)
    expect(mocks.chromeEval).toHaveBeenCalledTimes(1)
    // Another window turned it on meanwhile.
    mocks.on = true
    await act(async () => {
      view.rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ChromeEvalPanelSwitch open />
        </NextIntlClientProvider>
      )
    })
    expect(mocks.chromeEval).toHaveBeenCalledTimes(2)
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.getByText(/sign-in details/)).toBeInTheDocument()
  })
})
