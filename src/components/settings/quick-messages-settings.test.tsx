import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { QuickMessage } from "@/lib/types"
import { QuickMessagesSettings } from "./quick-messages-settings"

// #979: 标题、内容全是空格时不能保存成看不见的条目；
// 老数据里已经是空格标题的条目，列表和删除确认要显示「未命名」。

const api = vi.hoisted(() => ({
  quickMessagesList: vi.fn(),
  quickMessagesCreate: vi.fn(),
  quickMessagesUpdate: vi.fn(),
  quickMessagesDelete: vi.fn(),
  quickMessagesReorder: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({ toast }))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => children,
  ResizablePanel: ({ children }: { children: ReactNode }) => children,
  ResizableHandle: () => null,
}))
// jsdom 里拖不动，换成一个按钮直接触发 onReorder（把列表倒过来），模拟拖动排序
vi.mock("motion/react", () => ({
  useDragControls: () => ({ start: () => {} }),
  Reorder: {
    Group: ({
      children,
      values,
      onReorder,
    }: {
      children: ReactNode
      values: unknown[]
      onReorder: (next: unknown[]) => void
    }) => (
      <div>
        <button type="button" onClick={() => onReorder([...values].reverse())}>
          test-reorder
        </button>
        {children}
      </div>
    ),
    Item: ({
      children,
      className,
      onClick,
    }: {
      children: ReactNode
      className?: string
      onClick?: () => void
    }) => (
      <div className={className} onClick={onClick}>
        {children}
      </div>
    ),
  },
}))

const qm = enMessages.QuickMessagesSettings

