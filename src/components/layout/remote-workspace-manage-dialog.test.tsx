import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteWorkspaceConnection } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  listRemoteWorkspaceConnections: vi.fn(),
  createRemoteWorkspaceConnection: vi.fn(),
  updateRemoteWorkspaceConnection: vi.fn(),
  deleteRemoteWorkspaceConnection: vi.fn(),
  reorderRemoteWorkspaceConnections: vi.fn(),
}))

vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: mocks.listRemoteWorkspaceConnections,
  createRemoteWorkspaceConnection: mocks.createRemoteWorkspaceConnection,
  updateRemoteWorkspaceConnection: mocks.updateRemoteWorkspaceConnection,
  deleteRemoteWorkspaceConnection: mocks.deleteRemoteWorkspaceConnection,
  reorderRemoteWorkspaceConnections: mocks.reorderRemoteWorkspaceConnections,
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// motion 的拖动在 jsdom 里跑不起来：换成普通元素，把 onReorder 和每一项的
// onDragEnd 记下来，测试里直接调，模拟「拖完松手」。
const motion = vi.hoisted(() => ({
  onReorder: null as ((next: unknown[]) => void) | null,
  dragEnd: new Map<number, () => void>(),
}))

vi.mock("motion/react", async () => {
  const { useLayoutEffect } = await import("react")
  const MOTION_ONLY = new Set([
    "as",
    "axis",
    "values",
    "onReorder",
    "value",
    "drag",
    "dragListener",
    "dragControls",
    "dragMomentum",
    "layout",
    "onDragEnd",
  ])
  const domProps = (props: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(props).filter(([key]) => !MOTION_ONLY.has(key))
    )
  function Group(
    props: Record<string, unknown> & {
      children?: ReactNode
      onReorder: (next: unknown[]) => void
    }
  ) {
    const { onReorder } = props
    useLayoutEffect(() => {
      motion.onReorder = onReorder
    })
    return <div {...domProps(props)}>{props.children}</div>
  }
  function Item(
    props: Record<string, unknown> & {
      children?: ReactNode
      value: { id: number }
      onDragEnd: () => void
    }
  ) {
    const { value, onDragEnd } = props
    useLayoutEffect(() => {
      motion.dragEnd.set(value.id, onDragEnd)
    })
    return <section {...domProps(props)}>{props.children}</section>
  }
  return {
    Reorder: { Group, Item },
    useDragControls: () => ({ start: () => {} }),
  }
})

import { RemoteWorkspaceManageDialog } from "./remote-workspace-manage-dialog"
import enMessages from "@/i18n/messages/en.json"

function connection(
  overrides: Partial<RemoteWorkspaceConnection> = {}
): RemoteWorkspaceConnection {
  return {
    id: 1,
    name: "prod-box",
    base_url: "https://prod.example",
    token: "secret",
    headers: [],
    sort_order: 0,
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
    ...overrides,
  }
}

async function mount(
  connections: RemoteWorkspaceConnection[],
  {
    onOpenChange = () => {},
    onChanged = () => {},
  }: {
    onOpenChange?: (open: boolean) => void
    onChanged?: () => void
  } = {}
) {
  mocks.listRemoteWorkspaceConnections.mockResolvedValue(connections)
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RemoteWorkspaceManageDialog
        open
        onOpenChange={onOpenChange}
        onChanged={onChanged}
      />
    </NextIntlClientProvider>
  )
  await screen.findByDisplayValue(connections[0].name)
}

describe("RemoteWorkspaceManageDialog search", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("says nothing matches when the search filters out every connection", async () => {
    await mount([connection()])

    fireEvent.change(screen.getByPlaceholderText("Search remote workspaces"), {
      target: { value: "no-such-box" },
    })

    expect(
      await screen.findByText("No matching remote connections")
    ).toBeInTheDocument()
    // The search prompt belongs in the field, not in the empty list.
    expect(
      screen.queryByText("Search remote workspaces")
    ).not.toBeInTheDocument()
  })
})

