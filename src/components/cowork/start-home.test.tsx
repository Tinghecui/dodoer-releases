import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MAIN_WINDOW_VIEW_KEY } from "@/lib/cowork/start-page"

const daemon = vi.hoisted(() => ({
  info: { mode: "child", connectionId: -1 } as {
    mode: string
    connectionId: number
  } | null,
}))
vi.mock("@/lib/transport/local-daemon", () => ({
  localDaemonInfo: () => daemon.info,
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

const page = vi.hoisted(() => ({ reload: vi.fn() }))
vi.mock("@/lib/cowork/start-page", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cowork/start-page")>()),
  reloadWindow: page.reload,
}))

vi.mock("@/lib/platform", () => ({ isDesktop: () => true }))

const dialog = vi.hoisted(() => ({ opened: [] as boolean[] }))
vi.mock("@/components/layout/remote-workspace-manage-dialog", () => ({
  RemoteWorkspaceManageDialog: ({ open }: { open: boolean }) => {
    dialog.opened.push(open)
    return open ? <div data-testid="manage-dialog" /> : null
  },
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

import { BackToStartMenuItem, StartGate, StartHome } from "./start-home"

function wrap(ui: React.ReactNode, locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      {ui}
    </NextIntlClientProvider>
  )
}

/** The gate around a workspace that carries the quick-actions entry. */
function gated(locale: "en" | "zh-CN" = "en") {
  return wrap(
    <StartGate>
      <div>workspace</div>
      <DropdownMenu open>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <BackToStartMenuItem />
        </DropdownMenuContent>
      </DropdownMenu>
    </StartGate>,
    locale
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

const startHeading = () =>
  screen.queryByRole("heading", { name: "Where do you want to work?" })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  daemon.info = { mode: "child", connectionId: -1 }
  nav.params = new URLSearchParams()
  dialog.opened = []
  remote.list.mockResolvedValue(connections)
  remote.open.mockResolvedValue(undefined)
})

describe("StartGate", () => {
  it("leaves the web build alone", () => {
    daemon.info = null
    gated()
    expect(screen.getByText("workspace")).toBeInTheDocument()
    expect(remote.list).not.toHaveBeenCalled()
    // No start page to go back to.
    expect(screen.queryByRole("menuitem")).toBeNull()
  })

  it("leaves a remote workspace window alone, whatever is remembered", () => {
    localStorage.setItem(MAIN_WINDOW_VIEW_KEY, "start")
    nav.params = new URLSearchParams("remoteConnectionId=3")
    gated()
    expect(screen.getByText("workspace")).toBeInTheDocument()
    expect(screen.queryByRole("menuitem")).toBeNull()
    expect(localStorage.getItem(MAIN_WINDOW_VIEW_KEY)).toBe("start")
  })

  it("goes straight to the local workspace when it was open last time", () => {
    localStorage.setItem(MAIN_WINDOW_VIEW_KEY, "local")
    gated()
    expect(screen.getByText("workspace")).toBeInTheDocument()
    expect(startHeading()).toBeNull()
    // Decided without asking for the saved servers.
    expect(remote.list).not.toHaveBeenCalled()
  })

  it("shows the start page when that is where the person left", async () => {
    localStorage.setItem(MAIN_WINDOW_VIEW_KEY, "start")
    remote.list.mockResolvedValue([])
    gated()
    expect(startHeading()).toBeInTheDocument()
    expect(screen.queryByText("workspace")).toBeNull()
    expect(await screen.findByText("No server added yet.")).toBeInTheDocument()
  })

  it("first launch with a saved server: the start page, nothing remembered yet", async () => {
    gated()
    expect(screen.queryByText("workspace")).toBeNull()
    expect(await screen.findByText("james @ Cowork")).toBeInTheDocument()
    expect(startHeading()).toBeInTheDocument()
    expect(localStorage.getItem(MAIN_WINDOW_VIEW_KEY)).toBeNull()
  })

  it("first launch without a saved server: the local workspace, remembered", async () => {
    remote.list.mockResolvedValue([])
    gated()
    expect(await screen.findByText("workspace")).toBeInTheDocument()
    expect(startHeading()).toBeNull()
    expect(localStorage.getItem(MAIN_WINDOW_VIEW_KEY)).toBe("local")
  })

  it("first launch, servers cannot be listed: the local workspace", async () => {
    remote.list.mockRejectedValue(new Error("db"))
    gated()
    expect(await screen.findByText("workspace")).toBeInTheDocument()
  })

  it("opens the local workspace from the start page and remembers it", async () => {
    gated()
    await screen.findByText("james @ Cowork")
    await userEvent.click(
      screen.getByRole("button", { name: "Open local workspace" })
    )
    expect(screen.getByText("workspace")).toBeInTheDocument()
    expect(startHeading()).toBeNull()
    expect(localStorage.getItem(MAIN_WINDOW_VIEW_KEY)).toBe("local")
  })

  it("goes back to the start page from the local workspace", async () => {
    localStorage.setItem(MAIN_WINDOW_VIEW_KEY, "local")
    gated("zh-CN")
    await userEvent.click(screen.getByRole("menuitem", { name: "回到开始页" }))
    expect(localStorage.getItem(MAIN_WINDOW_VIEW_KEY)).toBe("start")
    // A reload, not an unmount: the workspace's providers would disconnect
    // the local agents on the way out.
    expect(page.reload).toHaveBeenCalledTimes(1)
  })

  it("without a local daemon: always the start page, no local workspace on it", async () => {
    daemon.info = { mode: "client", connectionId: -1 }
    localStorage.setItem(MAIN_WINDOW_VIEW_KEY, "local")
    gated()
    expect(screen.queryByText("workspace")).toBeNull()
    expect(startHeading()).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Open local workspace" })
    ).toBeNull()
    expect(screen.getByText(/CODEG_DESKTOP_DAEMON=client/)).toBeInTheDocument()
    await waitFor(() => expect(remote.list).toHaveBeenCalled())
    // Nothing is written: the choice is the full app's.
    expect(localStorage.getItem(MAIN_WINDOW_VIEW_KEY)).toBe("local")
  })
})

describe("StartHome", () => {
  it("lists the saved connections and opens one in its own window", async () => {
    wrap(<StartHome onOpenLocal={() => {}} />)
    expect(await screen.findByText("james @ Cowork")).toBeInTheDocument()
    expect(screen.getByText("https://james.work.example")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(remote.open).toHaveBeenCalledWith(3)
  })

  it("offers the local workspace on top", async () => {
    const onOpenLocal = vi.fn()
    wrap(<StartHome onOpenLocal={onOpenLocal} />, "zh-CN")
    expect(
      screen.getByRole("heading", { name: "在这台电脑上工作" })
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "打开本机工作区" })
    )
    expect(onOpenLocal).toHaveBeenCalledTimes(1)
  })

  it("says so when nothing is saved, and reloads when the window comes back", async () => {
    remote.list.mockResolvedValue([])
    wrap(<StartHome />)
    expect(await screen.findByText("No server added yet.")).toBeInTheDocument()
    expect(remote.list).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(remote.list).toHaveBeenCalledTimes(2))
  })

  it("opens the connection manager", async () => {
    wrap(<StartHome />)
    await screen.findByText("james @ Cowork")
    expect(dialog.opened[dialog.opened.length - 1]).toBe(false)
    await userEvent.click(
      screen.getByRole("button", { name: "Add or manage servers" })
    )
    expect(screen.getByTestId("manage-dialog")).toBeInTheDocument()
  })

  it("no longer points at another edition", async () => {
    wrap(<StartHome onOpenLocal={() => {}} />, "zh-CN")
    await screen.findByText("james @ Cowork")
    expect(screen.queryByText(/完整版/)).toBeNull()
    expect(screen.queryByText(/不带自己的 daemon/)).toBeNull()
  })
})
