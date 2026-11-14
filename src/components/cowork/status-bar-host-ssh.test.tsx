import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { HostSshStatus } from "@/lib/cowork/host-ssh"

const env = vi.hoisted(() => ({
  call: vi.fn(),
  desktop: true,
  remote: true,
  connectionId: 3 as number | null,
  handlers: new Map<string, () => void>(),
  serverInfo: null as ((info: { features: string[] }) => void) | null,
}))
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({
    call: env.call,
    subscribe: (event: string, handler: () => void) => {
      env.handlers.set(event, handler)
      return Promise.resolve(() => env.handlers.delete(event))
    },
  }),
  getTransport: () => ({
    onServerInfo: (callback: (info: { features: string[] }) => void) => {
      env.serverInfo = callback
      return () => {
        env.serverInfo = null
      }
    },
  }),
  isDesktop: () => env.desktop,
  isRemoteDesktopMode: () => env.remote,
  getActiveRemoteConnectionId: () => env.connectionId,
}))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => ({ connection: { name: "Team server" } }),
}))

import { StatusBarHostSsh } from "./status-bar-host-ssh"

function status(overrides: Partial<HostSshStatus> = {}): HostSshStatus {
  return {
    supported: true,
    lent: false,
    running: false,
    error: null,
    ...overrides,
  }
}

/** What the app answers: the status, and each switch as asked. */
function app(initial: HostSshStatus) {
  let current = initial
  env.call.mockImplementation(
    async (command: string, args?: { lent?: boolean }) => {
      if (command === "host_ssh_status") return current
      if (command === "host_ssh_set_lent") {
        current = status({ lent: !!args?.lent, running: !!args?.lent })
        return current
      }
      if (command === "host_ssh_self_test") {
        return { ok: true, tools: ["git", "node"], detail: null }
      }
      throw new Error(`unexpected ${command}`)
    }
  )
  return {
    set(next: HostSshStatus) {
      current = next
    },
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <StatusBarHostSsh />
    </NextIntlClientProvider>
  )
}

const trigger = () =>
  screen.findByRole("button", { name: "Lend this computer to agents" })

const setLentCalls = () =>
  env.call.mock.calls.filter(([command]) => command === "host_ssh_set_lent")

beforeEach(() => {
  env.call.mockReset()
  env.handlers.clear()
  env.serverInfo = null
  env.desktop = true
  env.remote = true
  env.connectionId = 3
})

describe("StatusBarHostSsh", () => {
  it("is not there in a local window, and asks nothing", () => {
    env.remote = false
    app(status())
    const { container } = mount()
    expect(container).toBeEmptyDOMElement()
    expect(env.call).not.toHaveBeenCalled()
  })

  it("is not there on a system that cannot lend", async () => {
    app(status({ supported: false }))
    const { container } = mount()
    await waitFor(() =>
      expect(env.call).toHaveBeenCalledWith("host_ssh_status", {
        connectionId: 3,
      })
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("lends only after the person confirms, and says who to", async () => {
    app(status())
    mount()
    const button = await trigger()
    expect(button).toHaveAttribute("data-host-ssh-lent", "false")

    fireEvent.click(button)
    fireEvent.click(
      await screen.findByRole("button", { name: "Lend this computer" })
    )
    // Nothing is lent by the click that only opened the question.
    expect(
      await screen.findByText("Lend this computer to Team server?")
    ).toBeInTheDocument()
    expect(setLentCalls()).toEqual([])

    fireEvent.click(screen.getByRole("button", { name: "Lend" }))
    await waitFor(() =>
      expect(setLentCalls()).toEqual([
        ["host_ssh_set_lent", { connectionId: 3, lent: true }],
      ])
    )
    await waitFor(() =>
      expect(button).toHaveAttribute("data-host-ssh-lent", "true")
    )
  })

  it("lends nothing when the person says no", async () => {
    app(status())
    mount()
    fireEvent.click(await trigger())
    fireEvent.click(
      await screen.findByRole("button", { name: "Lend this computer" })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(
        screen.queryByText("Lend this computer to Team server?")
      ).not.toBeInTheDocument()
    )
    expect(setLentCalls()).toEqual([])
  })

  it("stops lending at once, without asking", async () => {
    app(status({ lent: true, running: true }))
    mount()
    const button = await trigger()
    expect(button).toHaveAttribute("data-host-ssh-lent", "true")
    fireEvent.click(button)
    fireEvent.click(await screen.findByRole("button", { name: "Stop lending" }))
    await waitFor(() =>
      expect(setLentCalls()).toEqual([
        ["host_ssh_set_lent", { connectionId: 3, lent: false }],
      ])
    )
    await waitFor(() =>
      expect(button).toHaveAttribute("data-host-ssh-lent", "false")
    )
  })

  it("runs the self-test and says what it found", async () => {
    app(status({ lent: true, running: true }))
    mount()
    fireEvent.click(await trigger())
    fireEvent.click(await screen.findByRole("button", { name: "Self-test" }))
    expect(
      await screen.findByText(
        "Self-test passed: it logged in and ran a command. Tools it finds: git, node"
      )
    ).toBeInTheDocument()
  })

  it("offers no self-test while the service is not up, and says why", async () => {
    app(status({ lent: true, running: false, error: "sshd exited at once" }))
    mount()
    fireEvent.click(await trigger())
    expect(
      await screen.findByText(
        "The SSH service did not start: sshd exited at once"
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Self-test" })
    ).not.toBeInTheDocument()
  })

  it("says so while the server cannot reach a lent computer yet", async () => {
    app(status())
    mount()
    fireEvent.click(await trigger())
    await screen.findByRole("button", { name: "Lend this computer" })
    const note = () =>
      document.querySelector("[data-host-ssh-server-not-ready]")
    expect(note()).not.toBeNull()

    act(() => env.serverInfo?.({ features: ["host_bridge_ws", "host_ssh"] }))
    await waitFor(() => expect(note()).toBeNull())
  })

  it("follows a change made elsewhere", async () => {
    const answers = app(status())
    mount()
    const button = await trigger()
    await waitFor(() =>
      expect(env.handlers.has("host-ssh://changed")).toBe(true)
    )
    answers.set(status({ lent: true, running: true }))
    act(() => env.handlers.get("host-ssh://changed")?.())
    await waitFor(() =>
      expect(button).toHaveAttribute("data-host-ssh-lent", "true")
    )
  })
})
