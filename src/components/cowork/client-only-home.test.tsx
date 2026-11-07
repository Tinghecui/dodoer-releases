import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const daemon = vi.hoisted(() => ({ client: false }))
vi.mock("@/lib/transport/local-daemon", () => ({
  isClientOnlyApp: () => daemon.client,
}))

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.params,
}))

const remote = vi.hoisted(() => ({
  list: vi.fn(),
  open: vi.fn(),
}))
vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: remote.list,
  openRemoteWorkspace: remote.open,
}))

const platform = vi.hoisted(() => ({ openUrl: vi.fn() }))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  openUrl: platform.openUrl,
}))

const dialog = vi.hoisted(() => ({ opened: [] as boolean[] }))
vi.mock("@/components/layout/remote-workspace-manage-dialog", () => ({
  RemoteWorkspaceManageDialog: ({ open }: { open: boolean }) => {
    dialog.opened.push(open)
    return open ? <div data-testid="manage-dialog" /> : null
  },
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

import {
  ClientOnlyGate,
  ClientOnlyHome,
  FULL_EDITION_DOWNLOAD_URL,
} from "./client-only-home"

function wrap(ui: React.ReactNode, locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      {ui}
    </NextIntlClientProvider>
  )
}

const connections = [
  {
    id: 3,
    name: "james @ Cowork",
    base_url: "https://james.work.example",
    token: "",
    headers: [],
    sort_order: 0,
    created_at: "",
    updated_at: "",
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  daemon.client = false
  nav.params = new URLSearchParams()
  dialog.opened = []
  remote.list.mockResolvedValue(connections)
  remote.open.mockResolvedValue(undefined)
})

describe("ClientOnlyGate", () => {
  it("lets the workspace through in an app with a daemon", () => {
    wrap(
      <ClientOnlyGate>
        <div>workspace</div>
      </ClientOnlyGate>
    )
    expect(screen.getByText("workspace")).toBeInTheDocument()
    expect(remote.list).not.toHaveBeenCalled()
  })

  it("replaces the local window of the client-only edition", async () => {
    daemon.client = true
    wrap(
      <ClientOnlyGate>
        <div>workspace</div>
      </ClientOnlyGate>
    )
    expect(screen.queryByText("workspace")).toBeNull()
    expect(
      screen.getByRole("heading", { name: "Connect to a server" })
    ).toBeInTheDocument()
    await waitFor(() => expect(remote.list).toHaveBeenCalled())
  })

  it("leaves a remote workspace window alone, client-only or not", () => {
    daemon.client = true
    nav.params = new URLSearchParams("remoteConnectionId=3")
    wrap(
      <ClientOnlyGate>
        <div>workspace</div>
      </ClientOnlyGate>
    )
    expect(screen.getByText("workspace")).toBeInTheDocument()
  })
})

describe("ClientOnlyHome", () => {
  it("lists the saved connections and opens one", async () => {
    wrap(<ClientOnlyHome />)
    expect(await screen.findByText("james @ Cowork")).toBeInTheDocument()
    expect(screen.getByText("https://james.work.example")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(remote.open).toHaveBeenCalledWith(3)
  })

  it("says so when nothing is saved, and reloads when the window comes back", async () => {
    remote.list.mockResolvedValue([])
    wrap(<ClientOnlyHome />)
    expect(await screen.findByText("No server added yet.")).toBeInTheDocument()
    expect(remote.list).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(remote.list).toHaveBeenCalledTimes(2))
  })

  it("opens the connection manager and reloads when it closes", async () => {
    wrap(<ClientOnlyHome />)
    await screen.findByText("james @ Cowork")
    expect(dialog.opened[dialog.opened.length - 1]).toBe(false)
    await userEvent.click(
      screen.getByRole("button", { name: "Add or manage servers" })
    )
    expect(screen.getByTestId("manage-dialog")).toBeInTheDocument()
  })

  it("points at the full edition in the system browser", async () => {
    wrap(<ClientOnlyHome />, "zh-CN")
    await userEvent.click(screen.getByRole("button", { name: "完整版下载" }))
    expect(platform.openUrl).toHaveBeenCalledWith(FULL_EDITION_DOWNLOAD_URL)
    expect(FULL_EDITION_DOWNLOAD_URL).toMatch(/dodoer-releases/)
  })
})
