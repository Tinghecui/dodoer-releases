import { act, cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { RemoteTransportConfig } from "@/lib/transport/types"

const mocks = vi.hoisted(() => ({
  configure: vi.fn<(config: RemoteTransportConfig) => void>(),
  clear: vi.fn(),
  readConnection: vi.fn(),
  tokenUpdated: [] as Array<(connectionId: number) => void>,
  status: vi.fn(),
  transport: { id: "remote-transport" },
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams("remoteConnectionId=17&remoteWindowId=window-instance"),
}))
vi.mock("@/lib/transport", () => ({
  configureRemoteDesktopTransport: mocks.configure,
  clearRemoteDesktopTransport: mocks.clear,
  getTransport: () => mocks.transport,
  isDesktop: () => true,
}))
vi.mock("@/lib/remote-workspace", () => ({
  getRemoteWorkspaceConnection: mocks.readConnection,
  listenRemoteConnectionTokenUpdated: async (
    handler: (connectionId: number) => void
  ) => {
    mocks.tokenUpdated.push(handler)
    return () => {
      mocks.tokenUpdated = mocks.tokenUpdated.filter((h) => h !== handler)
    }
  },
}))
vi.mock("@/stores/backend-scoped-store-reset", () => ({
  resetBackendScopedStores: vi.fn(),
}))
vi.mock("@/components/connection/remote-connection-status", () => ({
  RemoteConnectionStatus: (props: unknown) => {
    mocks.status(props)
    return <div>Remote status</div>
  },
}))

import { RemoteConnectionGate } from "./remote-connection-context"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tokenUpdated = []
  // 上一条没用完的 mockResolvedValueOnce 不留到下一条
  mocks.readConnection.mockReset()
  mocks.readConnection.mockResolvedValue({
    id: 17,
    name: "Remote workspace",
    base_url: "http://remote.test:3210",
    token: "test-token",
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderGate() {
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RemoteConnectionGate>
          <div>Workspace stays open</div>
        </RemoteConnectionGate>
      </NextIntlClientProvider>
    )
  })
  return mocks.configure.mock.calls[mocks.configure.mock.calls.length - 1][0]
}

describe("RemoteConnectionGate failure recovery", () => {
  // A socket that is merely down never reaches the gate: the transport
  // keeps retrying it in its own state, which the status pill shows.
  it("shows credential expiry once the transport reports a refused token", async () => {
    const config = await renderGate()
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument()

    act(() => config.onUnauthorized?.())

    expect(screen.queryByText("Workspace stays open")).not.toBeInTheDocument()
    expect(screen.queryByText("Remote status")).not.toBeInTheDocument()
    expect(screen.getByText(/expired/i)).toBeInTheDocument()
  })

  it("binds recovery to the existing transport instead of reloading the window", async () => {
    await renderGate()
    const props = mocks.status.mock.calls[mocks.status.mock.calls.length - 1][0]
    expect(props.transport).toBe(mocks.transport)
    expect(props).not.toHaveProperty("onReconnect")
    expect(mocks.configure).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Workspace stays open")).toBeInTheDocument()
  })
})

describe("RemoteConnectionGate unreadable keychain", () => {
  it("says the keychain could not be read instead of calling the token expired", async () => {
    mocks.readConnection.mockResolvedValue({
      id: 17,
      name: "Cowork · tester",
      base_url: "http://remote.test:3210",
      token: "",
      token_unreadable: true,
    })
    await act(async () => {
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <RemoteConnectionGate>
            <div>Workspace stays open</div>
          </RemoteConnectionGate>
        </NextIntlClientProvider>
      )
    })

    expect(mocks.configure).not.toHaveBeenCalled()
    expect(screen.queryByText("Workspace stays open")).not.toBeInTheDocument()
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument()
    expect(screen.getByText(/keychain/i)).toHaveTextContent("Cowork · tester")
  })
})

describe("RemoteConnectionGate token updated from the portal", () => {
  const unreadable = {
    id: 17,
    name: "Cowork · tester",
    base_url: "http://remote.test:3210",
    token: "",
    token_unreadable: true,
  }
  const fresh = {
    id: 17,
    name: "Cowork · tester",
    base_url: "http://remote.test:3210",
    token: "fresh-token",
  }

  async function renderPlainGate() {
    await act(async () => {
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <RemoteConnectionGate>
            <div>Workspace stays open</div>
          </RemoteConnectionGate>
        </NextIntlClientProvider>
      )
    })
  }

  async function announce(connectionId: number) {
    await act(async () => {
      for (const handler of mocks.tokenUpdated) handler(connectionId)
    })
  }

  it("reloads the connection and enters the workspace after re-linking", async () => {
    mocks.readConnection
      .mockResolvedValueOnce(unreadable)
      .mockResolvedValueOnce(fresh)
    await renderPlainGate()
    expect(screen.getByText(/keychain/i)).toBeInTheDocument()

    await announce(17)

    expect(mocks.readConnection).toHaveBeenCalledTimes(2)
    expect(mocks.configure).toHaveBeenCalledTimes(1)
    expect(mocks.configure.mock.calls[0][0].token).toBe("fresh-token")
    expect(screen.queryByText(/keychain/i)).not.toBeInTheDocument()
    expect(screen.getByText("Workspace stays open")).toBeInTheDocument()
  })

  it("reloads an expired window too", async () => {
    mocks.readConnection
      .mockResolvedValueOnce({ ...fresh, token: "old-token" })
      .mockResolvedValueOnce(fresh)
    await renderPlainGate()
    act(() => mocks.configure.mock.calls[0][0].onUnauthorized?.())
    expect(screen.getByText(/expired/i)).toBeInTheDocument()

    await announce(17)

    expect(mocks.configure).toHaveBeenCalledTimes(2)
    expect(mocks.configure.mock.calls[1][0].token).toBe("fresh-token")
    expect(screen.getByText("Workspace stays open")).toBeInTheDocument()
  })

  it("ignores another connection's update", async () => {
    mocks.readConnection.mockResolvedValue(unreadable)
    await renderPlainGate()

    await announce(99)

    expect(mocks.readConnection).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/keychain/i)).toBeInTheDocument()
  })

  it("leaves a connected window alone", async () => {
    await renderPlainGate()
    expect(screen.getByText("Workspace stays open")).toBeInTheDocument()

    await announce(17)

    expect(mocks.readConnection).toHaveBeenCalledTimes(1)
    expect(mocks.configure).toHaveBeenCalledTimes(1)
    expect(mocks.clear).toHaveBeenCalledTimes(1)
  })
})
