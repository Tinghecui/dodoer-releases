import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest"

const mocks = vi.hoisted(() => ({
  isDesktop: vi.fn(() => false),
  tauriClose: vi.fn(async () => {}),
  toastSuccess: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("folderId=1"),
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({}),
  isDesktop: mocks.isDesktop,
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: mocks.tauriClose }),
}))
vi.mock("@/lib/api", () => ({
  getFolder: async () => ({
    id: 1,
    name: "repo",
    path: "/repo",
    parent_id: null,
  }),
}))
vi.mock("@/contexts/remote-connection-context", () => ({
  RemoteConnectionGate: ({ children }: { children: React.ReactNode }) =>
    children,
}))
vi.mock("@/components/layout/app-title-bar", () => ({
  AppTitleBar: () => null,
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }))
vi.mock("@/components/layout/push-workspace", () => ({
  PushWorkspace: ({ onPushed }: { onPushed: () => void }) => (
    <button onClick={onPushed}>push</button>
  ),
}))

import PushPage from "./page"
import enMessages from "@/i18n/messages/en.json"

let close: MockInstance<() => void>

beforeEach(() => {
  mocks.isDesktop.mockReturnValue(false)
  mocks.tauriClose.mockClear()
  mocks.toastSuccess.mockClear()
})
afterEach(() => {
  close.mockRestore()
  Reflect.deleteProperty(window, "closed")
})

const renderPage = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PushPage />
    </NextIntlClientProvider>
  )

describe("push page", () => {
  it("closes its browser window after a push", async () => {
    let closed = false
    close = vi.spyOn(window, "close").mockImplementation(() => {
      closed = true
    })
    // jsdom has no `window.closed`; a browser sets it as the close begins.
    Object.defineProperty(window, "closed", {
      configurable: true,
      get: () => closed,
    })
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: "push" }))
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(mocks.tauriClose).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it("confirms the push in a tab that won't close", async () => {
    close = vi.spyOn(window, "close").mockImplementation(() => {})
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: "push" }))
    await vi.waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Push successful")
    )
  })
})
