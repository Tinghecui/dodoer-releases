import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it } from "vitest"

import {
  useSessionUsageStore,
  type SessionUse,
} from "@/lib/cowork/session-usage"

import { SessionUsageMark } from "./session-usage-mark"

function mount(
  uses: SessionUse[] | null,
  locale: "en" | "zh-CN" = "en",
  conversationId: number | null = 7
) {
  const map = new Map<number, SessionUse[]>()
  if (uses) map.set(7, uses)
  useSessionUsageStore.setState({ byConversation: map })
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <SessionUsageMark conversationId={conversationId} />
    </NextIntlClientProvider>
  )
}

const mark = () => document.querySelector<HTMLElement>("[data-session-usage]")

beforeEach(() => {
  useSessionUsageStore.setState({ byConversation: new Map() })
})

describe("SessionUsageMark", () => {
  it("is not there while the conversation uses nothing", () => {
    mount(null)
    expect(mark()).toBeNull()
  })

  it("is not there without a conversation", () => {
    mount([{ kind: "shell", device: "laptop", since: 1 }], "en", null)
    expect(mark()).toBeNull()
  })

  it("names the device and says it is Chrome", () => {
    mount([{ kind: "browser", device: "laptop", chrome: true, since: 1 }])
    expect(mark()?.dataset.sessionUsage).toBe("browser")
    expect(mark()?.title).toBe("Using Chrome on laptop")
    expect(mark()?.getAttribute("aria-label")).toBe("Using Chrome on laptop")
    expect(mark()?.querySelectorAll("svg")).toHaveLength(1)
  })

  it("says the browser where it is not known to be Chrome, and the person's computer where no device is named", () => {
    mount([{ kind: "browser", since: 1 }])
    expect(mark()?.title).toBe("Using the browser on your computer")
  })

  it("shows the browser and the command line together, one icon each", () => {
    mount(
      [
        { kind: "browser", device: "desktop", chrome: false, since: 1 },
        { kind: "shell", device: "desktop", since: 2 },
      ],
      "zh-CN"
    )
    expect(mark()?.dataset.sessionUsage).toBe("browser shell")
    expect(mark()?.querySelectorAll("svg")).toHaveLength(2)
    expect(mark()?.title).toBe(
      "正在用 desktop 上的浏览器\n正在用 desktop 的命令行（空闲的连接最多留 10 分钟）"
    )
  })
})
