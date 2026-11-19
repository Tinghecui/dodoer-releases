import type { ReactElement } from "react"
import { cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import { ConversationActivityBadge } from "./conversation-activity-badge"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"

afterEach(cleanup)

function renderBadge(
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
  return container.querySelector("[data-turn-unfinished]")!
}

// #817：回合没跑完就被杀、手上还有后台任务：红叉的悬停多一行写出没跑完的后台任务。
describe("ConversationActivityBadge cancelled cross", () => {
  it("lists the background tasks that did not finish under the cross's title", () => {
    const cross = renderBadge(
      <ConversationActivityBadge
        running={false}
        cancelled
        unread
        abandonedTasks={["Watch CI", "sleep 600"]}
      />,
      "zh-CN"
    )
    expect(cross).not.toBeNull()
    expect(cross.getAttribute("title")).toBe(
      "本轮未完成，尚未查看\n后台任务没有跑完：Watch CI, sleep 600"
    )
  })

  it("keeps the plain title without abandoned tasks", () => {
    const cross = renderBadge(
      <ConversationActivityBadge
        running={false}
        cancelled
        abandonedTasks={[]}
      />
    )
    expect(cross.getAttribute("title")).toBe(
      enMessages.Folder.sidebar.statusCancelledBadge
    )
  })
})