describe("RemoteWorkspaceManageDialog custom headers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps the editor collapsed when the connection has no headers", async () => {
    await mount([connection()])
    expect(screen.queryByLabelText("Header name")).not.toBeInTheDocument()
  })

  it("opens the editor when the connection already has headers", async () => {
    await mount([
      connection({ headers: [{ name: "CF-Access-Client-Id", value: "abc" }] }),
    ])
    expect(await screen.findByDisplayValue("CF-Access-Client-Id")).toBeVisible()
  })

  it("masks every header value", async () => {
    await mount([connection({ headers: [{ name: "X-Secret", value: "abc" }] })])
    expect(await screen.findByDisplayValue("abc")).toHaveAttribute(
      "type",
      "password"
    )
  })

  it("sends the added header on save and drops a removed one", async () => {
    const saved = connection({
      headers: [{ name: "X-Team", value: "core" }],
    })
    mocks.updateRemoteWorkspaceConnection.mockResolvedValue(saved)
    await mount([connection()])

    await userEvent.click(
      screen.getByRole("button", { name: /Custom headers/ })
    )
    await userEvent.click(screen.getByRole("button", { name: "Add header" }))
    fireEvent.change(screen.getByLabelText("Header name"), {
      target: { value: "X-Team" },
    })
    fireEvent.change(screen.getByLabelText("Header value"), {
      target: { value: "core" },
    })

    // A second row, then removed again: the payload must hold one header.
    await userEvent.click(screen.getByRole("button", { name: "Add header" }))
    await userEvent.click(
      screen.getAllByRole("button", { name: "Remove header" })[1]
    )

    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mocks.updateRemoteWorkspaceConnection).toHaveBeenCalledWith(1, {
        name: "prod-box",
        baseUrl: "https://prod.example",
        token: "secret",
        headers: [{ name: "X-Team", value: "core" }],
      })
    })
  })
})

describe("RemoteWorkspaceManageDialog closing after save", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    motion.onReorder = null
    motion.dragEnd.clear()
  })

  it("closes and confirms once after an existing connection is saved", async () => {
    const onOpenChange = vi.fn()
    const onChanged = vi.fn()
    mocks.updateRemoteWorkspaceConnection.mockResolvedValue(
      connection({ name: "prod-box-2" })
    )
    await mount([connection()], { onOpenChange, onChanged })

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "prod-box-2" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith("Remote connection saved.")
  })

  it("closes and confirms once after a new connection is saved", async () => {
    const onOpenChange = vi.fn()
    const onChanged = vi.fn()
    mocks.createRemoteWorkspaceConnection.mockResolvedValue(
      connection({ id: 2, name: "new-box", base_url: "https://new.example" })
    )
    await mount([connection()], { onOpenChange, onChanged })

    await userEvent.click(
      screen.getByRole("button", { name: "New connection" })
    )
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "new-box" },
    })
    fireEvent.change(screen.getByLabelText("Service URL"), {
      target: { value: "https://new.example" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(mocks.createRemoteWorkspaceConnection).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith("Remote connection saved.")
  })

  it("stays open with the error and the typed values when save fails", async () => {
    const onOpenChange = vi.fn()
    mocks.updateRemoteWorkspaceConnection.mockRejectedValue(
      new Error("disk full")
    )
    await mount([connection()], { onOpenChange })

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "typed-name" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(
      await screen.findByText("Failed to save remote connection: disk full")
    ).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Name")).toHaveValue("typed-name")
  })

  it("stays open with Save disabled until the save returns", async () => {
    const onOpenChange = vi.fn()
    let resolveSave: (value: RemoteWorkspaceConnection) => void = () => {}
    mocks.updateRemoteWorkspaceConnection.mockReturnValue(
      new Promise<RemoteWorkspaceConnection>((resolve) => {
        resolveSave = resolve
      })
    )
    await mount([connection()], { onOpenChange })

    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => {
      resolveSave(connection())
    })
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("stays open after a connection is deleted", async () => {
    const onOpenChange = vi.fn()
    const onChanged = vi.fn()
    mocks.deleteRemoteWorkspaceConnection.mockResolvedValue(undefined)
    await mount([connection(), connection({ id: 2, name: "other-box" })], {
      onOpenChange,
      onChanged,
    })

    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
    const confirm = await screen.findByRole("alertdialog")
    await userEvent.click(
      Array.from(confirm.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete"
      ) as HTMLButtonElement
    )

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1)
    })
    expect(mocks.deleteRemoteWorkspaceConnection).toHaveBeenCalledWith(1)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("stays open after the order is saved", async () => {
    const onOpenChange = vi.fn()
    const onChanged = vi.fn()
    mocks.reorderRemoteWorkspaceConnections.mockResolvedValue(undefined)
    const first = connection()
    const second = connection({ id: 2, name: "other-box" })
    await mount([first, second], { onOpenChange, onChanged })

    act(() => {
      motion.onReorder?.([second, first])
    })
    act(() => {
      motion.dragEnd.get(2)?.()
    })

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1)
    })
    expect(mocks.reorderRemoteWorkspaceConnections).toHaveBeenCalledWith([2, 1])
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("stays open when another connection is picked", async () => {
    const onOpenChange = vi.fn()
    await mount([connection(), connection({ id: 2, name: "other-box" })], {
      onOpenChange,
    })

    await userEvent.click(screen.getByText("other-box"))

    expect(await screen.findByDisplayValue("other-box")).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
