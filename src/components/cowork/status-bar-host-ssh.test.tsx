import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  HostSshPermission,
  HostSshPermissions,
  HostSshStatus,
} from "@/lib/cowork/host-ssh"

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

function permissions(
  granted: Partial<Record<HostSshPermission, boolean>> = {},
  overrides: Partial<HostSshPermissions> = {}
): HostSshPermissions {
  return {
    applicable: true,
    selfResponsible: true,
    items: [
      {
        permission: "screenRecording",
        granted: granted.screenRecording ?? true,
      },
      { permission: "accessibility", granted: granted.accessibility ?? true },
    ],
    ...overrides,
  }
}

/** What the app answers: the status, and each switch as asked. */
function app(
  initial: HostSshStatus,
  initialPermissions: HostSshPermissions = permissions()
) {
  let current = initial
  let grants = initialPermissions
  let repairError: string | null = null
  env.call.mockImplementation(
    async (
      command: string,
      args?: { lent?: boolean; permission?: HostSshPermission }
    ) => {
      if (command === "host_ssh_status") return current
      if (command === "host_ssh_set_lent") {
        current = status({ lent: !!args?.lent, running: !!args?.lent })
        return current
      }
      if (command === "host_ssh_self_test") {
        return { ok: true, tools: ["git", "node"], detail: null }
      }
      if (command === "host_ssh_permissions") return grants
      if (command === "host_ssh_repair_permission") {
        if (repairError) throw new Error(repairError)
        return grants
      }
      throw new Error(`unexpected ${command}`)
    }
  )
  return {
    set(next: HostSshStatus) {
      current = next
    },
    setPermissions(next: HostSshPermissions) {
      grants = next
    },
    failRepair(message: string) {
      repairError = message
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

const callsOf = (name: string) =>
  env.call.mock.calls.filter(([command]) => command === name)

const permissionRow = (permission: HostSshPermission) =>
  document.querySelector(`[data-host-ssh-permission="${permission}"]`)

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
  describe("macOS permissions", () => {
    it("says which are in force while lent, and offers to fix the rest", async () => {
      app(
        status({ lent: true, running: true }),
        permissions({ screenRecording: false })
      )
      mount()
      fireEvent.click(await trigger())
      await waitFor(() =>
        expect(permissionRow("screenRecording")).not.toBeNull()
      )
      expect(permissionRow("screenRecording")).toHaveAttribute(
        "data-granted",
        "false"
      )
      expect(permissionRow("screenRecording")).toHaveTextContent(
        "Not granted or stale"
      )
      expect(permissionRow("accessibility")).toHaveAttribute(
        "data-granted",
        "true"
      )
      expect(permissionRow("accessibility")).toHaveTextContent("Granted")
      // One Fix, for the one not in force.
      expect(screen.getAllByRole("button", { name: "Fix" })).toHaveLength(1)
    })

    it("fixes one only when asked, then says what to do next", async () => {
      app(
        status({ lent: true, running: true }),
        permissions({ screenRecording: false })
      )
      mount()
      fireEvent.click(await trigger())
      const fix = await screen.findByRole("button", { name: "Fix" })
      expect(callsOf("host_ssh_repair_permission")).toEqual([])
      fireEvent.click(fix)
      await waitFor(() =>
        expect(callsOf("host_ssh_repair_permission")).toEqual([
          ["host_ssh_repair_permission", { permission: "screenRecording" }],
        ])
      )
      await waitFor(() =>
        expect(
          document.querySelector("[data-host-ssh-permission-asked]")
        ).not.toBeNull()
      )
    })

    it("says why a fix did not go through", async () => {
      const answers = app(
        status({ lent: true, running: true }),
        permissions({ accessibility: false })
      )
      answers.failRepair("tccutil failed: no such service")
      mount()
      fireEvent.click(await trigger())
      fireEvent.click(await screen.findByRole("button", { name: "Fix" }))
      expect(
        await screen.findByText("Couldn't fix: tccutil failed: no such service")
      ).toBeInTheDocument()
    })

    it("asks again when the window comes back to the front", async () => {
      const answers = app(
        status({ lent: true, running: true }),
        permissions({ screenRecording: false })
      )
      mount()
      fireEvent.click(await trigger())
      await screen.findByRole("button", { name: "Fix" })
      answers.setPermissions(permissions())
      act(() => {
        window.dispatchEvent(new Event("focus"))
      })
      await waitFor(() =>
        expect(permissionRow("screenRecording")).toHaveAttribute(
          "data-granted",
          "true"
        )
      )
      expect(screen.queryByRole("button", { name: "Fix" })).toBeNull()
    })

    it("offers no fix for permissions that are another app's", async () => {
      app(
        status({ lent: true, running: true }),
        permissions({ screenRecording: false }, { selfResponsible: false })
      )
      mount()
      fireEvent.click(await trigger())
      await waitFor(() =>
        expect(permissionRow("screenRecording")).not.toBeNull()
      )
      expect(screen.queryByRole("button", { name: "Fix" })).toBeNull()
      expect(screen.getByText(/started from another app/)).toBeInTheDocument()
    })

    it("is not asked about while not lent, nor shown where there are none", async () => {
      app(status(), permissions({ screenRecording: false }))
      mount()
      fireEvent.click(await trigger())
      await screen.findByRole("button", { name: "Lend this computer" })
      expect(callsOf("host_ssh_permissions")).toEqual([])
      expect(document.querySelector("[data-host-ssh-permissions]")).toBeNull()
    })

    it("shows nothing on a system without such permissions", async () => {
      app(
        status({ lent: true, running: true }),
        permissions({}, { applicable: false, items: [] })
      )
      mount()
      fireEvent.click(await trigger())
      await waitFor(() =>
        expect(callsOf("host_ssh_permissions")).not.toEqual([])
      )
      expect(document.querySelector("[data-host-ssh-permissions]")).toBeNull()
    })
  })
})
