import { type ReactNode } from "react"
import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// Markdown 渲染换成原样输出文字：这里只看页面上最后显示的字。
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  defaultRemarkPlugins: {},
  defaultRehypePlugins: {},
}))
vi.mock("@streamdown/cjk", () => ({ cjk: {} }))
vi.mock("@streamdown/math", () => ({ createMathPlugin: () => ({}) }))
vi.mock("@streamdown/mermaid", () => ({ mermaid: {} }))

import enMessages from "@/i18n/messages/en.json"
import { brandMessages } from "@/lib/cowork/brand"
import ActivityGalleryPage from "./page.gallery"

// 当产品名用的旧名字（和 brand.test.ts 的判断一样）：路径、工具名、
// 标识符里的 codeg 不算。
const OLD_NAME_RE =
  /(?<![-\w./~$@:\\"])(?:dodoer|Dodoer|Codeg|codeg|Cowork)s?(?![-\w/~:\\"]|\.\w)/

describe("activity gallery page as rendered", () => {
  it("shows CoTeam, not an old product name, in the sample messages", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={brandMessages(enMessages)}>
        <ActivityGalleryPage />
      </NextIntlClientProvider>
    )
    const text = container.textContent ?? ""
    expect(text).toContain("until you confirm in CoTeam.")
    // 每个文字节点单独看，免得相邻节点拼在一起误判
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const leftovers: string[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.textContent ?? ""
      if (OLD_NAME_RE.test(s)) leftovers.push(s)
    }
    expect(leftovers).toEqual([])
  })
})