function message(over: Partial<QuickMessage>): QuickMessage {
  return {
    id: 1,
    title: "Say hello",
    content: "hello",
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  }
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QuickMessagesSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("QuickMessagesSettings 空白校验", () => {
  it("标题和内容都只填空格时不保存，字段旁提示必填", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ title: "", content: "" }),
    ])
    const user = userEvent.setup()
    renderPage()

    const title = await screen.findByLabelText(qm.fields.title)
    const content = screen.getByLabelText(qm.fields.content)
    await user.type(title, "   ")
    await user.type(content, "   ")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))

    expect(await screen.findByText(qm.fields.titleRequired)).toBeTruthy()
    expect(screen.getByText(qm.fields.contentRequired)).toBeTruthy()
    expect(title.getAttribute("aria-invalid")).toBe("true")
    expect(content.getAttribute("aria-invalid")).toBe("true")
    expect(api.quickMessagesUpdate).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("保存时把首尾空格去掉再传给后端", async () => {
    const original = message({ title: "", content: "" })
    api.quickMessagesList.mockResolvedValue([original])
    api.quickMessagesUpdate.mockImplementation(
      async (p: { id: number; title: string; content: string }) => ({
        ...original,
        ...p,
      })
    )
    const user = userEvent.setup()
    renderPage()

    await user.type(await screen.findByLabelText(qm.fields.title), "  Hi  ")
    await user.type(screen.getByLabelText(qm.fields.content), " body ")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))

    await waitFor(() =>
      expect(api.quickMessagesUpdate).toHaveBeenCalledWith({
        id: 1,
        title: "Hi",
        content: "body",
      })
    )
    expect(screen.queryByText(qm.fields.titleRequired)).toBeNull()
  })

  it("老数据里空格标题的条目在列表和删除确认里显示「未命名」", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ title: "   ", content: "   " }),
    ])
    const user = userEvent.setup()
    renderPage()

    expect(
      await screen.findByRole("button", {
        name: qm.actions.dragSortMessage.replace("{name}", qm.untitled),
      })
    ).toBeTruthy()
    expect(screen.getByText(qm.untitled)).toBeTruthy()

    await user.click(screen.getByRole("button", { name: qm.actions.delete }))
    expect(
      await screen.findByText(
        qm.confirmDelete.message.replace("{name}", qm.untitled)
      )
    ).toBeTruthy()
  })

  it("点「新建」不先存空记录，全空格保存也不会建出条目", async () => {
    api.quickMessagesList.mockResolvedValue([])
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: qm.actions.new })
    )
    expect(api.quickMessagesCreate).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(qm.fields.title), "   ")
    await user.type(screen.getByLabelText(qm.fields.content), "   ")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))

    expect(await screen.findByText(qm.fields.titleRequired)).toBeTruthy()
    expect(screen.getByText(qm.fields.contentRequired)).toBeTruthy()
    expect(api.quickMessagesCreate).not.toHaveBeenCalled()
    expect(api.quickMessagesUpdate).not.toHaveBeenCalled()
    expect(
      screen.queryAllByRole("button", { name: /Drag to reorder/ })
    ).toHaveLength(0)
  })

  it("新建的条目点保存时才创建，传去掉首尾空格的值", async () => {
    api.quickMessagesList.mockResolvedValue([])
    api.quickMessagesCreate.mockImplementation(
      async (p: { title: string; content: string }) => message({ id: 7, ...p })
    )
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: qm.actions.new })
    )
    await user.type(screen.getByLabelText(qm.fields.title), "  Hi  ")
    await user.type(screen.getByLabelText(qm.fields.content), " body ")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))

    await waitFor(() =>
      expect(api.quickMessagesCreate).toHaveBeenCalledWith({
        title: "Hi",
        content: "body",
      })
    )
    expect(api.quickMessagesCreate).toHaveBeenCalledTimes(1)
    expect(api.quickMessagesUpdate).not.toHaveBeenCalled()
    expect(
      await screen.findByRole("button", {
        name: qm.actions.dragSortMessage.replace("{name}", "Hi"),
      })
    ).toBeTruthy()
  })
  it("编辑新草稿时拖动列表排序，草稿里填的字不丢", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First" }),
      message({ id: 2, title: "Second", sort_order: 1 }),
    ])
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: qm.actions.new })
    )
    await user.type(screen.getByLabelText(qm.fields.title), "Draft title")
    await user.type(screen.getByLabelText(qm.fields.content), "Draft body")
    await user.click(screen.getByRole("button", { name: "test-reorder" }))

    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("Draft title")
    expect(
      (screen.getByLabelText(qm.fields.content) as HTMLTextAreaElement).value
    ).toBe("Draft body")
  })

  it("编辑已有条目时拖动列表排序，没保存的修改不丢", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First" }),
      message({ id: 2, title: "Second", sort_order: 1 }),
    ])
    const user = userEvent.setup()
    renderPage()

    const title = (await screen.findByLabelText(
      qm.fields.title
    )) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe("First"))
    await user.type(title, " edited")
    await user.click(screen.getByRole("button", { name: "test-reorder" }))

    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("First edited")
  })
  it("只多打了首尾空格的修改保存后，表单回到存进去的值，不再显示未保存", async () => {
    api.quickMessagesList.mockResolvedValue([message({ id: 1, title: "Hi" })])
    api.quickMessagesUpdate.mockImplementation(
      async (p: { id: number; title: string; content: string }) =>
        message({ ...p })
    )
    const user = userEvent.setup()
    renderPage()

    const title = (await screen.findByLabelText(
      qm.fields.title
    )) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe("Hi"))
    await user.type(title, "  ")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))

    await waitFor(() =>
      expect(
        (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
      ).toBe("Hi")
    )
    expect(
      (
        screen.getByRole("button", {
          name: qm.actions.save,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("保存已有条目时切到另一条开始编辑，保存返回后不覆盖另一条的输入", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First", content: "one" }),
      message({ id: 2, title: "Second", content: "two", sort_order: 1 }),
    ])
    let resolveUpdate: (m: QuickMessage) => void = () => {}
    api.quickMessagesUpdate.mockImplementation(
      () =>
        new Promise<QuickMessage>((resolve) => {
          resolveUpdate = resolve
        })
    )
    const user = userEvent.setup()
    renderPage()

    const title = (await screen.findByLabelText(
      qm.fields.title
    )) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe("First"))
    await user.type(title, " edited")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))
    await waitFor(() => expect(api.quickMessagesUpdate).toHaveBeenCalled())

    await user.click(screen.getByText("Second"))
    const titleNow = screen.getByLabelText(qm.fields.title) as HTMLInputElement
    await waitFor(() => expect(titleNow.value).toBe("Second"))
    await user.type(titleNow, " typing")

    resolveUpdate(message({ id: 1, title: "First edited", content: "one" }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(qm.toasts.saved)
    )

    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("Second typing")
    expect(
      (screen.getByLabelText(qm.fields.content) as HTMLTextAreaElement).value
    ).toBe("two")
  })

  it("保存新草稿时切到已有条目开始编辑，创建返回后不跳走、不清掉输入", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First", content: "one" }),
    ])
    let resolveCreate: (m: QuickMessage) => void = () => {}
    api.quickMessagesCreate.mockImplementation(
      () =>
        new Promise<QuickMessage>((resolve) => {
          resolveCreate = resolve
        })
    )
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: qm.actions.new })
    )
    await user.type(screen.getByLabelText(qm.fields.title), "Draft")
    await user.type(screen.getByLabelText(qm.fields.content), "body")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))
    await waitFor(() => expect(api.quickMessagesCreate).toHaveBeenCalled())

    await user.click(screen.getByText("First"))
    const titleNow = screen.getByLabelText(qm.fields.title) as HTMLInputElement
    await waitFor(() => expect(titleNow.value).toBe("First"))
    await user.type(titleNow, " typing")

    resolveCreate(message({ id: 9, title: "Draft", content: "body" }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(qm.toasts.created)
    )

    // 新条目进了列表，但当前还停在用户切过去的那一条，输入还在
    expect(
      await screen.findByRole("button", {
        name: qm.actions.dragSortMessage.replace("{name}", "Draft"),
      })
    ).toBeTruthy()
    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("First typing")
  })

  it("新草稿点保存后、创建返回前接着打的字，返回后不被清掉", async () => {
    api.quickMessagesList.mockResolvedValue([])
    let resolveCreate: (m: QuickMessage) => void = () => {}
    api.quickMessagesCreate.mockImplementation(
      () =>
        new Promise<QuickMessage>((resolve) => {
          resolveCreate = resolve
        })
    )
    const user = userEvent.setup()
    renderPage()

    await user.click(
      await screen.findByRole("button", { name: qm.actions.new })
    )
    await user.type(screen.getByLabelText(qm.fields.title), "Draft")
    await user.type(screen.getByLabelText(qm.fields.content), "body")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))
    await waitFor(() => expect(api.quickMessagesCreate).toHaveBeenCalled())

    await user.type(screen.getByLabelText(qm.fields.content), " more")

    resolveCreate(message({ id: 9, title: "Draft", content: "body" }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(qm.toasts.created)
    )

    expect(
      await screen.findByRole("button", {
        name: qm.actions.dragSortMessage.replace("{name}", "Draft"),
      })
    ).toBeTruthy()
    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("Draft")
    expect(
      (screen.getByLabelText(qm.fields.content) as HTMLTextAreaElement).value
    ).toBe("body more")
    // 停在新建出来的那一条上，多打的字还没存，保存按钮可点
    expect(
      (
        screen.getByRole("button", {
          name: qm.actions.save,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it("已有条目点保存后、返回前接着打的字，返回后不被覆盖", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First", content: "one" }),
    ])
    let resolveUpdate: (m: QuickMessage) => void = () => {}
    api.quickMessagesUpdate.mockImplementation(
      () =>
        new Promise<QuickMessage>((resolve) => {
          resolveUpdate = resolve
        })
    )
    const user = userEvent.setup()
    renderPage()

    const title = (await screen.findByLabelText(
      qm.fields.title
    )) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe("First"))
    await user.type(title, " edited")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))
    await waitFor(() => expect(api.quickMessagesUpdate).toHaveBeenCalled())

    await user.type(screen.getByLabelText(qm.fields.title), " again")

    resolveUpdate(message({ id: 1, title: "First edited", content: "one" }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(qm.toasts.saved)
    )

    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("First edited again")
  })

  it("保存中切走再切回同一条接着打字，返回后不被覆盖", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First", content: "one" }),
      message({ id: 2, title: "Second", content: "two", sort_order: 1 }),
    ])
    let resolveUpdate: (m: QuickMessage) => void = () => {}
    api.quickMessagesUpdate.mockImplementation(
      () =>
        new Promise<QuickMessage>((resolve) => {
          resolveUpdate = resolve
        })
    )
    const user = userEvent.setup()
    renderPage()

    const title = (await screen.findByLabelText(
      qm.fields.title
    )) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe("First"))
    await user.type(title, " edited")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))
    await waitFor(() => expect(api.quickMessagesUpdate).toHaveBeenCalled())

    await user.click(screen.getByText("Second"))
    await waitFor(() =>
      expect(
        (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
      ).toBe("Second")
    )
    await user.click(screen.getByText("First"))
    const titleNow = screen.getByLabelText(qm.fields.title) as HTMLInputElement
    await waitFor(() => expect(titleNow.value).toBe("First"))
    await user.type(titleNow, " typing")

    resolveUpdate(message({ id: 1, title: "First edited", content: "one" }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(qm.toasts.saved)
    )

    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("First typing")
  })

  it("保存中切走再切回同一条但没打字，返回后表单换成存进去的值，再保存不会改回旧值", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First", content: "one" }),
      message({ id: 2, title: "Second", content: "two", sort_order: 1 }),
    ])
    let resolveUpdate: (m: QuickMessage) => void = () => {}
    api.quickMessagesUpdate.mockImplementation(
      () =>
        new Promise<QuickMessage>((resolve) => {
          resolveUpdate = resolve
        })
    )
    const user = userEvent.setup()
    renderPage()

    const title = (await screen.findByLabelText(
      qm.fields.title
    )) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe("First"))
    await user.type(title, " edited")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))
    await waitFor(() => expect(api.quickMessagesUpdate).toHaveBeenCalled())

    await user.click(screen.getByText("Second"))
    await waitFor(() =>
      expect(
        (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
      ).toBe("Second")
    )
    await user.click(screen.getByText("First"))
    await waitFor(() =>
      expect(
        (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
      ).toBe("First")
    )

    resolveUpdate(message({ id: 1, title: "First edited", content: "one" }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(qm.toasts.saved)
    )

    await waitFor(() =>
      expect(
        (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
      ).toBe("First edited")
    )
    // 表单和存进去的一样，保存按钮回到不可点，不会把新值覆盖回旧值
    expect(
      (
        screen.getByRole("button", {
          name: qm.actions.save,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("保存中不切走、把改动删回保存前的内容，返回后不被覆盖", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First", content: "one" }),
    ])
    let resolveUpdate: (m: QuickMessage) => void = () => {}
    api.quickMessagesUpdate.mockImplementation(
      () =>
        new Promise<QuickMessage>((resolve) => {
          resolveUpdate = resolve
        })
    )
    const user = userEvent.setup()
    renderPage()

    const title = (await screen.findByLabelText(
      qm.fields.title
    )) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe("First"))
    await user.type(title, " edited")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))
    await waitFor(() => expect(api.quickMessagesUpdate).toHaveBeenCalled())

    // 等待时把刚加的 " edited" 删掉，表单恰好回到保存前的内容
    await user.type(
      screen.getByLabelText(qm.fields.title),
      "{Backspace}".repeat(" edited".length)
    )
    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("First")

    resolveUpdate(message({ id: 1, title: "First edited", content: "one" }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(qm.toasts.saved)
    )

    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("First")
  })

  it("保存中切走再切回同一条、打字后又删回旧值，返回后不被覆盖", async () => {
    api.quickMessagesList.mockResolvedValue([
      message({ id: 1, title: "First", content: "one" }),
      message({ id: 2, title: "Second", content: "two", sort_order: 1 }),
    ])
    let resolveUpdate: (m: QuickMessage) => void = () => {}
    api.quickMessagesUpdate.mockImplementation(
      () =>
        new Promise<QuickMessage>((resolve) => {
          resolveUpdate = resolve
        })
    )
    const user = userEvent.setup()
    renderPage()

    const title = (await screen.findByLabelText(
      qm.fields.title
    )) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe("First"))
    await user.type(title, " edited")
    await user.click(screen.getByRole("button", { name: qm.actions.save }))
    await waitFor(() => expect(api.quickMessagesUpdate).toHaveBeenCalled())

    await user.click(screen.getByText("Second"))
    await waitFor(() =>
      expect(
        (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
      ).toBe("Second")
    )
    await user.click(screen.getByText("First"))
    const titleNow = screen.getByLabelText(qm.fields.title) as HTMLInputElement
    await waitFor(() => expect(titleNow.value).toBe("First"))
    await user.type(titleNow, "X{Backspace}")
    expect(titleNow.value).toBe("First")

    resolveUpdate(message({ id: 1, title: "First edited", content: "one" }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(qm.toasts.saved)
    )

    expect(
      (screen.getByLabelText(qm.fields.title) as HTMLInputElement).value
    ).toBe("First")
  })
})
