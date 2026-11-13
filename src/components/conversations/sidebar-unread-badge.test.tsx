import type { ReactElement } from "react"
import { cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import { UnreadDot, unreadEndingOf } from "./sidebar-unread-badge"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"

afterEach(cleanup)

function renderDot(
  ui: ReactElement,
  locale: "en" | "zh-CN" = "en"
): HTMLElement {
  const { container } = render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? enMessages : zhCNMessages}
    >
      {ui}
    </NextIntlClientProvider>
  )
  return container.querySelector("[data-jenny-unread-dot]")!
}

// #178: the unread dot's wording follows how the turn ended — a canceled
// task's session must not read "finished".
describe("UnreadDot", () => {
  it("says finished by default", () => {
    const dot = renderDot(<UnreadDot />)
    expect(dot.getAttribute("title")).toBe("Finished — not viewed yet")
    expect(dot.textContent).toBe("Finished — not viewed yet")
  })

  it("says cancelled for a canceled task, in title and screen-reader text", () => {
    const dot = renderDot(<UnreadDot ending="canceled" />)
    expect(dot.getAttribute("title")).toBe("Cancelled — not viewed yet")
    expect(dot.textContent).toBe("Cancelled — not viewed yet")
  })

  it("says the turn did not finish for any other cancelled turn", () => {
    const dot = renderDot(<UnreadDot ending="unfinished" />)
    expect(dot.getAttribute("title")).toBe(
      "Turn didn't finish — not viewed yet"
    )
  })

  it("reads 已取消，尚未查看 in Simplified Chinese", () => {
    const dot = renderDot(<UnreadDot ending="canceled" />, "zh-CN")
    expect(dot.getAttribute("title")).toBe("已取消，尚未查看")
    expect(dot.textContent).toBe("已取消，尚未查看")
  })
})

describe("unreadEndingOf", () => {
  it("lets a canceled task win over the turn's status", () => {
    expect(unreadEndingOf(false, false)).toBe("finished")
    expect(unreadEndingOf(true, false)).toBe("unfinished")
    expect(unreadEndingOf(true, true)).toBe("canceled")
    // Canceled after its turn had ended (in review).
    expect(unreadEndingOf(false, true)).toBe("canceled")
  })
})
