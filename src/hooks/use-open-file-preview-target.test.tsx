/**
 * 会话以外的「打开文件」入口（文件树、Git 列表、搜索、后台任务输出）开到哪（#1335）：
 * 手机布局下进工作区的文件抽屉，电脑上（桌面版窗口再窄也一样）照旧开在文件栏。
 */
import { act, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { MobileFileViewerHostContext } from "@/components/files/mobile-file-viewer-host-context"
import type { FileViewerRequest } from "@/components/message/session-viewer-host-context"
import { useOpenFilePreviewTarget } from "@/hooks/use-open-file-preview-target"

const layout = vi.hoisted(() => ({ mobile: false, desktop: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => layout.mobile }))
vi.mock("@/lib/transport", () => ({ isDesktop: () => layout.desktop }))

const { mockOpenFilePreview } = vi.hoisted(() => ({
  mockOpenFilePreview: vi.fn(async () => "/repo/src/a.ts"),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: mockOpenFilePreview }),
}))

const opened: FileViewerRequest[] = []

function Host({ children }: { children: ReactNode }) {
  return (
    <MobileFileViewerHostContext.Provider
      value={{ open: (request) => opened.push(request) }}
    >
      {children}
    </MobileFileViewerHostContext.Provider>
  )
}

function Opener() {
  const openFile = useOpenFilePreviewTarget()
  return (
    <button type="button" onClick={() => void openFile("src/a.ts")}>
      open file
    </button>
  )
}

function click(label: string) {
  act(() => {
    screen.getByText(label).click()
  })
}

describe("useOpenFilePreviewTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    opened.length = 0
    layout.mobile = false
    layout.desktop = false
  })

  it("手机布局下进工作区的文件抽屉，不开多标签编辑区", () => {
    layout.mobile = true
    render(
      <Host>
        <Opener />
      </Host>
    )

    click("open file")

    expect(mockOpenFilePreview).not.toHaveBeenCalled()
    expect(opened).toEqual([
      { path: "src/a.ts", line: null, folderId: undefined },
    ])
  })

  it("宽屏照旧开在文件栏", () => {
    render(
      <Host>
        <Opener />
      </Host>
    )

    click("open file")

    expect(opened).toEqual([])
    expect(mockOpenFilePreview).toHaveBeenCalledWith("src/a.ts")
  })

  it("桌面版窗口再窄也照旧开在文件栏", () => {
    layout.mobile = true
    layout.desktop = true
    render(
      <Host>
        <Opener />
      </Host>
    )

    click("open file")

    expect(opened).toEqual([])
    expect(mockOpenFilePreview).toHaveBeenCalledTimes(1)
  })

  it("没挂抽屉宿主时退回文件栏，不吞掉点击", () => {
    layout.mobile = true
    render(<Opener />)

    click("open file")

    expect(mockOpenFilePreview).toHaveBeenCalledWith("src/a.ts")
  })
})
